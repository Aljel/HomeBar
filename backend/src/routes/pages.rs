//! `/api/pages` — editable markdown pages (home, about, ...).

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use crate::auth::Admin;
use crate::error::{AppError, AppResult};
use crate::extract::{AppJson, AppPath};
use crate::models::{Page, now_rfc3339, validate_title};
use crate::state::AppState;

const MAX_BODY: usize = 100_000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/pages", get(list))
        .route("/pages/{slug}", get(fetch).put(upsert))
}

/// Slugs are `[a-z0-9-]{1,40}`.
pub fn is_valid_slug(slug: &str) -> bool {
    (1..=40).contains(&slug.len())
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

async fn list(State(state): State<AppState>) -> AppResult<Json<Vec<Page>>> {
    let pages = sqlx::query_as("SELECT slug, title, body, updated_at FROM pages ORDER BY slug")
        .fetch_all(&state.db)
        .await?;
    Ok(Json(pages))
}

async fn fetch(
    State(state): State<AppState>,
    AppPath(slug): AppPath<String>,
) -> AppResult<Json<Page>> {
    let not_found = || AppError::not_found(format!("page \"{slug}\" not found"));
    if !is_valid_slug(&slug) {
        return Err(not_found());
    }
    let page: Option<Page> =
        sqlx::query_as("SELECT slug, title, body, updated_at FROM pages WHERE slug = ?")
            .bind(&slug)
            .fetch_optional(&state.db)
            .await?;
    page.map(Json).ok_or_else(not_found)
}

#[derive(Debug, Deserialize)]
struct PageInput {
    title: String,
    #[serde(default)]
    body: String,
}

async fn upsert(
    _: Admin,
    State(state): State<AppState>,
    AppPath(slug): AppPath<String>,
    AppJson(input): AppJson<PageInput>,
) -> AppResult<Json<Page>> {
    if !is_valid_slug(&slug) {
        return Err(AppError::bad_request("slug must match [a-z0-9-]{1,40}"));
    }
    let title = validate_title(&input.title)?;
    if input.body.chars().count() > MAX_BODY {
        return Err(AppError::bad_request(format!(
            "body must be at most {MAX_BODY} characters"
        )));
    }
    let page: Page = sqlx::query_as(
        "INSERT INTO pages (slug, title, body, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (slug) DO UPDATE SET title = excluded.title, body = excluded.body,
             updated_at = excluded.updated_at
         RETURNING slug, title, body, updated_at",
    )
    .bind(&slug)
    .bind(title)
    .bind(input.body)
    .bind(now_rfc3339())
    .fetch_one(&state.db)
    .await?;
    Ok(Json(page))
}

#[cfg(test)]
mod tests {
    use super::is_valid_slug;

    #[test]
    fn slug_rules() {
        assert!(is_valid_slug("home"));
        assert!(is_valid_slug("about-me-2"));
        assert!(!is_valid_slug(""));
        assert!(!is_valid_slug("Home"));
        assert!(!is_valid_slug("a_b"));
        assert!(!is_valid_slug("../x"));
        assert!(!is_valid_slug(&"a".repeat(41)));
    }
}
