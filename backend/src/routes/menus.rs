//! `/api/menus` — menus guests can order from; exactly one may be active.

use std::collections::{HashMap, HashSet};

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use sqlx::SqliteConnection;

use crate::auth::Admin;
use crate::error::{AppError, AppResult};
use crate::extract::{AppJson, AppPath};
use crate::models::{Menu, MenuItem, MenuSummary, now_rfc3339, validate_title};
use crate::pantry::{self, Pantry};
use crate::repo::{self, RecipeFilter};
use crate::state::AppState;

const MAX_MENU_DESCRIPTION: usize = 2000;
const MAX_MENU_ITEMS: usize = 200;
const MAX_ITEM_NOTE: usize = 300;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/menus", get(list).post(create))
        .route("/menus/active", get(active))
        .route("/menus/{id}", get(fetch).put(update).delete(remove))
        .route("/menus/{id}/items", put(set_items))
        .route("/menus/{id}/activate", post(activate))
        .route("/menus/{id}/deactivate", post(deactivate))
}

#[derive(sqlx::FromRow)]
struct MenuRow {
    id: i64,
    title: String,
    description: String,
    is_active: bool,
    item_count: i64,
    created_at: String,
    updated_at: String,
}

impl From<MenuRow> for MenuSummary {
    fn from(r: MenuRow) -> Self {
        Self {
            id: r.id,
            title: r.title,
            description: r.description,
            is_active: r.is_active,
            item_count: r.item_count,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

const MENU_SELECT: &str =
    "SELECT m.id, m.title, m.description, m.is_active, m.created_at, m.updated_at,
        (SELECT COUNT(*) FROM menu_items i WHERE i.menu_id = m.id) AS item_count
     FROM menus m";

async fn load_menu(conn: &mut SqliteConnection, id: i64) -> AppResult<Menu> {
    let sql = format!("{MENU_SELECT} WHERE m.id = ?");
    let row: MenuRow = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| AppError::not_found(format!("menu {id} not found")))?;

    let items: Vec<(i64, i64, String)> = sqlx::query_as(
        "SELECT recipe_id, position, note FROM menu_items WHERE menu_id = ? ORDER BY position",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    let filter = RecipeFilter {
        ids: Some(items.iter().map(|(rid, _, _)| *rid).collect()),
        ..RecipeFilter::default()
    };
    let have = Pantry::load(conn).await?;
    let mut summaries: HashMap<i64, _> = repo::list_summaries_with_keys(conn, &filter)
        .await?
        .into_iter()
        .map(|s| (s.summary.id, s))
        .collect();
    let items = items
        .into_iter()
        .filter_map(|(recipe_id, position, note)| {
            summaries.remove(&recipe_id).map(|s| {
                let (_, missing) = pantry::evaluate(&have, &s);
                MenuItem {
                    recipe_id,
                    position,
                    note,
                    recipe: s.summary,
                    missing,
                }
            })
        })
        .collect();
    Ok(Menu {
        summary: row.into(),
        items,
    })
}

async fn list(State(state): State<AppState>) -> AppResult<Json<Vec<MenuSummary>>> {
    let sql = format!("{MENU_SELECT} ORDER BY m.is_active DESC, m.updated_at DESC, m.id DESC");
    let rows: Vec<MenuRow> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .fetch_all(&state.db)
        .await?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

async fn active(State(state): State<AppState>) -> AppResult<Json<Menu>> {
    let mut conn = state.db.acquire().await?;
    let id: i64 = sqlx::query_scalar("SELECT id FROM menus WHERE is_active = 1 LIMIT 1")
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| AppError::not_found("no active menu"))?;
    Ok(Json(load_menu(&mut conn, id).await?))
}

async fn fetch(State(state): State<AppState>, AppPath(id): AppPath<i64>) -> AppResult<Json<Menu>> {
    let mut conn = state.db.acquire().await?;
    Ok(Json(load_menu(&mut conn, id).await?))
}

#[derive(Debug, Deserialize)]
struct MenuInput {
    title: String,
    #[serde(default)]
    description: Option<String>,
}

impl MenuInput {
    fn validate(self) -> AppResult<(String, String)> {
        let title = validate_title(&self.title)?;
        let description = self.description.unwrap_or_default().trim().to_owned();
        if description.chars().count() > MAX_MENU_DESCRIPTION {
            return Err(AppError::bad_request(format!(
                "description must be at most {MAX_MENU_DESCRIPTION} characters"
            )));
        }
        Ok((title, description))
    }
}

async fn create(
    _: Admin,
    State(state): State<AppState>,
    AppJson(input): AppJson<MenuInput>,
) -> AppResult<(StatusCode, Json<Menu>)> {
    let (title, description) = input.validate()?;
    let now = now_rfc3339();
    let mut conn = state.db.acquire().await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO menus (title, description, is_active, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?) RETURNING id",
    )
    .bind(title)
    .bind(description)
    .bind(&now)
    .bind(&now)
    .fetch_one(&mut *conn)
    .await?;
    Ok((StatusCode::CREATED, Json(load_menu(&mut conn, id).await?)))
}

async fn update(
    _: Admin,
    State(state): State<AppState>,
    AppPath(id): AppPath<i64>,
    AppJson(input): AppJson<MenuInput>,
) -> AppResult<Json<Menu>> {
    let (title, description) = input.validate()?;
    let mut conn = state.db.acquire().await?;
    let result =
        sqlx::query("UPDATE menus SET title = ?, description = ?, updated_at = ? WHERE id = ?")
            .bind(title)
            .bind(description)
            .bind(now_rfc3339())
            .bind(id)
            .execute(&mut *conn)
            .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found(format!("menu {id} not found")));
    }
    Ok(Json(load_menu(&mut conn, id).await?))
}

async fn remove(
    _: Admin,
    State(state): State<AppState>,
    AppPath(id): AppPath<i64>,
) -> AppResult<StatusCode> {
    let result = sqlx::query("DELETE FROM menus WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found(format!("menu {id} not found")));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemInput {
    recipe_id: i64,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ItemsInput {
    items: Vec<ItemInput>,
}

async fn set_items(
    _: Admin,
    State(state): State<AppState>,
    AppPath(id): AppPath<i64>,
    AppJson(input): AppJson<ItemsInput>,
) -> AppResult<Json<Menu>> {
    if input.items.len() > MAX_MENU_ITEMS {
        return Err(AppError::bad_request(format!(
            "at most {MAX_MENU_ITEMS} items allowed"
        )));
    }
    let mut tx = crate::db::begin_write(&state.db).await?;
    let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM menus WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(AppError::not_found(format!("menu {id} not found")));
    }
    sqlx::query("DELETE FROM menu_items WHERE menu_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    // Duplicates are collapsed (first occurrence wins); positions stay dense.
    let mut seen = HashSet::new();
    let mut position = 0i64;
    for item in input.items {
        if !seen.insert(item.recipe_id) {
            continue;
        }
        if !repo::recipe_exists(&mut tx, item.recipe_id).await? {
            return Err(AppError::bad_request(format!(
                "recipe {} does not exist",
                item.recipe_id
            )));
        }
        let note = item.note.unwrap_or_default().trim().to_owned();
        if note.chars().count() > MAX_ITEM_NOTE {
            return Err(AppError::bad_request(format!(
                "item note must be at most {MAX_ITEM_NOTE} characters"
            )));
        }
        sqlx::query(
            "INSERT INTO menu_items (menu_id, recipe_id, position, note) VALUES (?, ?, ?, ?)",
        )
        .bind(id)
        .bind(item.recipe_id)
        .bind(position)
        .bind(note)
        .execute(&mut *tx)
        .await?;
        position += 1;
    }
    sqlx::query("UPDATE menus SET updated_at = ? WHERE id = ?")
        .bind(now_rfc3339())
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let menu = load_menu(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(menu))
}

async fn activate(
    _: Admin,
    State(state): State<AppState>,
    AppPath(id): AppPath<i64>,
) -> AppResult<Json<Menu>> {
    let mut tx = crate::db::begin_write(&state.db).await?;
    let now = now_rfc3339();
    let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM menus WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(AppError::not_found(format!("menu {id} not found")));
    }
    sqlx::query("UPDATE menus SET is_active = 0, updated_at = ? WHERE is_active = 1 AND id <> ?")
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE menus SET is_active = 1, updated_at = ? WHERE id = ?")
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let menu = load_menu(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(menu))
}

async fn deactivate(
    _: Admin,
    State(state): State<AppState>,
    AppPath(id): AppPath<i64>,
) -> AppResult<Json<Menu>> {
    let mut conn = state.db.acquire().await?;
    let result = sqlx::query("UPDATE menus SET is_active = 0, updated_at = ? WHERE id = ?")
        .bind(now_rfc3339())
        .bind(id)
        .execute(&mut *conn)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found(format!("menu {id} not found")));
    }
    Ok(Json(load_menu(&mut conn, id).await?))
}
