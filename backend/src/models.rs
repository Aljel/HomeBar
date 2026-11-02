//! API data types (camelCase JSON, see docs/API.md) plus input validation.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::macros::format_description;

pub use crate::catalog::Category;
use crate::error::{AppError, AppResult};

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "TEXT", rename_all = "lowercase")]
pub enum Kind {
    Cocktail,
    Dish,
    Other,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "cocktail" => Some(Self::Cocktail),
            "dish" => Some(Self::Dish),
            "other" => Some(Self::Other),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cocktail => "cocktail",
            Self::Dish => "dish",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "TEXT", rename_all = "lowercase")]
pub enum Source {
    Own,
    Thecocktaildb,
    Themealdb,
}

impl Source {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "own" => Some(Self::Own),
            "thecocktaildb" => Some(Self::Thecocktaildb),
            "themealdb" => Some(Self::Themealdb),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Own => "own",
            Self::Thecocktaildb => "thecocktaildb",
            Self::Themealdb => "themealdb",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "TEXT", rename_all = "lowercase")]
pub enum OrderStatus {
    New,
    Making,
    Done,
    Cancelled,
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ingredient {
    pub name: String,
    #[serde(default)]
    pub amount: Option<f64>,
    #[serde(default)]
    pub unit: String,
    #[serde(default)]
    pub note: String,
    /// Canonical ingredient key (read-only: ignored in input, resolved on write).
    #[serde(default, skip_deserializing)]
    pub key: String,
}

impl Ingredient {
    /// Builds an ingredient with its key resolved from the name.
    pub fn new(name: String, amount: Option<f64>, unit: String, note: String) -> Self {
        let key = crate::catalog::catalog().resolve(&name);
        Self {
            name,
            amount,
            unit,
            note,
            key,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recipe {
    pub id: Option<i64>,
    pub title: String,
    pub kind: Kind,
    pub description: String,
    pub instructions: String,
    pub image_url: Option<String>,
    pub servings: f64,
    pub glass: Option<String>,
    pub garnish: Option<String>,
    pub method: Option<String>,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub source: Source,
    pub source_id: Option<String>,
    pub source_url: Option<String>,
    pub parent_id: Option<i64>,
    pub imported_id: Option<i64>,
    pub ingredients: Vec<Ingredient>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeSummary {
    pub id: i64,
    pub title: String,
    pub kind: Kind,
    pub description: String,
    pub image_url: Option<String>,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub source: Source,
    pub parent_id: Option<i64>,
    pub ingredient_names: Vec<String>,
    pub updated_at: String,
}

/// Body for create / update.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeInput {
    pub title: String,
    pub kind: Kind,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub image_url: Option<String>,
    #[serde(default)]
    pub servings: Option<f64>,
    #[serde(default)]
    pub glass: Option<String>,
    #[serde(default)]
    pub garnish: Option<String>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub favorite: Option<bool>,
    #[serde(default)]
    pub ingredients: Option<Vec<Ingredient>>,
    #[serde(default)]
    pub version_note: Option<String>,
}

/// Validated, normalised recipe content (everything the user can edit).
#[derive(Debug, Clone, PartialEq)]
pub struct RecipeData {
    pub title: String,
    pub kind: Kind,
    pub description: String,
    pub instructions: String,
    pub image_url: Option<String>,
    pub servings: f64,
    pub glass: Option<String>,
    pub garnish: Option<String>,
    pub method: Option<String>,
    pub tags: Vec<String>,
    /// `None` keeps the current value on update (false on create).
    pub favorite: Option<bool>,
    pub ingredients: Vec<Ingredient>,
}

pub const MAX_TITLE: usize = 200;
pub const MAX_DESCRIPTION: usize = 2000;
pub const MAX_INSTRUCTIONS: usize = 20_000;
pub const MAX_TAGS: usize = 30;
pub const MAX_TAG_LEN: usize = 40;
pub const MAX_INGREDIENTS: usize = 60;
pub const MAX_SHORT_FIELD: usize = 200;
pub const MAX_INGREDIENT_NOTE: usize = 500;
pub const MAX_UNIT: usize = 40;
pub const MAX_URL: usize = 2048;
const MAX_VERSION_NOTE: usize = 500;
/// Upper bound for `Ingredient.amount`.
pub const MAX_AMOUNT: f64 = 1_000_000.0;

fn char_len(s: &str) -> usize {
    s.chars().count()
}

fn check_len(field: &str, value: &str, max: usize) -> AppResult<()> {
    if char_len(value) > max {
        Err(AppError::bad_request(format!(
            "{field} must be at most {max} characters"
        )))
    } else {
        Ok(())
    }
}

/// Trims an optional string, mapping blank to `None`.
pub fn clean_opt(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

/// Lower-cases, trims, deduplicates (keeping first occurrence) and drops empty tags.
pub fn normalize_tags<I, S>(tags: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag
            .as_ref()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        if !tag.is_empty() && !out.contains(&tag) {
            out.push(tag);
        }
    }
    out
}

pub fn validate_title(title: &str) -> AppResult<String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::bad_request("title is required"));
    }
    check_len("title", title, MAX_TITLE)?;
    Ok(title.to_owned())
}

fn validate_image_url(url: Option<String>) -> AppResult<Option<String>> {
    let Some(url) = clean_opt(url) else {
        return Ok(None);
    };
    check_len("imageUrl", &url, MAX_URL)?;
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") || url.starts_with("/uploads/")
    {
        Ok(Some(url))
    } else {
        Err(AppError::bad_request(
            "imageUrl must be an http(s) URL or an /uploads/ path",
        ))
    }
}

fn validate_ingredients(items: Vec<Ingredient>) -> AppResult<Vec<Ingredient>> {
    let items: Vec<Ingredient> = items
        .into_iter()
        .map(|i| {
            Ingredient::new(
                i.name.trim().to_owned(),
                i.amount,
                i.unit.trim().to_owned(),
                i.note.trim().to_owned(),
            )
        })
        // Blank rows (e.g. an empty line left in the editor) are dropped.
        .filter(|i| !i.name.is_empty())
        .collect();
    if items.len() > MAX_INGREDIENTS {
        return Err(AppError::bad_request(format!(
            "at most {MAX_INGREDIENTS} ingredients allowed"
        )));
    }
    for i in &items {
        check_len("ingredient name", &i.name, MAX_SHORT_FIELD)?;
        check_len("ingredient unit", &i.unit, MAX_UNIT)?;
        check_len("ingredient note", &i.note, MAX_INGREDIENT_NOTE)?;
        if let Some(a) = i.amount
            && (!a.is_finite() || a < 0.0 || a > MAX_AMOUNT)
        {
            return Err(AppError::bad_request(format!(
                "ingredient \"{}\" has an invalid amount",
                i.name
            )));
        }
    }
    Ok(items)
}

pub fn validate_tags(tags: Vec<String>) -> AppResult<Vec<String>> {
    let tags = normalize_tags(tags);
    if tags.len() > MAX_TAGS {
        return Err(AppError::bad_request(format!(
            "at most {MAX_TAGS} tags allowed"
        )));
    }
    if let Some(t) = tags.iter().find(|t| char_len(t) > MAX_TAG_LEN) {
        return Err(AppError::bad_request(format!(
            "tag \"{t}\" is longer than {MAX_TAG_LEN} characters"
        )));
    }
    Ok(tags)
}

impl RecipeInput {
    /// Validates and normalises the input. Returns the content and the version note.
    pub fn validate(self) -> AppResult<(RecipeData, String)> {
        let description = self.description.unwrap_or_default().trim().to_owned();
        check_len("description", &description, MAX_DESCRIPTION)?;
        let instructions = self.instructions.unwrap_or_default().trim().to_owned();
        check_len("instructions", &instructions, MAX_INSTRUCTIONS)?;
        let servings = self.servings.unwrap_or(1.0);
        if !servings.is_finite() || servings <= 0.0 || servings > 1000.0 {
            return Err(AppError::bad_request("servings must be > 0 and <= 1000"));
        }
        let glass = clean_opt(self.glass);
        let garnish = clean_opt(self.garnish);
        let method = clean_opt(self.method);
        for (name, v) in [
            ("glass", &glass),
            ("garnish", &garnish),
            ("method", &method),
        ] {
            if let Some(v) = v {
                check_len(name, v, MAX_SHORT_FIELD)?;
            }
        }
        let note = self.version_note.unwrap_or_default().trim().to_owned();
        check_len("versionNote", &note, MAX_VERSION_NOTE)?;
        let data = RecipeData {
            title: validate_title(&self.title)?,
            kind: self.kind,
            description,
            instructions,
            image_url: validate_image_url(self.image_url)?,
            servings,
            glass,
            garnish,
            method,
            tags: validate_tags(self.tags.unwrap_or_default())?,
            favorite: self.favorite,
            ingredients: validate_ingredients(self.ingredients.unwrap_or_default())?,
        };
        Ok((data, note))
    }
}

impl RecipeData {
    /// Content of an existing recipe (used for fork, restore and import).
    pub fn from_recipe(r: &Recipe) -> Self {
        Self {
            title: r.title.clone(),
            kind: r.kind,
            description: r.description.clone(),
            instructions: r.instructions.clone(),
            image_url: r.image_url.clone(),
            servings: r.servings,
            glass: r.glass.clone(),
            garnish: r.garnish.clone(),
            method: r.method.clone(),
            tags: normalize_tags(&r.tags),
            favorite: Some(r.favorite),
            ingredients: r.ingredients.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeVersionSummary {
    pub id: i64,
    pub recipe_id: i64,
    pub note: String,
    pub title: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeVersion {
    #[serde(flatten)]
    pub summary: RecipeVersionSummary,
    pub recipe: Recipe,
}

// ---------------------------------------------------------------------------
// Menus, orders, pages, meta
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuSummary {
    pub id: i64,
    pub title: String,
    pub description: String,
    pub is_active: bool,
    pub item_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuItem {
    pub recipe_id: i64,
    pub position: i64,
    pub note: String,
    pub recipe: RecipeSummary,
    /// Ingredients not covered by the pantry (empty = can be made now).
    pub missing: Vec<MissingIngredient>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Menu {
    #[serde(flatten)]
    pub summary: MenuSummary,
    pub items: Vec<MenuItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    pub id: i64,
    pub menu_id: Option<i64>,
    pub recipe_id: i64,
    pub recipe_title: String,
    pub guest_name: String,
    pub note: String,
    pub status: OrderStatus,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub slug: String,
    pub title: String,
    pub body: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct TagCount {
    pub tag: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub recipes: i64,
    pub cocktails: i64,
    pub dishes: i64,
    pub favorites: i64,
    pub own: i64,
    pub imported: i64,
    pub orders_today: i64,
}

// ---------------------------------------------------------------------------
// Pantry, availability, settings, library (v2)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MissingIngredient {
    pub key: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogIngredient {
    pub key: String,
    pub name: String,
    pub name_en: String,
    pub category: Category,
    pub in_pantry: bool,
    pub recipe_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PantryItem {
    pub key: String,
    pub name: String,
    pub name_en: String,
    pub category: Category,
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Availability {
    pub recipe: RecipeSummary,
    pub total: usize,
    pub missing: Vec<MissingIngredient>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PantrySuggestion {
    pub key: String,
    pub name: String,
    pub category: Category,
    pub unlocks: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub guest_max_missing: i64,
    pub guest_show_menu: bool,
}

pub const MAX_GUEST_MISSING: i64 = 3;

impl Settings {
    pub fn validate(self) -> AppResult<Self> {
        if !(0..=MAX_GUEST_MISSING).contains(&self.guest_max_missing) {
            return Err(AppError::bad_request(format!(
                "guestMaxMissing must be between 0 and {MAX_GUEST_MISSING}"
            )));
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySyncStatus {
    pub running: bool,
    pub source: Option<Source>,
    pub done: usize,
    pub total: usize,
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub last_error: Option<String>,
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/// Current UTC time as RFC3339 with fixed millisecond precision
/// (fixed width keeps lexical order == chronological order in SQLite).
pub fn now_rfc3339() -> String {
    format_ts(OffsetDateTime::now_utc())
}

pub fn format_ts(t: OffsetDateTime) -> String {
    let fmt =
        format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");
    t.to_offset(time::UtcOffset::UTC)
        .format(&fmt)
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_owned())
}

/// Start of the current UTC day, in the same format as stored timestamps.
pub fn today_start_rfc3339() -> String {
    let now = OffsetDateTime::now_utc();
    format_ts(now.replace_time(time::Time::MIDNIGHT))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_are_normalised() {
        let tags = normalize_tags([" Classic ", "classic", "", "  ", "IBA", "Sour  Mix", "Ром"]);
        assert_eq!(tags, vec!["classic", "iba", "sour mix", "ром"]);
    }

    #[test]
    fn tags_validation_limits() {
        let many: Vec<String> = (0..31).map(|i| format!("t{i}")).collect();
        assert!(validate_tags(many).is_err());
        assert!(validate_tags(vec!["x".repeat(41)]).is_err());
        assert_eq!(validate_tags(vec!["я".repeat(40)]).unwrap().len(), 1);
        // Duplicates collapse before the count limit applies.
        let dupes: Vec<String> = (0..50).map(|_| "Same".to_owned()).collect();
        assert_eq!(validate_tags(dupes).unwrap(), vec!["same"]);
    }

    fn input(title: &str) -> RecipeInput {
        RecipeInput {
            title: title.to_owned(),
            kind: Kind::Cocktail,
            description: None,
            instructions: None,
            image_url: None,
            servings: None,
            glass: Some("  ".into()),
            garnish: None,
            method: None,
            tags: Some(vec!["A".into(), "a".into()]),
            favorite: None,
            ingredients: Some(vec![
                Ingredient::new(" Gin ".into(), Some(30.0), "ml".into(), String::new()),
                Ingredient::new(String::new(), None, String::new(), String::new()),
            ]),
            version_note: None,
        }
    }

    #[test]
    fn recipe_input_defaults_and_cleanup() {
        let (data, note) = input("  Негрони ").validate().unwrap();
        assert_eq!(data.title, "Негрони");
        assert_eq!(data.servings, 1.0);
        assert_eq!(data.glass, None);
        assert_eq!(data.tags, vec!["a"]);
        assert_eq!(data.ingredients.len(), 1);
        assert_eq!(data.ingredients[0].name, "Gin");
        assert_eq!(data.ingredients[0].key, "gin");
        assert_eq!(note, "");
    }

    #[test]
    fn recipe_input_rejects_bad_values() {
        assert!(input("   ").validate().is_err());
        assert!(input(&"x".repeat(201)).validate().is_err());
        let mut i = input("ok");
        i.servings = Some(0.0);
        assert!(i.validate().is_err());
        let mut i = input("ok");
        i.servings = Some(1001.0);
        assert!(i.validate().is_err());
        let mut i = input("ok");
        i.image_url = Some("javascript:alert(1)".into());
        assert!(i.validate().is_err());
        let mut i = input("ok");
        i.ingredients = Some(
            (0..61)
                .map(|n| Ingredient::new(format!("i{n}"), None, String::new(), String::new()))
                .collect(),
        );
        assert!(i.validate().is_err());
    }

    #[test]
    fn timestamps_are_fixed_width() {
        let ts = now_rfc3339();
        assert_eq!(ts.len(), 24, "{ts}");
        assert!(ts.ends_with('Z'));
        assert!(today_start_rfc3339().ends_with("T00:00:00.000Z"));
        assert!(OffsetDateTime::parse(&ts, &time::format_description::well_known::Rfc3339).is_ok());
    }
}
