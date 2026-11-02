//! v2: ingredient catalog autocomplete, pantry, availability ranking,
//! pantry suggestions and guest settings.

use std::collections::HashMap;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{AppendHeaders, IntoResponse};
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::Deserialize;

use crate::auth::Admin;
use crate::catalog::{Category, catalog, normalize};
use crate::error::{AppError, AppResult};
use crate::extract::{AppJson, AppPath, AppQuery};
use crate::models::{
    Availability, CatalogIngredient, Kind, MissingIngredient, PantryItem, PantrySuggestion,
    RecipeSummary, Settings, Source, normalize_tags, now_rfc3339,
};
use crate::pantry::{self, Pantry};
use crate::repo::{self, SummaryWithKeys};
use crate::state::AppState;

const MAX_PANTRY_NAMES: usize = 100;
const MAX_PANTRY_NAME_LEN: usize = 80;
const MAX_QUERY_LEN: usize = 100;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/ingredients", get(ingredients))
        .route("/pantry", get(list).post(add).delete(clear))
        .route("/pantry/suggestions", get(suggestions))
        .route("/pantry/{key}", delete(remove))
        .route("/available", get(available))
        .route("/settings", get(get_settings).put(put_settings))
}

/// Header carrying the total number of matches for paginated lists.
pub const TOTAL_COUNT: &str = "x-total-count";

fn non_empty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
}

/// Parses an optional integer query parameter within `min..=max`.
pub fn int_param(name: &str, v: Option<String>, min: i64, max: i64) -> AppResult<Option<i64>> {
    non_empty(v)
        .map(|s| {
            s.parse::<i64>()
                .ok()
                .filter(|n| (min..=max).contains(n))
                .ok_or_else(|| {
                    AppError::bad_request(format!(
                        "{name} must be an integer between {min} and {max}"
                    ))
                })
        })
        .transpose()
}

fn kind_param(v: Option<String>) -> AppResult<Option<Kind>> {
    non_empty(v)
        .map(|k| {
            Kind::parse(&k).ok_or_else(|| AppError::bad_request(format!("unknown kind \"{k}\"")))
        })
        .transpose()
}

fn query_param(v: Option<String>) -> AppResult<Option<String>> {
    let q = non_empty(v);
    if q.as_ref()
        .is_some_and(|q| q.chars().count() > MAX_QUERY_LEN)
    {
        return Err(AppError::bad_request("q is too long"));
    }
    Ok(q)
}

// ---------------------------------------------------------------------------
// Catalog autocomplete
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct IngredientsQuery {
    q: Option<String>,
    limit: Option<String>,
}

/// Match quality of `q` against a list of normalised terms: 3 exact, 2 prefix
/// (of the term or of one of its words), 1 substring, 0 none.
fn match_score(terms: &[String], q: &str) -> u8 {
    let mut best = 0;
    for t in terms {
        let score = if t == q {
            3
        } else if t.starts_with(q) || t.split(' ').any(|w| w.starts_with(q)) {
            2
        } else if t.contains(q) {
            1
        } else {
            0
        };
        best = best.max(score);
        if best == 3 {
            break;
        }
    }
    best
}

async fn ingredients(
    State(state): State<AppState>,
    AppQuery(query): AppQuery<IngredientsQuery>,
) -> AppResult<Json<Vec<CatalogIngredient>>> {
    let limit = int_param("limit", query.limit, 1, 100)?.unwrap_or(20) as usize;
    let q = query_param(query.q)?
        .map(|q| normalize(&q))
        .filter(|q| !q.is_empty());
    let mut conn = state.db.acquire().await?;
    let usage = pantry::key_usage(&mut conn).await?;
    let have = Pantry::load(&mut conn).await?;
    drop(conn);

    let cat = catalog();
    // (score, item)
    let mut scored: Vec<(u8, CatalogIngredient)> = Vec::new();
    let mut push = |score: u8, key: &str, name: &str, name_en: &str, category: Category| {
        let recipe_count = usage.get(key).map_or(0, |(c, _)| *c);
        scored.push((
            score,
            CatalogIngredient {
                key: key.to_owned(),
                name: name.to_owned(),
                name_en: name_en.to_owned(),
                category,
                in_pantry: have.satisfies(key),
                recipe_count,
            },
        ));
    };
    for e in cat.entries() {
        let score = match &q {
            Some(q) => match_score(&e.terms, q),
            None => 1,
        };
        if score > 0 {
            push(score, &e.key, e.display_name(), &e.name_en, e.category);
        }
    }
    // Custom keys used by local recipes.
    for (key, (_, sample)) in usage.iter().filter(|(k, _)| !cat.contains(k)) {
        let score = match &q {
            Some(q) => match_score(&[key.clone(), normalize(sample)], q),
            None => 1,
        };
        if score > 0 {
            push(score, key, sample, sample, Category::Other);
        }
    }
    scored.sort_by(|(sa, a), (sb, b)| {
        sb.cmp(sa)
            .then(b.recipe_count.cmp(&a.recipe_count))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.key.cmp(&b.key))
    });
    Ok(Json(
        scored.into_iter().take(limit).map(|(_, i)| i).collect(),
    ))
}

// ---------------------------------------------------------------------------
// Pantry
// ---------------------------------------------------------------------------

async fn list(State(state): State<AppState>) -> AppResult<Json<Vec<PantryItem>>> {
    let mut conn = state.db.acquire().await?;
    Ok(Json(pantry::list_items(&mut conn).await?))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AddInput {
    names: Vec<String>,
}

async fn add(
    _: Admin,
    State(state): State<AppState>,
    AppJson(input): AppJson<AddInput>,
) -> AppResult<Json<Vec<PantryItem>>> {
    if input.names.is_empty() || input.names.len() > MAX_PANTRY_NAMES {
        return Err(AppError::bad_request(format!(
            "names must contain 1 to {MAX_PANTRY_NAMES} entries"
        )));
    }
    let cat = catalog();
    let mut resolved: Vec<(String, String)> = Vec::with_capacity(input.names.len());
    for raw in &input.names {
        let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        let len = name.chars().count();
        if len == 0 || len > MAX_PANTRY_NAME_LEN {
            return Err(AppError::bad_request(format!(
                "each name must be 1 to {MAX_PANTRY_NAME_LEN} characters"
            )));
        }
        let key = cat.resolve(&name);
        if key.is_empty() {
            return Err(AppError::bad_request(format!(
                "\"{name}\" is not a valid name"
            )));
        }
        resolved.push((key, name));
    }
    let now = now_rfc3339();
    let mut tx = crate::db::begin_write(&state.db).await?;
    for (key, name) in &resolved {
        sqlx::query("INSERT OR IGNORE INTO pantry (key, name, added_at) VALUES (?, ?, ?)")
            .bind(key)
            .bind(name)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
    }
    let items = pantry::list_items(&mut tx).await?;
    tx.commit().await?;
    Ok(Json(items))
}

/// Idempotent: removing a key that is not in the pantry is still 204. The key
/// may also be given as any name that resolves to it ("Лайм" → "lime").
async fn remove(
    _: Admin,
    State(state): State<AppState>,
    AppPath(key): AppPath<String>,
) -> AppResult<StatusCode> {
    let resolved = catalog().resolve(&key);
    sqlx::query("DELETE FROM pantry WHERE key IN (?, ?)")
        .bind(&key)
        .bind(&resolved)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn clear(_: Admin, State(state): State<AppState>) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM pantry").execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct SuggestionsQuery {
    kind: Option<String>,
    limit: Option<String>,
}

async fn suggestions(
    State(state): State<AppState>,
    AppQuery(query): AppQuery<SuggestionsQuery>,
) -> AppResult<Json<Vec<PantrySuggestion>>> {
    let kind = kind_param(query.kind)?;
    let limit = int_param("limit", query.limit, 1, 100)?.unwrap_or(12) as usize;
    let mut conn = state.db.acquire().await?;
    let have = Pantry::load(&mut conn).await?;
    let recipes = state.recipe_index.get(&mut conn).await?;
    drop(conn);

    let mut unlocks: HashMap<String, (usize, String)> = HashMap::new();
    for r in recipes
        .iter()
        .filter(|r| kind.is_none_or(|k| r.summary.kind == k))
    {
        let (_, missing) = pantry::evaluate(&have, r);
        if let Some(m) = pantry::unlocking_key(&missing) {
            unlocks
                .entry(m.key.clone())
                .or_insert_with(|| (0, m.name.clone()))
                .0 += 1;
        }
    }
    let cat = catalog();
    let mut out: Vec<PantrySuggestion> = unlocks
        .into_iter()
        .map(|(key, (count, name))| PantrySuggestion {
            category: cat.get(&key).map_or(Category::Other, |e| e.category),
            name,
            key,
            unlocks: count,
        })
        .collect();
    out.sort_by(|a, b| {
        b.unlocks
            .cmp(&a.unlocks)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.key.cmp(&b.key))
    });
    out.truncate(limit);
    Ok(Json(out))
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AvailableQuery {
    kind: Option<String>,
    max_missing: Option<String>,
    q: Option<String>,
    tag: Option<String>,
    limit: Option<String>,
    offset: Option<String>,
}

/// Ranking key: missing count asc, favorites first, own before imported,
/// title asc (case-insensitive), id.
fn rank_key(s: &RecipeSummary, missing: usize) -> (usize, bool, bool, String, i64) {
    (
        missing,
        !s.favorite,
        s.source != Source::Own,
        s.title.to_lowercase(),
        s.id,
    )
}

/// Ranked availability for the given filters; returns `(total, page)`.
pub async fn compute_available(
    state: &AppState,
    kind: Option<Kind>,
    max_missing: usize,
    q: Option<String>,
    tag: Option<String>,
    limit: usize,
    offset: usize,
) -> AppResult<(usize, Vec<Availability>)> {
    let mut conn = state.db.acquire().await?;
    let have = Pantry::load(&mut conn).await?;
    let recipes = state.recipe_index.get(&mut conn).await?;
    drop(conn);

    let needle = q.map(|q| q.to_lowercase());
    let mut matches: Vec<(_, usize, Vec<MissingIngredient>, &SummaryWithKeys)> = recipes
        .iter()
        .filter(|r| kind.is_none_or(|k| r.summary.kind == k))
        .filter(|r| tag.as_ref().is_none_or(|t| r.summary.tags.contains(t)))
        .filter(|r| {
            needle
                .as_deref()
                .is_none_or(|q| repo::matches_query(&r.summary, q))
        })
        .filter_map(|r| {
            let (total, missing) = pantry::evaluate(&have, r);
            (missing.len() <= max_missing)
                .then(|| (rank_key(&r.summary, missing.len()), total, missing, r))
        })
        .collect();
    let total = matches.len();
    matches.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    let page = matches
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|(_, total, missing, r)| Availability {
            recipe: r.summary.clone(),
            total,
            missing,
        })
        .collect();
    Ok((total, page))
}

async fn available(
    State(state): State<AppState>,
    AppQuery(query): AppQuery<AvailableQuery>,
) -> AppResult<impl IntoResponse> {
    let kind = kind_param(query.kind)?;
    let max_missing = int_param("maxMissing", query.max_missing, 0, 5)?.unwrap_or(0) as usize;
    let q = query_param(query.q)?;
    let tag = non_empty(query.tag).and_then(|t| normalize_tags([t]).into_iter().next());
    let limit = int_param("limit", query.limit, 1, 200)?.unwrap_or(60) as usize;
    let offset = int_param("offset", query.offset, 0, i64::MAX)?.unwrap_or(0) as usize;
    let (total, page) = compute_available(&state, kind, max_missing, q, tag, limit, offset).await?;
    Ok((
        AppendHeaders([(TOTAL_COUNT, total.to_string())]),
        Json(page),
    ))
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async fn get_settings(State(state): State<AppState>) -> AppResult<Json<Settings>> {
    let mut conn = state.db.acquire().await?;
    Ok(Json(pantry::load_settings(&mut conn).await?))
}

async fn put_settings(
    _: Admin,
    State(state): State<AppState>,
    AppJson(input): AppJson<Settings>,
) -> AppResult<Json<Settings>> {
    let s = input.validate()?;
    sqlx::query(
        "INSERT INTO settings (id, guest_max_missing, guest_show_menu) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET guest_max_missing = excluded.guest_max_missing,
             guest_show_menu = excluded.guest_show_menu",
    )
    .bind(s.guest_max_missing)
    .bind(s.guest_show_menu)
    .execute(&state.db)
    .await?;
    Ok(Json(s))
}
