//! Health, stats, tags and auth endpoints.

use std::time::Duration;

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::{self, MaybeAdmin};
use crate::error::{AppError, AppResult};
use crate::extract::AppJson;
use crate::models::{Stats, TagCount, today_start_rfc3339};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/stats", get(stats))
        .route("/tags", get(tags))
        .route("/auth/login", post(login))
        .route("/auth/me", get(me))
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

async fn stats(State(state): State<AppState>) -> AppResult<Json<Stats>> {
    let (recipes, cocktails, dishes, favorites, own, imported): (i64, i64, i64, i64, i64, i64) =
        sqlx::query_as(
            "SELECT COUNT(*),
                    COALESCE(SUM(kind = 'cocktail'), 0),
                    COALESCE(SUM(kind = 'dish'), 0),
                    COALESCE(SUM(favorite = 1), 0),
                    COALESCE(SUM(source = 'own'), 0),
                    COALESCE(SUM(source <> 'own'), 0)
             FROM recipes",
        )
        .fetch_one(&state.db)
        .await?;
    let orders_today: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM orders WHERE created_at >= ?")
        .bind(today_start_rfc3339())
        .fetch_one(&state.db)
        .await?;
    Ok(Json(Stats {
        recipes,
        cocktails,
        dishes,
        favorites,
        own,
        imported,
        orders_today,
    }))
}

async fn tags(State(state): State<AppState>) -> AppResult<Json<Vec<TagCount>>> {
    let tags = sqlx::query_as(
        "SELECT tag, COUNT(*) AS count FROM recipe_tags GROUP BY tag ORDER BY count DESC, tag ASC",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(tags))
}

#[derive(Debug, Deserialize)]
struct LoginInput {
    password: String,
}

/// Time a failed login holds the login gate. Attempts are serialised through
/// the gate, so password guessing is capped at ~2/s in total — no per-IP state,
/// which would be unreliable behind Docker NAT or a reverse proxy anyway.
const FAILED_LOGIN_DELAY: Duration = Duration::from_millis(500);

async fn login(
    State(state): State<AppState>,
    AppJson(input): AppJson<LoginInput>,
) -> AppResult<Json<Value>> {
    let _gate = state.login_gate.lock().await;
    if auth::password_matches(&state.admin_token, &input.password) {
        Ok(Json(json!({ "token": state.admin_token.as_ref() })))
    } else {
        tracing::warn!("failed admin login attempt");
        tokio::time::sleep(FAILED_LOGIN_DELAY).await;
        Err(AppError::WrongPassword)
    }
}

async fn me(MaybeAdmin(admin): MaybeAdmin) -> Json<Value> {
    Json(json!({ "admin": admin }))
}
