//! Recipe data access shared by several route modules.
//!
//! Functions take `&mut SqliteConnection` so they work both on pooled
//! connections and inside transactions (`&mut *tx`).

use sqlx::SqliteConnection;

use crate::error::{AppError, AppResult};
use crate::models::{
    Ingredient, Kind, Recipe, RecipeData, RecipeSummary, RecipeVersionSummary, Source, now_rfc3339,
};

#[derive(sqlx::FromRow)]
struct RecipeRow {
    id: i64,
    title: String,
    kind: Kind,
    description: String,
    instructions: String,
    image_url: Option<String>,
    servings: f64,
    glass: Option<String>,
    garnish: Option<String>,
    method: Option<String>,
    favorite: bool,
    source: Source,
    source_id: Option<String>,
    source_url: Option<String>,
    parent_id: Option<i64>,
    created_at: String,
    updated_at: String,
}

const RECIPE_COLUMNS: &str = "r.id, r.title, r.kind, r.description, r.instructions, r.image_url, \
     r.servings, r.glass, r.garnish, r.method, r.favorite, r.source, r.source_id, r.source_url, \
     r.parent_id, r.created_at, r.updated_at";

/// Filters for listing recipe summaries. `None` means "no filter".
#[derive(Debug, Default, Clone)]
pub struct RecipeFilter {
    pub q: Option<String>,
    pub kind: Option<Kind>,
    pub favorite_only: bool,
    /// `Some("own")`, `Some("imported")` or a concrete source name.
    pub source: Option<String>,
    pub tag: Option<String>,
    pub ids: Option<Vec<i64>>,
}

pub async fn recipe_exists(conn: &mut SqliteConnection, id: i64) -> AppResult<bool> {
    let found: Option<i64> = sqlx::query_scalar("SELECT id FROM recipes WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    Ok(found.is_some())
}

/// Loads a full recipe or fails with 404.
pub async fn load_recipe(conn: &mut SqliteConnection, id: i64) -> AppResult<Recipe> {
    find_recipe(conn, id)
        .await?
        .ok_or_else(|| AppError::not_found(format!("recipe {id} not found")))
}

pub async fn find_recipe(conn: &mut SqliteConnection, id: i64) -> AppResult<Option<Recipe>> {
    let sql = format!("SELECT {RECIPE_COLUMNS} FROM recipes r WHERE r.id = ?");
    let row: Option<RecipeRow> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else { return Ok(None) };

    let ingredients: Vec<(String, Option<f64>, String, String, String)> = sqlx::query_as(
        "SELECT name, amount, unit, note, ingredient_key FROM recipe_ingredients
         WHERE recipe_id = ? ORDER BY position",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    let tags: Vec<String> =
        sqlx::query_scalar("SELECT tag FROM recipe_tags WHERE recipe_id = ? ORDER BY position")
            .bind(id)
            .fetch_all(&mut *conn)
            .await?;

    Ok(Some(Recipe {
        id: Some(row.id),
        title: row.title,
        kind: row.kind,
        description: row.description,
        instructions: row.instructions,
        image_url: row.image_url,
        servings: row.servings,
        glass: row.glass,
        garnish: row.garnish,
        method: row.method,
        tags,
        favorite: row.favorite,
        source: row.source,
        source_id: row.source_id,
        source_url: row.source_url,
        parent_id: row.parent_id,
        imported_id: None,
        ingredients: ingredients
            .into_iter()
            .map(|(name, amount, unit, note, key)| Ingredient {
                name,
                amount,
                unit,
                note,
                key,
            })
            .collect(),
        created_at: Some(row.created_at),
        updated_at: Some(row.updated_at),
    }))
}

/// A recipe summary plus the ingredient keys aligned with `ingredient_names`.
#[derive(Debug, Clone)]
pub struct SummaryWithKeys {
    pub summary: RecipeSummary,
    pub ingredient_keys: Vec<String>,
}

/// Lists recipe summaries: favorites first, then most recently updated.
pub async fn list_summaries(
    conn: &mut SqliteConnection,
    filter: &RecipeFilter,
) -> AppResult<Vec<RecipeSummary>> {
    Ok(list_summaries_with_keys(conn, filter)
        .await?
        .into_iter()
        .map(|s| s.summary)
        .collect())
}

#[derive(sqlx::FromRow)]
struct SummaryRow {
    id: i64,
    title: String,
    kind: Kind,
    description: String,
    image_url: Option<String>,
    favorite: bool,
    source: Source,
    parent_id: Option<i64>,
    updated_at: String,
    /// JSON array of tags, in order.
    tags_json: String,
    /// JSON array of `[name, key]` pairs, in order.
    ings_json: String,
}

/// Like [`list_summaries`], but also returns each recipe's ingredient keys.
///
/// One row per recipe: tags and ingredients are aggregated to JSON inside
/// SQLite, which is several times faster than decoding one row per
/// ingredient (this backs the availability ranking over the whole library).
pub async fn list_summaries_with_keys(
    conn: &mut SqliteConnection,
    filter: &RecipeFilter,
) -> AppResult<Vec<SummaryWithKeys>> {
    let ids_json = filter.ids.as_ref().map(serde_json::to_string).transpose()?;
    let rows: Vec<SummaryRow> = sqlx::query_as(
        "SELECT r.id, r.title, r.kind, r.description, r.image_url, r.favorite, r.source,
                r.parent_id, r.updated_at,
                (SELECT json_group_array(tag) FROM
                    (SELECT t.tag FROM recipe_tags t WHERE t.recipe_id = r.id ORDER BY t.position)
                ) AS tags_json,
                (SELECT json_group_array(json_array(name, ingredient_key)) FROM
                    (SELECT i.name, i.ingredient_key FROM recipe_ingredients i
                     WHERE i.recipe_id = r.id ORDER BY i.position)
                ) AS ings_json
         FROM recipes r
         WHERE (?1 IS NULL OR r.kind = ?1)
           AND (?2 = 0 OR r.favorite = 1)
           AND (?3 IS NULL
                OR (?3 = 'imported' AND r.source <> 'own')
                OR r.source = ?3)
           AND (?4 IS NULL OR EXISTS (
                SELECT 1 FROM recipe_tags t WHERE t.recipe_id = r.id AND t.tag = ?4))
           AND (?5 IS NULL OR r.id IN (SELECT value FROM json_each(?5)))
         ORDER BY r.favorite DESC, r.updated_at DESC, r.id DESC",
    )
    .bind(filter.kind.map(Kind::as_str))
    .bind(filter.favorite_only)
    .bind(filter.source.as_deref())
    .bind(filter.tag.as_deref())
    .bind(ids_json.as_deref())
    .fetch_all(&mut *conn)
    .await?;

    let needle = filter
        .q
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(str::to_lowercase);

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let tags: Vec<String> = serde_json::from_str(&row.tags_json)?;
        let pairs: Vec<(String, String)> = serde_json::from_str(&row.ings_json)?;
        let (ingredient_names, ingredient_keys) = pairs.into_iter().unzip();
        let s = SummaryWithKeys {
            summary: RecipeSummary {
                id: row.id,
                title: row.title,
                kind: row.kind,
                description: row.description,
                image_url: row.image_url,
                tags,
                favorite: row.favorite,
                source: row.source,
                parent_id: row.parent_id,
                ingredient_names,
                updated_at: row.updated_at,
            },
            ingredient_keys,
        };
        // Case-insensitive matching is done in Rust because SQLite's LOWER()
        // only folds ASCII and most titles here are Cyrillic.
        if needle
            .as_deref()
            .is_none_or(|q| matches_query(&s.summary, q))
        {
            out.push(s);
        }
    }
    Ok(out)
}

impl RecipeFilter {
    /// In-memory equivalent of the SQL filters (used with the cached index).
    pub fn matches(&self, s: &RecipeSummary) -> bool {
        self.kind.is_none_or(|k| s.kind == k)
            && (!self.favorite_only || s.favorite)
            && self.source.as_deref().is_none_or(|src| match src {
                "imported" => s.source != Source::Own,
                other => s.source.as_str() == other,
            })
            && self.tag.as_ref().is_none_or(|t| s.tags.contains(t))
            && self.ids.as_ref().is_none_or(|ids| ids.contains(&s.id))
            && self
                .q
                .as_deref()
                .map(|q| q.trim().to_lowercase())
                .filter(|q| !q.is_empty())
                .is_none_or(|q| matches_query(s, &q))
    }
}

/// `q` (already lower-cased) matches title, description or an ingredient name.
pub fn matches_query(s: &RecipeSummary, q: &str) -> bool {
    s.title.to_lowercase().contains(q)
        || s.description.to_lowercase().contains(q)
        || s.ingredient_names
            .iter()
            .any(|n| n.to_lowercase().contains(q))
}

/// Provenance of a newly inserted recipe.
#[derive(Debug, Clone, Default)]
pub struct Origin {
    pub source: Option<Source>,
    pub source_id: Option<String>,
    pub source_url: Option<String>,
    pub parent_id: Option<i64>,
}

/// Inserts a recipe with its ingredients and tags; returns the new id.
pub async fn insert_recipe(
    conn: &mut SqliteConnection,
    data: &RecipeData,
    origin: &Origin,
) -> AppResult<i64> {
    let now = now_rfc3339();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO recipes (title, kind, description, instructions, image_url, servings, glass,
             garnish, method, favorite, source, source_id, source_url, parent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id",
    )
    .bind(&data.title)
    .bind(data.kind)
    .bind(&data.description)
    .bind(&data.instructions)
    .bind(&data.image_url)
    .bind(data.servings)
    .bind(&data.glass)
    .bind(&data.garnish)
    .bind(&data.method)
    .bind(data.favorite.unwrap_or(false))
    .bind(origin.source.unwrap_or(Source::Own))
    .bind(&origin.source_id)
    .bind(&origin.source_url)
    .bind(origin.parent_id)
    .bind(&now)
    .bind(&now)
    .fetch_one(&mut *conn)
    .await?;
    write_children(conn, id, data).await?;
    Ok(id)
}

/// Replaces the editable content of a recipe (source fields and parent are kept).
pub async fn update_recipe(
    conn: &mut SqliteConnection,
    id: i64,
    data: &RecipeData,
) -> AppResult<()> {
    let result = sqlx::query(
        "UPDATE recipes SET title = ?, kind = ?, description = ?, instructions = ?, image_url = ?,
             servings = ?, glass = ?, garnish = ?, method = ?, favorite = COALESCE(?, favorite),
             updated_at = ?
         WHERE id = ?",
    )
    .bind(&data.title)
    .bind(data.kind)
    .bind(&data.description)
    .bind(&data.instructions)
    .bind(&data.image_url)
    .bind(data.servings)
    .bind(&data.glass)
    .bind(&data.garnish)
    .bind(&data.method)
    .bind(data.favorite)
    .bind(now_rfc3339())
    .bind(id)
    .execute(&mut *conn)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found(format!("recipe {id} not found")));
    }
    sqlx::query("DELETE FROM recipe_ingredients WHERE recipe_id = ?")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM recipe_tags WHERE recipe_id = ?")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    write_children(conn, id, data).await
}

async fn write_children(conn: &mut SqliteConnection, id: i64, data: &RecipeData) -> AppResult<()> {
    let catalog = crate::catalog::catalog();
    for (pos, ing) in data.ingredients.iter().enumerate() {
        // Always re-resolved from the name: the key is never trusted from input.
        sqlx::query(
            "INSERT INTO recipe_ingredients (recipe_id, position, name, amount, unit, note, ingredient_key)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(pos as i64)
        .bind(&ing.name)
        .bind(ing.amount)
        .bind(&ing.unit)
        .bind(&ing.note)
        .bind(catalog.resolve(&ing.name))
        .execute(&mut *conn)
        .await?;
    }
    for (pos, tag) in data.tags.iter().enumerate() {
        sqlx::query(
            "INSERT OR IGNORE INTO recipe_tags (recipe_id, position, tag) VALUES (?, ?, ?)",
        )
        .bind(id)
        .bind(pos as i64)
        .bind(tag)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

pub async fn set_favorite(conn: &mut SqliteConnection, id: i64, favorite: bool) -> AppResult<()> {
    let result = sqlx::query("UPDATE recipes SET favorite = ?, updated_at = ? WHERE id = ?")
        .bind(favorite)
        .bind(now_rfc3339())
        .bind(id)
        .execute(conn)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found(format!("recipe {id} not found")));
    }
    Ok(())
}

/// Stores a JSON snapshot of `recipe` as a version.
pub async fn snapshot_version(
    conn: &mut SqliteConnection,
    recipe: &Recipe,
    note: &str,
) -> AppResult<i64> {
    let recipe_id = recipe
        .id
        .ok_or_else(|| AppError::internal("cannot snapshot a recipe without id"))?;
    let snapshot = serde_json::to_string(recipe)?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO recipe_versions (recipe_id, note, title, snapshot, created_at)
         VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(recipe_id)
    .bind(note)
    .bind(&recipe.title)
    .bind(snapshot)
    .bind(now_rfc3339())
    .fetch_one(conn)
    .await?;
    Ok(id)
}

pub async fn list_versions(
    conn: &mut SqliteConnection,
    recipe_id: i64,
) -> AppResult<Vec<RecipeVersionSummary>> {
    let rows: Vec<(i64, i64, String, String, String)> = sqlx::query_as(
        "SELECT id, recipe_id, note, title, created_at FROM recipe_versions
         WHERE recipe_id = ? ORDER BY id DESC",
    )
    .bind(recipe_id)
    .fetch_all(conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, recipe_id, note, title, created_at)| RecipeVersionSummary {
                id,
                recipe_id,
                note,
                title,
                created_at,
            },
        )
        .collect())
}

/// Loads one version (summary + parsed snapshot) or 404.
pub async fn load_version(
    conn: &mut SqliteConnection,
    recipe_id: i64,
    version_id: i64,
) -> AppResult<(RecipeVersionSummary, Recipe)> {
    let row: Option<(i64, i64, String, String, String, String)> = sqlx::query_as(
        "SELECT id, recipe_id, note, title, created_at, snapshot FROM recipe_versions
         WHERE id = ? AND recipe_id = ?",
    )
    .bind(version_id)
    .bind(recipe_id)
    .fetch_optional(conn)
    .await?;
    let (id, recipe_id, note, title, created_at, snapshot) = row.ok_or_else(|| {
        AppError::not_found(format!(
            "version {version_id} of recipe {recipe_id} not found"
        ))
    })?;
    let mut recipe: Recipe = serde_json::from_str(&snapshot)?;
    let catalog = crate::catalog::catalog();
    for i in &mut recipe.ingredients {
        i.key = catalog.resolve(&i.name);
    }
    Ok((
        RecipeVersionSummary {
            id,
            recipe_id,
            note,
            title,
            created_at,
        },
        recipe,
    ))
}

/// Local id of an already-imported external recipe.
pub async fn find_imported(
    conn: &mut SqliteConnection,
    source: Source,
    source_id: &str,
) -> AppResult<Option<i64>> {
    Ok(
        sqlx::query_scalar("SELECT id FROM recipes WHERE source = ? AND source_id = ?")
            .bind(source)
            .bind(source_id)
            .fetch_optional(conn)
            .await?,
    )
}

/// Inserts an upstream recipe as a local imported copy (favorite = false) and
/// returns its id. The caller checks for an existing copy first.
pub async fn insert_imported(
    conn: &mut SqliteConnection,
    upstream: &Recipe,
    source: Source,
    source_id: &str,
) -> AppResult<i64> {
    let data = RecipeData {
        favorite: Some(false),
        ..RecipeData::from_recipe(upstream)
    };
    let origin = Origin {
        source: Some(source),
        source_id: Some(source_id.to_owned()),
        source_url: upstream.source_url.clone(),
        parent_id: None,
    };
    insert_recipe(conn, &data, &origin).await
}

/// All source ids already imported from `source`.
pub async fn imported_ids(
    conn: &mut SqliteConnection,
    source: Source,
) -> AppResult<std::collections::HashSet<String>> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT source_id FROM recipes WHERE source = ? AND source_id IS NOT NULL",
    )
    .bind(source)
    .fetch_all(conn)
    .await?;
    Ok(ids.into_iter().collect())
}
