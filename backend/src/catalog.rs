//! Ingredient catalog: canonical ingredient keys, names in two languages,
//! aliases, categories and the parent relation used for pantry matching.
//!
//! The catalog is embedded at compile time from `data/ingredients.json`.
//! Free-text ingredient names ("Сок лайма", "Lime juice", "lime") resolve to a
//! canonical key; unknown names resolve to their normalised text (a custom key).

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

const CATALOG_JSON: &str = include_str!("../data/ingredients.json");

/// Bump when the resolution algorithm changes (forces a backfill even if the
/// JSON is unchanged).
const RESOLVER_VERSION: &str = "resolver-v1";

const META_KEY: &str = "catalog_hash";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Spirits,
    Liqueurs,
    Wine,
    Beer,
    Mixers,
    Juices,
    Syrups,
    Bitters,
    Fruits,
    Vegetables,
    Herbs,
    Spices,
    Dairy,
    Eggs,
    Meat,
    Fish,
    Grains,
    Bakery,
    Sauces,
    Oils,
    Sweets,
    Nuts,
    Other,
}

impl Category {
    /// Sort rank (declaration order: bar first, then kitchen, "other" last).
    pub fn rank(self) -> u8 {
        self as u8
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogEntry {
    pub key: String,
    pub name_en: String,
    pub name_ru: String,
    pub category: Category,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub staple: bool,
    /// Normalised RU/EN names and aliases (for autocomplete); filled on load.
    #[serde(skip)]
    pub terms: Vec<String>,
}

impl CatalogEntry {
    /// Display name: Russian if known, else English.
    pub fn display_name(&self) -> &str {
        if self.name_ru.is_empty() {
            &self.name_en
        } else {
            &self.name_ru
        }
    }
}

#[derive(Debug, Deserialize)]
struct CatalogFile {
    #[allow(dead_code)]
    version: u32,
    ingredients: Vec<CatalogEntry>,
}

pub struct Catalog {
    entries: Vec<CatalogEntry>,
    by_key: HashMap<String, usize>,
    /// normalised name / alias → entry index
    index: HashMap<String, usize>,
    hash: String,
}

static CATALOG: LazyLock<Catalog> =
    LazyLock::new(|| Catalog::parse(CATALOG_JSON).expect("embedded ingredients.json is valid"));

/// The embedded catalog.
pub fn catalog() -> &'static Catalog {
    &CATALOG
}

/// Words that do not change what the ingredient is ("fresh lime", "chopped
/// onion", "сок лайма свежевыжатый"); stripped from either end as a fallback.
const FILLER_WORDS: &[&str] = &[
    "fresh",
    "freshly",
    "chopped",
    "finely",
    "roughly",
    "minced",
    "sliced",
    "diced",
    "grated",
    "large",
    "small",
    "medium",
    "whole",
    "organic",
    "free-range",
    "beaten",
    "crushed",
    "raw",
    "cooked",
    "frozen",
    "canned",
    "tinned",
    "ripe",
    "boneless",
    "skinless",
    "peeled",
    "thinly",
    "thick",
    "thin",
    "halved",
    "softened",
    "melted",
    "cold",
    "hot",
    "warm",
    "plain",
    "extra",
    "свежий",
    "свежая",
    "свежие",
    "свежее",
    "свежевыжатый",
    "свежевыжатая",
    "свежевыжатого",
    "молотый",
    "молотая",
    "молотые",
    "мелко",
    "рубленый",
    "рубленая",
    "нарезанный",
    "нарезанная",
    "крупный",
    "крупная",
    "большой",
    "большая",
    "маленький",
    "маленькая",
    "охлажденный",
    "охлажденное",
    "охлажденная",
];

/// Normalises an ingredient name: trim, lower-case, `ё→е`, strip trailing
/// bracketed remarks and punctuation, collapse whitespace.
pub fn normalize(name: &str) -> String {
    let mut s = name.trim().to_lowercase().replace('ё', "е");
    loop {
        let before = s.len();
        let trimmed = s.trim_end();
        let mut cut = trimmed.len();
        if let Some(close) = trimmed.chars().last().filter(|c| matches!(c, ')' | ']')) {
            let open = if close == ')' { '(' } else { '[' };
            if let Some(pos) = trimmed.rfind(open) {
                cut = pos;
            }
        }
        let t = trimmed[..cut]
            .trim_end()
            .trim_end_matches(['.', ',', ';', ':', '!', '?', '*'])
            .trim_end();
        s = t.to_owned();
        if s.len() == before {
            break;
        }
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// English singular of the last word ("limes" → "lime", "berries" → "berry").
fn singular(word: &str) -> Option<String> {
    let n = word.chars().count();
    if n > 4 && word.ends_with("ies") {
        return Some(format!("{}y", &word[..word.len() - 3]));
    }
    if n > 4 && word.ends_with("oes") {
        return Some(word[..word.len() - 2].to_owned());
    }
    if ["shes", "ches", "sses", "xes"]
        .iter()
        .any(|suf| word.ends_with(suf))
    {
        return Some(word[..word.len() - 2].to_owned());
    }
    if n > 3 && word.ends_with('s') && !word.ends_with("ss") {
        return Some(word[..word.len() - 1].to_owned());
    }
    None
}

fn strip_fillers(s: &str) -> String {
    let mut words: Vec<&str> = s.split(' ').collect();
    while words.first().is_some_and(|w| FILLER_WORDS.contains(w)) {
        words.remove(0);
    }
    while words.last().is_some_and(|w| FILLER_WORDS.contains(w)) {
        words.pop();
    }
    words.join(" ")
}

impl Catalog {
    fn parse(json: &str) -> Result<Self, String> {
        let file: CatalogFile = serde_json::from_str(json).map_err(|e| e.to_string())?;
        let mut entries = file.ingredients;
        let mut by_key = HashMap::new();
        let mut index = HashMap::new();
        for (i, e) in entries.iter_mut().enumerate() {
            if by_key.insert(e.key.clone(), i).is_some() {
                return Err(format!("duplicate key {}", e.key));
            }
            let mut terms: Vec<String> = Vec::new();
            for name in [&e.key, &e.name_en, &e.name_ru]
                .into_iter()
                .chain(e.aliases.iter())
            {
                let n = normalize(name);
                if n.is_empty() {
                    continue;
                }
                // First mapping wins; the unit test rejects conflicting ones.
                index.entry(n.clone()).or_insert(i);
                if !terms.contains(&n) {
                    terms.push(n);
                }
            }
            e.terms = terms;
        }
        let mut hasher = Sha256::new();
        hasher.update(RESOLVER_VERSION.as_bytes());
        hasher.update(json.as_bytes());
        Ok(Self {
            entries,
            by_key,
            index,
            hash: hex::encode(hasher.finalize()),
        })
    }

    pub fn entries(&self) -> &[CatalogEntry] {
        &self.entries
    }

    /// Content hash of the catalog + resolver version.
    pub fn hash(&self) -> &str {
        &self.hash
    }

    pub fn get(&self, key: &str) -> Option<&CatalogEntry> {
        self.by_key.get(key).map(|&i| &self.entries[i])
    }

    pub fn parent(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(|e| e.parent.as_deref())
    }

    pub fn is_staple(&self, key: &str) -> bool {
        self.get(key).is_some_and(|e| e.staple)
    }

    /// Catalog entry for a free-text name, if any.
    pub fn lookup(&self, name: &str) -> Option<&CatalogEntry> {
        let n = normalize(name);
        if n.is_empty() {
            return None;
        }
        self.lookup_normalized(&n)
    }

    fn find(&self, n: &str) -> Option<&CatalogEntry> {
        self.index.get(n).map(|&i| &self.entries[i])
    }

    fn lookup_normalized(&self, n: &str) -> Option<&CatalogEntry> {
        if let Some(e) = self.find(n) {
            return Some(e);
        }
        // Fallbacks for upstream noise: "free-range egg, beaten", "chopped
        // onions", "сок лайма свежевыжатый".
        let mut candidates: Vec<String> = Vec::new();
        if let Some((head, _)) = n.split_once(',') {
            candidates.push(normalize(head));
        }
        candidates.push(n.to_owned());
        let stripped: Vec<String> = candidates.iter().map(|c| strip_fillers(c)).collect();
        candidates.extend(stripped);
        let singulars: Vec<String> = candidates
            .iter()
            .filter_map(|c| {
                let (head, last) = match c.rsplit_once(' ') {
                    Some((h, l)) => (Some(h), l),
                    None => (None, c.as_str()),
                };
                singular(last).map(|s| match head {
                    Some(h) => format!("{h} {s}"),
                    None => s,
                })
            })
            .collect();
        candidates.extend(singulars);
        candidates
            .iter()
            .filter(|c| !c.is_empty())
            .find_map(|c| self.find(c))
    }

    /// Canonical key for a free-text name: the catalog key, or the normalised
    /// name itself for unknown (custom) ingredients.
    pub fn resolve(&self, name: &str) -> String {
        let n = normalize(name);
        match self.lookup_normalized(&n) {
            Some(e) => e.key.clone(),
            None => n,
        }
    }

    /// Whether `key` is a catalog key (as opposed to a custom one).
    pub fn contains(&self, key: &str) -> bool {
        self.by_key.contains_key(key)
    }
}

/// Re-resolves stored ingredient keys (recipe ingredients and pantry) when the
/// embedded catalog (or the resolver) changed since the last run.
pub async fn backfill_if_changed(pool: &SqlitePool) -> Result<bool, sqlx::Error> {
    let cat = catalog();
    let stored: Option<String> = sqlx::query_scalar("SELECT value FROM app_meta WHERE key = ?")
        .bind(META_KEY)
        .fetch_optional(pool)
        .await?;
    if stored.as_deref() == Some(cat.hash()) {
        return Ok(false);
    }
    let mut tx = crate::db::begin_write(pool).await?;
    let rows: Vec<(i64, i64, String, String)> =
        sqlx::query_as("SELECT recipe_id, position, name, ingredient_key FROM recipe_ingredients")
            .fetch_all(&mut *tx)
            .await?;
    let mut changed = 0usize;
    for (recipe_id, position, name, old) in rows {
        let key = cat.resolve(&name);
        if key != old {
            sqlx::query(
                "UPDATE recipe_ingredients SET ingredient_key = ? WHERE recipe_id = ? AND position = ?",
            )
            .bind(&key)
            .bind(recipe_id)
            .bind(position)
            .execute(&mut *tx)
            .await?;
            changed += 1;
        }
    }
    let pantry: Vec<(String, String, String)> =
        sqlx::query_as("SELECT key, name, added_at FROM pantry")
            .fetch_all(&mut *tx)
            .await?;
    for (old, name, added_at) in pantry {
        let key = cat.resolve(&name);
        if key != old {
            sqlx::query("DELETE FROM pantry WHERE key = ?")
                .bind(&old)
                .execute(&mut *tx)
                .await?;
            sqlx::query("INSERT OR IGNORE INTO pantry (key, name, added_at) VALUES (?, ?, ?)")
                .bind(&key)
                .bind(&name)
                .bind(&added_at)
                .execute(&mut *tx)
                .await?;
        }
    }
    sqlx::query("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .bind(META_KEY)
        .bind(cat.hash())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    tracing::info!(changed, "ingredient keys re-resolved for catalog update");
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn catalog_parses_and_is_large_enough() {
        let c = catalog();
        assert!(c.entries().len() >= 400, "{}", c.entries().len());
        for e in c.entries() {
            assert_eq!(e.key, normalize(&e.key), "key must be normalised");
            assert!(!e.name_en.is_empty() && !e.name_ru.is_empty(), "{}", e.key);
            assert!(
                e.name_ru
                    .chars()
                    .any(|ch| ('а'..='я').contains(&ch.to_lowercase().next().unwrap())),
                "nameRu of {} should be Russian",
                e.key
            );
            if let Some(p) = &e.parent {
                let parent = c
                    .get(p)
                    .unwrap_or_else(|| panic!("{}: unknown parent {p}", e.key));
                assert!(
                    parent.parent.is_none(),
                    "{}: parent chains not allowed",
                    e.key
                );
                assert_ne!(p, &e.key);
            }
        }
        for staple in ["water", "ice", "hot water", "cold water", "boiling water"] {
            assert!(c.is_staple(staple), "{staple} must be a staple");
        }
    }

    #[test]
    fn no_alias_maps_to_two_keys() {
        let c = catalog();
        let mut seen: HashMap<String, &str> = HashMap::new();
        let mut conflicts = Vec::new();
        for e in c.entries() {
            for name in [&e.key, &e.name_en, &e.name_ru]
                .into_iter()
                .chain(e.aliases.iter())
            {
                let n = normalize(name);
                if let Some(prev) = seen.insert(n.clone(), &e.key)
                    && prev != e.key
                {
                    conflicts.push(format!("{n:?}: {prev} vs {}", e.key));
                }
            }
        }
        assert!(conflicts.is_empty(), "conflicting aliases: {conflicts:?}");
    }

    #[test]
    fn display_names_resolve_back_to_their_key() {
        // The UI re-adds pantry items by POSTing the displayed name.
        let c = catalog();
        for e in c.entries() {
            assert_eq!(c.resolve(e.display_name()), e.key, "nameRu of {}", e.key);
            assert_eq!(c.resolve(&e.name_en), e.key, "nameEn of {}", e.key);
            for a in &e.aliases {
                assert_eq!(c.resolve(a), e.key, "alias {a:?} of {}", e.key);
            }
        }
    }

    #[test]
    fn every_seed_ingredient_resolves_to_catalog_key() {
        let c = catalog();
        let mut unresolved = Vec::new();
        for r in crate::seed::house_recipes() {
            for i in &r.ingredients {
                if c.lookup(&i.name).is_none() {
                    unresolved.push(i.name.clone());
                }
            }
        }
        assert!(
            unresolved.is_empty(),
            "unresolved seed ingredients: {unresolved:?}"
        );
    }

    #[test]
    fn resolution_examples() {
        let c = catalog();
        let cases = [
            ("Сок лайма", "lime juice"),
            ("Lime juice", "lime juice"),
            ("lime", "lime"),
            ("Лайм", "lime"),
            ("Белый ром", "light rum"),
            ("светлый ром", "light rum"),
            ("Rum, light", "light rum"),
            ("Light rum", "light rum"),
            ("Сахарный сироп", "sugar syrup"),
            ("simple syrup", "sugar syrup"),
            ("Тройной сек", "triple sec"),
            ("Трипл сек", "triple sec"),
            ("Просекко", "prosecco"),
            ("Яичный белок", "egg white"),
            ("Яйца", "egg"),
            ("eggs", "egg"),
            ("free-range egg, beaten", "egg"),
            ("Chopped onions", "onion"),
            ("Копчёная паприка", "smoked paprika"),
            ("Сок лайма (свежевыжатый).", "lime juice"),
            ("  ЛЁД ", "ice"),
            ("Cherry tomatoes", "cherry tomatoes"),
        ];
        for (name, key) in cases {
            assert_eq!(c.resolve(name), key, "{name}");
        }
        // Unknown names become their normalised text.
        assert_eq!(c.resolve("  Моя  Особая Настойка! "), "моя особая настойка");
        assert!(!c.contains("моя особая настойка"));
        assert_eq!(c.parent("light rum"), Some("rum"));
        assert_eq!(c.parent("lime juice"), None);
        assert_eq!(c.parent("cherry tomatoes"), Some("tomato"));
    }

    #[test]
    fn normalize_rules() {
        assert_eq!(normalize("  Сок   Лимона "), "сок лимона");
        assert_eq!(normalize("Ёжевика"), "ежевика");
        assert_eq!(normalize("Gin (London dry)"), "gin");
        assert_eq!(normalize("Salt [to taste]."), "salt");
        assert_eq!(normalize("Мята..."), "мята");
        assert_eq!(normalize("()"), "");
        let keys: HashSet<&str> = catalog().entries().iter().map(|e| e.key.as_str()).collect();
        assert!(keys.contains("lime juice"));
    }
}
