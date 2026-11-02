//! HTTP routes under `/api`.

pub mod discover;
pub mod library;
pub mod menus;
pub mod meta;
pub mod orders;
pub mod pages;
pub mod pantry;
pub mod recipes;
pub mod uploads;

use axum::Router;

use crate::error::AppError;
use crate::state::AppState;

/// All `/api` routes (without the `/api` prefix).
pub fn api_router(state: AppState) -> Router<AppState> {
    Router::new()
        .merge(meta::router())
        .merge(recipes::router())
        .merge(discover::router(state))
        .merge(menus::router())
        .merge(orders::router())
        .merge(pages::router())
        .merge(uploads::router())
        .merge(pantry::router())
        .merge(library::router())
        .fallback(|| async { AppError::not_found("no such API endpoint") })
}
