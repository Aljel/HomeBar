//! `/api/discover` — browse and import recipes from TheCocktailDB / TheMealDB.

use std::collections::HashSet;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::future::join_all;
use serde::Deserialize;

use crate::auth::Admin;
use crate::error::{AppError, AppResult};
use crate::external::{ExternalError, Upstream};
use crate::extract::{AppJson, AppQuery};
use crate::models::{Kind, Recipe, Source};
use crate::repo;
use crate::state::AppState;

const MAX_SEARCH_RESULTS: usize = 24;
const MAX_RANDOM: usize = 12;
const DEFAULT_RANDOM: usize = 6;

pub fn router(state: AppState) -> Router<AppState> {
    Router::new()
        .route("/discover/random", get(random))
        .route("/discover/search", get(search))
        .route("/discover/lookup", get(lookup))
        .route("/discover/import", post(import))
        .route_layer(middleware::from_fn_with_state(state, require_enabled))
}

/// Offline mode: every discover endpoint answers 503.
async fn require_enabled(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if state.config.discover_enabled {
        next.run(req).await
    } else {
        axum::response::IntoResponse::into_response(AppError::Unavailable(
            "discover is disabled (offline mode)".into(),
        ))
    }
}

fn upstream_for_kind(kind: Option<&str>) -> AppResult<Upstream> {
    let kind = match kind.map(str::trim).filter(|k| !k.is_empty()) {
        None => Kind::Cocktail,
        Some(k) => {
            Kind::parse(k).ok_or_else(|| AppError::bad_request(format!("unknown kind \"{k}\"")))?
        }
    };
    Upstream::for_kind(kind).ok_or_else(|| AppError::bad_request("kind must be cocktail or dish"))
}

fn upstream_error(err: ExternalError) -> AppError {
    AppError::Upstream(err.to_string())
}

/// Fills `importedId` for results already present locally.
async fn mark_imported(state: &AppState, recipes: &mut [Recipe]) -> AppResult<()> {
    let mut conn = state.db.acquire().await?;
    for r in recipes.iter_mut() {
        if let Some(sid) = r.source_id.as_deref() {
            r.imported_id = repo::find_imported(&mut conn, r.source, sid).await?;
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct RandomQuery {
    kind: Option<String>,
    count: Option<String>,
}

async fn random(
    State(state): State<AppState>,
    AppQuery(q): AppQuery<RandomQuery>,
) -> AppResult<Json<Vec<Recipe>>> {
    let up = upstream_for_kind(q.kind.as_deref())?;
    let count = match q.count.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        None => DEFAULT_RANDOM,
        Some(c) => c
            .parse::<usize>()
            .ok()
            .filter(|n| (1..=MAX_RANDOM).contains(n))
            .ok_or_else(|| AppError::bad_request("count must be between 1 and 12"))?,
    };
    // The random endpoint yields one item per call: over-fetch a little to
    // make up for duplicates.
    let requests = count + (count / 2).max(2);
    let results = join_all((0..requests).map(|_| state.external.random(up))).await;

    let mut seen = HashSet::new();
    let mut recipes = Vec::with_capacity(count);
    let mut last_error = None;
    let mut successes = 0usize;
    for result in results {
        match result {
            Ok(Some(r)) => {
                successes += 1;
                if r.source_id
                    .as_ref()
                    .is_some_and(|id| seen.insert(id.clone()))
                    && recipes.len() < count
                {
                    recipes.push(r);
                }
            }
            Ok(None) => successes += 1,
            Err(e) => {
                tracing::warn!(error = %e, "random upstream request failed");
                last_error = Some(e);
            }
        }
    }
    if successes == 0
        && let Some(e) = last_error
    {
        return Err(upstream_error(e));
    }
    mark_imported(&state, &mut recipes).await?;
    Ok(Json(recipes))
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    q: Option<String>,
    kind: Option<String>,
}

async fn search(
    State(state): State<AppState>,
    AppQuery(q): AppQuery<SearchQuery>,
) -> AppResult<Json<Vec<Recipe>>> {
    let up = upstream_for_kind(q.kind.as_deref())?;
    let term =
        q.q.map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::bad_request("q is required"))?;
    if term.chars().count() > 100 {
        return Err(AppError::bad_request("q is too long"));
    }
    let mut recipes = state
        .external
        .search(up, &term)
        .await
        .map_err(upstream_error)?;
    recipes.truncate(MAX_SEARCH_RESULTS);
    mark_imported(&state, &mut recipes).await?;
    Ok(Json(recipes))
}

fn parse_source_ref(source: &str, source_id: &str) -> AppResult<(Source, Upstream, String)> {
    let source_enum = Source::parse(source.trim())
        .ok_or_else(|| AppError::bad_request(format!("unknown source \"{source}\"")))?;
    let up = Upstream::for_source(source_enum)
        .ok_or_else(|| AppError::bad_request("source must be thecocktaildb or themealdb"))?;
    let id = source_id.trim();
    if id.is_empty() || id.len() > 20 || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::bad_request("sourceId must be a numeric id"));
    }
    Ok((source_enum, up, id.to_owned()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LookupQuery {
    source: Option<String>,
    source_id: Option<String>,
}

async fn lookup(
    State(state): State<AppState>,
    AppQuery(q): AppQuery<LookupQuery>,
) -> AppResult<Json<Recipe>> {
    let (_, up, id) = parse_source_ref(
        q.source.as_deref().unwrap_or_default(),
        q.source_id.as_deref().unwrap_or_default(),
    )?;
    let mut recipe = state
        .external
        .lookup(up, &id)
        .await
        .map_err(upstream_error)?
        .ok_or_else(|| AppError::not_found(format!("{id} not found upstream")))?;
    mark_imported(&state, std::slice::from_mut(&mut recipe)).await?;
    Ok(Json(recipe))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportInput {
    source: String,
    source_id: String,
}

async fn import(
    _: Admin,
    State(state): State<AppState>,
    AppJson(input): AppJson<ImportInput>,
) -> AppResult<(StatusCode, Json<Recipe>)> {
    let (source, up, id) = parse_source_ref(&input.source, &input.source_id)?;

    {
        let mut conn = state.db.acquire().await?;
        if let Some(existing) = repo::find_imported(&mut conn, source, &id).await? {
            return Ok((
                StatusCode::OK,
                Json(repo::load_recipe(&mut conn, existing).await?),
            ));
        }
    }

    let upstream = state
        .external
        .lookup(up, &id)
        .await
        .map_err(upstream_error)?
        .ok_or_else(|| AppError::not_found(format!("{id} not found upstream")))?;

    let mut tx = crate::db::begin_write(&state.db).await?;
    // Re-check inside the transaction to handle concurrent imports.
    if let Some(existing) = repo::find_imported(&mut tx, source, &id).await? {
        let recipe = repo::load_recipe(&mut tx, existing).await?;
        return Ok((StatusCode::OK, Json(recipe)));
    }
    let new_id = repo::insert_imported(&mut tx, &upstream, source, &id).await?;
    let recipe = repo::load_recipe(&mut tx, new_id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(recipe)))
}
