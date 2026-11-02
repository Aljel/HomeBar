//! `/api/orders` — guest orders plus a live SSE feed for the host.

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::http::request::Parts;
use axum::http::{HeaderName, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{Stream, StreamExt};
use serde::Deserialize;
use tokio_stream::wrappers::BroadcastStream;

use crate::auth::{self, Admin};
use crate::error::{AppError, AppResult};
use crate::extract::{AppJson, AppPath, AppQuery};
use crate::models::{Order, OrderStatus, now_rfc3339};
use crate::state::AppState;

const MAX_GUEST_NAME: usize = 60;
const MAX_NOTE: usize = 300;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/orders", get(list).post(create))
        .route("/orders/stream", get(stream))
        .route("/orders/{id}", get(fetch).patch(update_status))
}

const ORDER_SELECT: &str = "SELECT id, menu_id, recipe_id, recipe_title, guest_name, note, status, \
     created_at, updated_at FROM orders";

async fn load_order(state: &AppState, id: i64) -> AppResult<Order> {
    let sql = format!("{ORDER_SELECT} WHERE id = ?");
    sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found(format!("order {id} not found")))
}

fn publish(state: &AppState, order: &Order) {
    // An error only means nobody is listening right now.
    let _ = state.orders_tx.send(order.clone());
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateOrder {
    recipe_id: i64,
    #[serde(default)]
    menu_id: Option<i64>,
    guest_name: String,
    #[serde(default)]
    note: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    AppJson(input): AppJson<CreateOrder>,
) -> AppResult<(StatusCode, Json<Order>)> {
    let guest_name = input.guest_name.trim().to_owned();
    let name_len = guest_name.chars().count();
    if name_len == 0 || name_len > MAX_GUEST_NAME {
        return Err(AppError::bad_request(format!(
            "guestName must be 1..{MAX_GUEST_NAME} characters"
        )));
    }
    let note = input.note.unwrap_or_default().trim().to_owned();
    if note.chars().count() > MAX_NOTE {
        return Err(AppError::bad_request(format!(
            "note must be at most {MAX_NOTE} characters"
        )));
    }

    // One write transaction: the menu cannot be deleted between the
    // membership check and the insert (which would fail the menu_id FK).
    let mut conn = crate::db::begin_write(&state.db).await?;
    let title: String = sqlx::query_scalar("SELECT title FROM recipes WHERE id = ?")
        .bind(input.recipe_id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| {
            AppError::bad_request(format!("recipe {} does not exist", input.recipe_id))
        })?;

    if let Some(menu_id) = input.menu_id {
        let in_menu: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM menu_items WHERE menu_id = ? AND recipe_id = ?")
                .bind(menu_id)
                .bind(input.recipe_id)
                .fetch_optional(&mut *conn)
                .await?;
        if in_menu.is_none() {
            return Err(AppError::bad_request("this recipe is not on that menu"));
        }
    }

    let now = now_rfc3339();
    let order: Order = sqlx::query_as(
        "INSERT INTO orders (menu_id, recipe_id, recipe_title, guest_name, note, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'new', ?, ?)
         RETURNING id, menu_id, recipe_id, recipe_title, guest_name, note, status, created_at, updated_at",
    )
    .bind(input.menu_id)
    .bind(input.recipe_id)
    .bind(title)
    .bind(guest_name)
    .bind(note)
    .bind(&now)
    .bind(&now)
    .fetch_one(&mut *conn)
    .await?;
    conn.commit().await?;
    publish(&state, &order);
    Ok((StatusCode::CREATED, Json(order)))
}

async fn fetch(State(state): State<AppState>, AppPath(id): AppPath<i64>) -> AppResult<Json<Order>> {
    Ok(Json(load_order(&state, id).await?))
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    status: Option<String>,
}

async fn list(
    _: Admin,
    State(state): State<AppState>,
    AppQuery(q): AppQuery<ListQuery>,
) -> AppResult<Json<Vec<Order>>> {
    let sql = match q.status.as_deref().map(str::trim).unwrap_or("") {
        "" | "active" => format!(
            "{ORDER_SELECT} WHERE status IN ('new', 'making') ORDER BY created_at ASC, id ASC"
        ),
        "all" => format!("{ORDER_SELECT} ORDER BY created_at DESC, id DESC LIMIT 500"),
        other => {
            return Err(AppError::bad_request(format!(
                "status must be active or all, got \"{other}\""
            )));
        }
    };
    let orders: Vec<Order> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .fetch_all(&state.db)
        .await?;
    Ok(Json(orders))
}

#[derive(Debug, Deserialize)]
struct StatusInput {
    status: OrderStatus,
}

async fn update_status(
    _: Admin,
    State(state): State<AppState>,
    AppPath(id): AppPath<i64>,
    AppJson(input): AppJson<StatusInput>,
) -> AppResult<Json<Order>> {
    let result = sqlx::query("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?")
        .bind(input.status)
        .bind(now_rfc3339())
        .bind(id)
        .execute(&state.db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found(format!("order {id} not found")));
    }
    let order = load_order(&state, id).await?;
    publish(&state, &order);
    Ok(Json(order))
}

#[derive(Debug, Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

/// Admin guard for the SSE endpoint: accepts the bearer header or `?token=`.
pub struct StreamAdmin;

impl axum::extract::FromRequestParts<AppState> for StreamAdmin {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if auth::is_admin(state, parts) {
            return Ok(StreamAdmin);
        }
        // Properly percent-decoded; a malformed query just means "no token".
        let query_token = axum::extract::Query::<TokenQuery>::try_from_uri(&parts.uri)
            .ok()
            .and_then(|q| q.0.token);
        match query_token {
            Some(t) if auth::token_matches(&state.admin_token, t.trim()) => Ok(StreamAdmin),
            _ => Err(AppError::Unauthorized),
        }
    }
}

async fn stream(
    _: StreamAdmin,
    State(state): State<AppState>,
) -> (
    [(HeaderName, &'static str); 1],
    Sse<impl Stream<Item = Result<Event, Infallible>>>,
) {
    let mut shutdown = state.shutdown.subscribe();
    let events = BroadcastStream::new(state.orders_tx.subscribe())
        .filter_map(|msg| async move {
            match msg {
                Ok(order) => match Event::default().event("order").json_data(&order) {
                    Ok(ev) => Some(Ok(ev)),
                    Err(e) => {
                        tracing::error!(error = %e, "failed to encode order event");
                        None
                    }
                },
                // Lagged receivers just skip the missed events.
                Err(e) => {
                    tracing::warn!(error = %e, "order stream lagged");
                    None
                }
            }
        })
        .take_until(async move {
            let _ = shutdown.wait_for(|stop| *stop).await;
        });
    (
        // Tell nginx-style reverse proxies not to buffer the event stream.
        [(HeaderName::from_static("x-accel-buffering"), "no")],
        Sse::new(events).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))),
    )
}
