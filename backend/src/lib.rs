//! HomeBar backend: a small recipe / home-bar site served by axum over SQLite.

pub mod auth;
pub mod catalog;
pub mod config;
pub mod db;
pub mod error;
pub mod external;
pub mod extract;
pub mod library;
pub mod models;
pub mod pantry;
pub mod repo;
pub mod routes;
pub mod seed;
pub mod state;

use std::convert::Infallible;
use std::path::Path;

use axum::Router;
use axum::extract::Request;
use axum::http::{HeaderValue, header};
use axum::middleware::{self, Next};
use axum::response::Response;
use tower::{Service, ServiceBuilder};
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

use crate::error::AppError;
pub use crate::state::AppState;

const IMMUTABLE: &str = "public, max-age=31536000, immutable";

/// Builds the full application router: `/api`, `/uploads` and the SPA.
pub fn build_app(state: AppState) -> Router {
    let uploads = ServiceBuilder::new()
        .layer(middleware::from_fn(upload_cache_headers))
        .service(ServeDir::new(state.config.uploads_dir()));

    let mut app = Router::new()
        .nest("/api", routes::api_router(state.clone()))
        .nest_service("/uploads", uploads);

    app = match spa_service(&state.config.static_dir) {
        Some(spa) => app.fallback_service(spa),
        None => app.fallback(|| async { AppError::not_found("not found") }),
    };

    // No CORS layer: the SPA is served from the same origin (and the Vite dev
    // server proxies /api), so cross-origin browser access is not needed.
    app.layer(CompressionLayer::new())
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Uploaded files have unique names and never change, so successful responses
/// are cached forever; a 404 must not be (the file may appear later).
async fn upload_cache_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    if res.status().is_success() || res.status() == axum::http::StatusCode::NOT_MODIFIED {
        res.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(IMMUTABLE));
    }
    res
}

/// Static frontend with SPA fallback to `index.html`, or `None` if the
/// directory (or its index.html) is missing.
fn spa_service(
    static_dir: &Path,
) -> Option<
    impl Service<Request, Response = Response, Error = Infallible, Future: Send>
    + Clone
    + Send
    + Sync
    + 'static,
> {
    let index = static_dir.join("index.html");
    if !index.is_file() {
        tracing::warn!(dir = %static_dir.display(), "static dir has no index.html; serving API only");
        return None;
    }
    let serve = ServeDir::new(static_dir)
        .append_index_html_on_directories(true)
        .precompressed_br()
        .precompressed_gzip()
        .fallback(ServeFile::new(index));
    Some(
        ServiceBuilder::new()
            .layer(middleware::from_fn(static_cache_headers))
            .service(serve),
    )
}

/// Hashed `/assets/*` files are cached forever; everything else (index.html,
/// SPA routes, favicon, ...) must be revalidated.
async fn static_cache_headers(req: Request, next: Next) -> Response {
    let is_asset = req.uri().path().starts_with("/assets/");
    let mut res = next.run(req).await;
    // A missing asset falls back to index.html, which must never be cached forever.
    let is_html = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("text/html"));
    let immutable = is_asset && !is_html;
    if res.status().is_success() || res.status() == axum::http::StatusCode::NOT_MODIFIED {
        let value = if immutable { IMMUTABLE } else { "no-cache" };
        res.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    }
    res
}
