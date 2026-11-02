//! `/api/recipes` — CRUD, favorites, forks and version history.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{AppendHeaders, IntoResponse};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;

use crate::auth::Admin;
use crate::error::{AppError, AppResult};
use crate::extract::{AppJson, AppPath, AppQuery};
use crate::models::{
    Kind, MAX_TITLE, Recipe, RecipeData, RecipeInput, RecipeSummary, RecipeVersion,
    RecipeVersionSummary, Source, normalize_tags, validate_title,
};
use crate::repo::{self, Origin, RecipeFilter};
use crate::routes::pantry::{TOTAL_COUNT, int_param};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/recipes", get(list).post(create))
        .route("/recipes/{id}", get(fetch).put(update).delete(remove))
        .route("/recipes/{id}/favorite", put(set_favorite))
        .route("/recipes/{id}/fork", post(fork))
        .route("/recipes/{id}/versions", get(versions))
        .route("/recipes/{id}/versions/{vid}", get(version))
        .route("/recipes/{id}/versions/{vid}/restore", post(restore))
}

/// Query parameters; empty strings are treated as absent.
#[derive(Debug, Default, Deserialize)]
pub struct ListQuery {
    q: Option<String>,
    kind: Option<String>,
    favorite: Option<String>,
    source: Option<String>,
    tag: Option<String>,
    limit: Option<String>,
    offset: Option<String>,
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
}

impl ListQuery {
    fn into_filter(self) -> AppResult<RecipeFilter> {
        let kind = non_empty(self.kind)
            .map(|k| {
                Kind::parse(&k)
                    .ok_or_else(|| AppError::bad_request(format!("unknown kind \"{k}\"")))
            })
            .transpose()?;
        let favorite_only = non_empty(self.favorite)
            .is_some_and(|f| matches!(f.to_ascii_lowercase().as_str(), "true" | "1" | "yes"));
        let source = non_empty(self.source)
            .map(|s| {
                let s = s.to_ascii_lowercase();
                if s == "imported" || Source::parse(&s).is_some() {
                    Ok(s)
                } else {
                    Err(AppError::bad_request(format!("unknown source \"{s}\"")))
                }
            })
            .transpose()?;
        let tag = non_empty(self.tag).and_then(|t| normalize_tags([t]).into_iter().next());
        Ok(RecipeFilter {
            q: non_empty(self.q),
            kind,
            favorite_only,
            source,
            tag,
            ids: None,
        })
    }
}

/// Without `limit` everything is returned (v1 behaviour); `X-Total-Count`
/// always carries the number of matches before pagination.
async fn list(
    State(state): State<AppState>,
    AppQuery(mut query): AppQuery<ListQuery>,
) -> AppResult<impl IntoResponse> {
    let limit = int_param("limit", query.limit.take(), 1, 200)?;
    let offset = int_param("offset", query.offset.take(), 0, i64::MAX)?.unwrap_or(0) as usize;
    let filter = query.into_filter()?;
    let mut conn = state.db.acquire().await?;
    // The cached index is already in list order (favorites, then updated_at desc).
    let index = state.recipe_index.get(&mut conn).await?;
    drop(conn);
    let matching = index
        .iter()
        .map(|s| &s.summary)
        .filter(|s| filter.matches(s));
    let total = matching.clone().count();
    let page: Vec<RecipeSummary> = matching
        .skip(offset)
        .take(limit.map_or(usize::MAX, |l| l as usize))
        .cloned()
        .collect();
    Ok((
        AppendHeaders([(TOTAL_COUNT, total.to_string())]),
        Json(page),
    ))
}

async fn fetch(
    State(state): State<AppState>,
    AppPath(id): AppPath<i64>,
) -> AppResult<Json<Recipe>> {
    let mut conn = state.db.acquire().await?;
    Ok(Json(repo::load_recipe(&mut conn, id).await?))
}

async fn create(
    _: Admin,
    State(state): State<AppState>,
    AppJson(input): AppJson<RecipeInput>,
) -> AppResult<(StatusCode, Json<Recipe>)> {
    let (data, _) = input.validate()?;
    let mut tx = crate::db::begin_write(&state.db).await?;
    let id = repo::insert_recipe(&mut tx, &data, &Origin::default()).await?;
    let recipe = repo::load_recipe(&mut tx, id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(recipe)))
}

async fn update(
    _: Admin,
    State(state): State<AppState>,
    AppPath(id): AppPath<i64>,
    AppJson(input): AppJson<RecipeInput>,
) -> AppResult<Json<Recipe>> {
    let (data, note) = input.validate()?;
    let mut tx = crate::db::begin_write(&state.db).await?;
    let current = repo::load_recipe(&mut tx, id).await?;
    repo::snapshot_version(&mut tx, &current, &note).await?;
    repo::update_recipe(&mut tx, id, &data).await?;
    let recipe = repo::load_recipe(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(recipe))
}

async fn remove(
    _: Admin,
    State(state): State<AppState>,
    AppPath(id): AppPath<i64>,
) -> AppResult<StatusCode> {
    let result = sqlx::query("DELETE FROM recipes WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found(format!("recipe {id} not found")));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct FavoriteInput {
    favorite: bool,
}

async fn set_favorite(
    _: Admin,
    State(state): State<AppState>,
    AppPath(id): AppPath<i64>,
    AppJson(input): AppJson<FavoriteInput>,
) -> AppResult<Json<Recipe>> {
    let mut conn = state.db.acquire().await?;
    repo::set_favorite(&mut conn, id, input.favorite).await?;
    Ok(Json(repo::load_recipe(&mut conn, id).await?))
}

#[derive(Debug, Default, Deserialize)]
struct ForkInput {
    #[serde(default)]
    title: Option<String>,
}

/// Body is optional (`{}` or nothing at all).
async fn fork(
    _: Admin,
    State(state): State<AppState>,
    AppPath(id): AppPath<i64>,
    body: Bytes,
) -> AppResult<(StatusCode, Json<Recipe>)> {
    let input: ForkInput = if body.iter().all(u8::is_ascii_whitespace) {
        ForkInput::default()
    } else {
        serde_json::from_slice(&body)
            .map_err(|e| AppError::bad_request(format!("invalid JSON body: {e}")))?
    };
    let mut tx = crate::db::begin_write(&state.db).await?;
    let original = repo::load_recipe(&mut tx, id).await?;
    let title = match input.title.filter(|t| !t.trim().is_empty()) {
        Some(t) => validate_title(&t)?,
        None => format!("{} (вариация)", original.title)
            .chars()
            .take(MAX_TITLE)
            .collect(),
    };
    let data = RecipeData {
        title,
        favorite: Some(false),
        ..RecipeData::from_recipe(&original)
    };
    let origin = Origin {
        parent_id: Some(id),
        ..Origin::default()
    };
    let new_id = repo::insert_recipe(&mut tx, &data, &origin).await?;
    let recipe = repo::load_recipe(&mut tx, new_id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(recipe)))
}

async fn versions(
    State(state): State<AppState>,
    AppPath(id): AppPath<i64>,
) -> AppResult<Json<Vec<RecipeVersionSummary>>> {
    let mut conn = state.db.acquire().await?;
    if !repo::recipe_exists(&mut conn, id).await? {
        return Err(AppError::not_found(format!("recipe {id} not found")));
    }
    Ok(Json(repo::list_versions(&mut conn, id).await?))
}

async fn version(
    State(state): State<AppState>,
    AppPath((id, vid)): AppPath<(i64, i64)>,
) -> AppResult<Json<RecipeVersion>> {
    let mut conn = state.db.acquire().await?;
    let (summary, recipe) = repo::load_version(&mut conn, id, vid).await?;
    Ok(Json(RecipeVersion { summary, recipe }))
}

async fn restore(
    _: Admin,
    State(state): State<AppState>,
    AppPath((id, vid)): AppPath<(i64, i64)>,
) -> AppResult<Json<Recipe>> {
    let mut tx = crate::db::begin_write(&state.db).await?;
    let (_, snapshot) = repo::load_version(&mut tx, id, vid).await?;
    let current = repo::load_recipe(&mut tx, id).await?;
    repo::snapshot_version(&mut tx, &current, "before restore").await?;
    // Favorite is a flag, not content: restoring keeps the current value.
    let data = RecipeData {
        favorite: None,
        ..RecipeData::from_recipe(&snapshot)
    };
    repo::update_recipe(&mut tx, id, &data).await?;
    let recipe = repo::load_recipe(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(recipe))
}
