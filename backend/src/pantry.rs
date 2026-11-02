//! Pantry matching: which recipes can be made from what the host has at home.
//!
//! Everything is computed in memory per request: the pantry (a few dozen keys)
//! and the catalog parent relation are tiny, and recipe ingredient keys are
//! loaded with a single query, so ranking ~1500 recipes takes a few ms.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

use sqlx::SqliteConnection;

use crate::catalog::{Category, catalog};
use crate::error::AppResult;
use crate::models::{MissingIngredient, PantryItem, Settings};
use crate::repo::{self, RecipeFilter, SummaryWithKeys};

/// Value of the trigger-maintained `recipe_data_version` counter (bumped on
/// every change to recipes, their ingredients or tags).
type Fingerprint = i64;

/// In-memory copy of all recipe summaries with ingredient keys, reloaded only
/// when the recipe table changed. Availability and suggestions rank the whole
/// library on every request, so this keeps them at a few ms.
#[derive(Default)]
pub struct RecipeIndex {
    cached: RwLock<Option<(Fingerprint, Arc<Vec<SummaryWithKeys>>)>>,
}

impl RecipeIndex {
    pub async fn get(&self, conn: &mut SqliteConnection) -> AppResult<Arc<Vec<SummaryWithKeys>>> {
        let fp: Fingerprint =
            sqlx::query_scalar("SELECT version FROM recipe_data_version WHERE id = 1")
                .fetch_one(&mut *conn)
                .await?;
        if let Some((cached_fp, list)) = self.read().as_ref()
            && *cached_fp == fp
        {
            return Ok(list.clone());
        }
        let list = Arc::new(repo::list_summaries_with_keys(conn, &RecipeFilter::default()).await?);
        *self.cached.write().unwrap_or_else(|e| e.into_inner()) = Some((fp, list.clone()));
        Ok(list)
    }

    fn read(
        &self,
    ) -> std::sync::RwLockReadGuard<'_, Option<(Fingerprint, Arc<Vec<SummaryWithKeys>>)>> {
        self.cached.read().unwrap_or_else(|e| e.into_inner())
    }
}

/// The set of pantry keys plus the parents of those keys.
#[derive(Debug, Clone, Default)]
pub struct Pantry {
    keys: HashSet<String>,
    /// `parent(P)` for every pantry key P (have "light rum" → satisfies "rum").
    parents: HashSet<String>,
}

impl Pantry {
    pub fn from_keys<I, S>(keys: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let cat = catalog();
        let keys: HashSet<String> = keys.into_iter().map(Into::into).collect();
        let parents = keys
            .iter()
            .filter_map(|k| cat.parent(k).map(str::to_owned))
            .collect();
        Self { keys, parents }
    }

    pub async fn load(conn: &mut SqliteConnection) -> AppResult<Self> {
        let keys: Vec<String> = sqlx::query_scalar("SELECT key FROM pantry")
            .fetch_all(conn)
            .await?;
        Ok(Self::from_keys(keys))
    }

    /// Matching rule: P satisfies R if `P == R`, `parent(R) == P` or `parent(P) == R`.
    pub fn satisfies(&self, key: &str) -> bool {
        self.keys.contains(key)
            || self.parents.contains(key)
            || catalog().parent(key).is_some_and(|p| self.keys.contains(p))
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

/// Display name for a key: catalog name, else the recipe's own wording.
pub fn display_name(key: &str, fallback: &str) -> String {
    match catalog().get(key) {
        Some(e) => e.display_name().to_owned(),
        None => fallback.to_owned(),
    }
}

/// Distinct non-staple keys of a recipe (in recipe order) with a fallback name.
fn required(keys: &[String], names: &[String]) -> Vec<(String, String)> {
    let cat = catalog();
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(keys.len());
    for (i, key) in keys.iter().enumerate() {
        if key.is_empty() || cat.is_staple(key) || !seen.insert(key.as_str()) {
            continue;
        }
        let name = names.get(i).map(String::as_str).unwrap_or(key);
        out.push((key.clone(), name.to_owned()));
    }
    out
}

/// `(total non-staple ingredients, missing ones)` for one recipe.
pub fn evaluate(pantry: &Pantry, s: &SummaryWithKeys) -> (usize, Vec<MissingIngredient>) {
    let req = required(&s.ingredient_keys, &s.summary.ingredient_names);
    let total = req.len();
    let missing = req
        .into_iter()
        .filter(|(k, _)| !pantry.satisfies(k))
        .map(|(key, name)| MissingIngredient {
            name: display_name(&key, &name),
            key,
        })
        .collect();
    (total, missing)
}

/// The single key whose addition would make a recipe with these missing
/// ingredients fully makeable, if there is one.
pub fn unlocking_key(missing: &[MissingIngredient]) -> Option<&MissingIngredient> {
    match missing {
        [only] => Some(only),
        // Adding the child also satisfies its parent ("light rum" covers "rum").
        [a, b] => {
            let cat = catalog();
            if cat.parent(&a.key) == Some(b.key.as_str()) {
                Some(a)
            } else if cat.parent(&b.key) == Some(a.key.as_str()) {
                Some(b)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Full pantry list sorted by category, then name.
pub async fn list_items(conn: &mut SqliteConnection) -> AppResult<Vec<PantryItem>> {
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT key, name, added_at FROM pantry")
            .fetch_all(conn)
            .await?;
    let cat = catalog();
    let mut items: Vec<PantryItem> = rows
        .into_iter()
        .map(|(key, typed, added_at)| match cat.get(&key) {
            Some(e) => PantryItem {
                name: e.display_name().to_owned(),
                name_en: e.name_en.clone(),
                category: e.category,
                key,
                added_at,
            },
            None => PantryItem {
                name: typed.clone(),
                name_en: typed,
                category: Category::Other,
                key,
                added_at,
            },
        })
        .collect();
    items.sort_by_cached_key(|i| (i.category.rank(), i.name.to_lowercase(), i.key.clone()));
    Ok(items)
}

pub async fn load_settings(conn: &mut SqliteConnection) -> AppResult<Settings> {
    let row: Option<(i64, bool)> =
        sqlx::query_as("SELECT guest_max_missing, guest_show_menu FROM settings WHERE id = 1")
            .fetch_optional(conn)
            .await?;
    let (guest_max_missing, guest_show_menu) = row.unwrap_or((0, true));
    Ok(Settings {
        guest_max_missing,
        guest_show_menu,
    })
}

/// Number of local recipes using each key, plus a sample original name
/// (display name for custom keys).
pub async fn key_usage(conn: &mut SqliteConnection) -> AppResult<HashMap<String, (i64, String)>> {
    let rows: Vec<(String, i64, String)> = sqlx::query_as(
        "SELECT ingredient_key, COUNT(DISTINCT recipe_id), MIN(name) FROM recipe_ingredients
         WHERE ingredient_key <> '' GROUP BY ingredient_key",
    )
    .fetch_all(conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(key, count, name)| (key, (count, name)))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Kind, RecipeSummary, Source};

    fn recipe(names: &[&str]) -> SummaryWithKeys {
        let cat = catalog();
        SummaryWithKeys {
            summary: RecipeSummary {
                id: 1,
                title: "t".into(),
                kind: Kind::Cocktail,
                description: String::new(),
                image_url: None,
                tags: vec![],
                favorite: false,
                source: Source::Own,
                parent_id: None,
                ingredient_names: names.iter().map(|n| (*n).to_owned()).collect(),
                updated_at: String::new(),
            },
            ingredient_keys: names.iter().map(|n| cat.resolve(n)).collect(),
        }
    }

    #[test]
    fn parent_child_and_staples() {
        let r = recipe(&["Белый ром", "Сок лайма", "Сахарный сироп", "Лёд", "Water"]);
        let (total, missing) = evaluate(&Pantry::from_keys(["rum", "lime juice"]), &r);
        assert_eq!(total, 3, "staples are not counted");
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].key, "sugar syrup");
        assert_eq!(missing[0].name, "Сахарный сироп");

        // Have the specific, recipe wants the generic.
        let generic = recipe(&["Rum"]);
        assert!(
            evaluate(&Pantry::from_keys(["light rum"]), &generic)
                .1
                .is_empty()
        );
        // Siblings do not match each other.
        let dark = recipe(&["Dark rum"]);
        assert_eq!(
            evaluate(&Pantry::from_keys(["light rum"]), &dark).1.len(),
            1
        );
        // Custom ingredients match by exact normalised name.
        let custom = recipe(&["Настойка бабушки"]);
        let (_, m) = evaluate(&Pantry::from_keys(["настойка бабушки"]), &custom);
        assert!(m.is_empty());
        let (_, m) = evaluate(&Pantry::default(), &custom);
        assert_eq!(m[0].name, "Настойка бабушки");
    }

    #[test]
    fn unlocking_prefers_child() {
        let m = |k: &str| MissingIngredient {
            key: k.into(),
            name: k.into(),
        };
        assert_eq!(unlocking_key(&[m("gin")]).unwrap().key, "gin");
        assert_eq!(
            unlocking_key(&[m("rum"), m("light rum")]).unwrap().key,
            "light rum"
        );
        assert!(unlocking_key(&[m("gin"), m("campari")]).is_none());
        assert!(unlocking_key(&[]).is_none());
    }
}
