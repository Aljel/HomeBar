//! `/api/library/sync` — bulk import of the upstream recipe libraries.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use crate::auth::Admin;
use crate::error::{AppError, AppResult};
use crate::extract::AppJson;
use crate::library::LibrarySync;
use crate::models::{LibrarySyncStatus, Source};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/library/sync", get(status).post(start))
}

async fn status(State(state): State<AppState>) -> Json<LibrarySyncStatus> {
    Json(state.library.status())
}

#[derive(Debug, Deserialize)]
struct SyncInput {
    sources: Vec<String>,
}

async fn start(
    _: Admin,
    State(state): State<AppState>,
    AppJson(input): AppJson<SyncInput>,
) -> AppResult<(StatusCode, Json<LibrarySyncStatus>)> {
    if !state.config.discover_enabled {
        return Err(AppError::Unavailable(
            "external sources are disabled (offline mode)".into(),
        ));
    }
    if input.sources.is_empty() {
        return Err(AppError::bad_request("sources must not be empty"));
    }
    let mut sources = Vec::new();
    for s in &input.sources {
        let source = match Source::parse(s.trim()) {
            Some(src @ (Source::Thecocktaildb | Source::Themealdb)) => src,
            _ => {
                return Err(AppError::bad_request(format!(
                    "unknown source \"{s}\" (expected thecocktaildb or themealdb)"
                )));
            }
        };
        if !sources.contains(&source) {
            sources.push(source);
        }
    }
    let status = LibrarySync::start(&state, sources)?;
    Ok((StatusCode::ACCEPTED, Json(status)))
}
