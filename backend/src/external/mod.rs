//! Clients for TheCocktailDB / TheMealDB and mapping into our `Recipe` shape.

pub mod cocktaildb;
pub mod mealdb;
pub mod measure;

use serde_json::{Map, Value};

use crate::models::{
    Ingredient, Kind, MAX_DESCRIPTION, MAX_INGREDIENT_NOTE, MAX_INGREDIENTS, MAX_INSTRUCTIONS,
    MAX_SHORT_FIELD, MAX_TAG_LEN, MAX_TAGS, MAX_TITLE, MAX_UNIT, MAX_URL, Recipe, Source,
};

#[derive(Debug, thiserror::Error)]
pub enum ExternalError {
    #[error("request to {source_name} failed: {err}")]
    Http {
        source_name: &'static str,
        err: reqwest::Error,
    },
    #[error("{0} returned an unexpected response")]
    Decode(&'static str),
}

impl ExternalError {
    /// HTTP 429 from upstream.
    pub fn is_rate_limited(&self) -> bool {
        matches!(self, Self::Http { err, .. } if err.status().is_some_and(|s| s.as_u16() == 429))
    }

    /// Worth retrying: rate limiting, server errors, timeouts and connection failures.
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Http { err, .. } => match err.status() {
                Some(s) => s.as_u16() == 429 || s.is_server_error(),
                None => err.is_timeout() || err.is_connect() || err.is_request(),
            },
            Self::Decode(_) => false,
        }
    }
}

/// Which upstream API to use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Upstream {
    CocktailDb,
    MealDb,
}

impl Upstream {
    pub fn for_kind(kind: Kind) -> Option<Self> {
        match kind {
            Kind::Cocktail => Some(Self::CocktailDb),
            Kind::Dish => Some(Self::MealDb),
            Kind::Other => None,
        }
    }

    pub fn for_source(source: Source) -> Option<Self> {
        match source {
            Source::Thecocktaildb => Some(Self::CocktailDb),
            Source::Themealdb => Some(Self::MealDb),
            Source::Own => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::CocktailDb => "TheCocktailDB",
            Self::MealDb => "TheMealDB",
        }
    }

    /// JSON key holding the result array.
    pub fn list_key(self) -> &'static str {
        match self {
            Self::CocktailDb => "drinks",
            Self::MealDb => "meals",
        }
    }

    fn map(self, item: &Map<String, Value>) -> Option<Recipe> {
        let recipe = match self {
            Self::CocktailDb => cocktaildb::map_drink(item),
            Self::MealDb => mealdb::map_meal(item),
        };
        if recipe.is_none() {
            tracing::debug!(
                upstream = self.name(),
                "skipping upstream item without id/title"
            );
        }
        recipe.map(fit_to_limits)
    }
}

/// Thin client over a shared `reqwest::Client` and configurable base URLs.
#[derive(Clone)]
pub struct ExternalClient {
    http: reqwest::Client,
    cocktaildb_base: String,
    mealdb_base: String,
}

impl ExternalClient {
    pub fn new(http: reqwest::Client, cocktaildb_base: &str, mealdb_base: &str) -> Self {
        let norm = |b: &str| {
            if b.ends_with('/') {
                b.to_owned()
            } else {
                format!("{b}/")
            }
        };
        Self {
            http,
            cocktaildb_base: norm(cocktaildb_base),
            mealdb_base: norm(mealdb_base),
        }
    }

    fn base(&self, up: Upstream) -> &str {
        match up {
            Upstream::CocktailDb => &self.cocktaildb_base,
            Upstream::MealDb => &self.mealdb_base,
        }
    }

    /// GETs `<base><endpoint>?<query>` and parses the JSON body. Both APIs
    /// answer some misses (e.g. lookup of an unknown id) with an empty 200 body
    /// instead of `{"drinks": null}`: that becomes `Value::Null`.
    pub async fn get_json(
        &self,
        up: Upstream,
        endpoint: &str,
        query: &[(&str, &str)],
    ) -> Result<Value, ExternalError> {
        let http_err = |err| ExternalError::Http {
            source_name: up.name(),
            err,
        };
        let url = format!("{}{endpoint}", self.base(up));
        let text = self
            .http
            .get(url)
            .query(query)
            .send()
            .await
            .map_err(http_err)?
            .error_for_status()
            .map_err(http_err)?
            .text()
            .await
            .map_err(http_err)?;
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|e| {
            tracing::warn!(upstream = up.name(), error = %e, "upstream sent invalid JSON");
            ExternalError::Decode(up.name())
        })
    }

    async fn fetch(
        &self,
        up: Upstream,
        endpoint: &str,
        query: &[(&str, &str)],
    ) -> Result<Vec<Recipe>, ExternalError> {
        let body = self.get_json(up, endpoint, query).await?;
        if body.is_null() {
            return Ok(Vec::new());
        }
        parse_list(up, &body)
    }

    pub async fn random(&self, up: Upstream) -> Result<Option<Recipe>, ExternalError> {
        Ok(self.fetch(up, "random.php", &[]).await?.into_iter().next())
    }

    pub async fn search(&self, up: Upstream, q: &str) -> Result<Vec<Recipe>, ExternalError> {
        self.fetch(up, "search.php", &[("s", q)]).await
    }

    pub async fn lookup(&self, up: Upstream, id: &str) -> Result<Option<Recipe>, ExternalError> {
        Ok(self
            .fetch(up, "lookup.php", &[("i", id)])
            .await?
            .into_iter()
            .next())
    }
}

/// Parses `{ "drinks": [...] }` / `{ "meals": [...] }`. A `null` or string
/// value (e.g. "no data found") means no results.
pub fn parse_list(up: Upstream, body: &Value) -> Result<Vec<Recipe>, ExternalError> {
    let obj = body.as_object().ok_or(ExternalError::Decode(up.name()))?;
    match obj.get(up.list_key()) {
        Some(Value::Array(items)) => Ok(items
            .iter()
            .filter_map(Value::as_object)
            .filter_map(|item| up.map(item))
            .collect()),
        _ => Ok(Vec::new()),
    }
}

fn truncate_chars(s: &mut String, max: usize) {
    if let Some((idx, _)) = s.char_indices().nth(max) {
        s.truncate(idx);
    }
}

fn truncate_opt(s: &mut Option<String>, max: usize) {
    if let Some(v) = s {
        truncate_chars(v, max);
    }
}

/// Clamps upstream data to the limits enforced on `RecipeInput`, so an
/// imported (or forked) recipe can be edited and saved back without a 400.
pub(crate) fn fit_to_limits(mut r: Recipe) -> Recipe {
    truncate_chars(&mut r.title, MAX_TITLE);
    truncate_chars(&mut r.description, MAX_DESCRIPTION);
    truncate_chars(&mut r.instructions, MAX_INSTRUCTIONS);
    truncate_opt(&mut r.glass, MAX_SHORT_FIELD);
    truncate_opt(&mut r.garnish, MAX_SHORT_FIELD);
    truncate_opt(&mut r.method, MAX_SHORT_FIELD);
    // Only http(s) images are accepted on save; anything else is dropped.
    r.image_url = r.image_url.filter(|u| {
        let lower = u.to_ascii_lowercase();
        u.chars().count() <= MAX_URL
            && (lower.starts_with("https://") || lower.starts_with("http://"))
    });
    r.tags.retain(|t| t.chars().count() <= MAX_TAG_LEN);
    r.tags.truncate(MAX_TAGS);
    r.ingredients.truncate(MAX_INGREDIENTS);
    for i in &mut r.ingredients {
        truncate_chars(&mut i.name, MAX_SHORT_FIELD);
        i.key = crate::catalog::catalog().resolve(&i.name);
        truncate_chars(&mut i.unit, MAX_UNIT);
        truncate_chars(&mut i.note, MAX_INGREDIENT_NOTE);
    }
    r
}

/// Non-empty trimmed string field (numbers are accepted and stringified,
/// in case an upstream ever sends ids as JSON numbers).
pub(crate) fn field(item: &Map<String, Value>, key: &str) -> Option<String> {
    match item.get(key)? {
        Value::String(s) => Some(s.trim()).filter(|s| !s.is_empty()).map(str::to_owned),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Collects `strIngredientN` / `strMeasureN` pairs (N = 1..=max) into ingredients.
pub(crate) fn collect_ingredients(item: &Map<String, Value>, max: usize) -> Vec<Ingredient> {
    (1..=max)
        .filter_map(|n| {
            let name = field(item, &format!("strIngredient{n}"))?;
            let raw = field(item, &format!("strMeasure{n}")).unwrap_or_default();
            let m = measure::parse_measure(&raw);
            Some(Ingredient::new(name, m.amount, m.unit, m.note))
        })
        .collect()
}

/// Upstream instructions use CRLF and single line breaks; turn them into
/// markdown paragraphs.
pub(crate) fn instructions_to_markdown(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Splits a comma-separated upstream tag list.
pub(crate) fn split_tags(tags: Option<String>) -> Vec<String> {
    tags.map(|t| {
        t.split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    })
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numeric_ids_and_oversized_fields_are_handled() {
        let long_tag = "x".repeat(MAX_TAG_LEN + 1);
        let many_tags: Vec<String> = (0..40).map(|i| format!("t{i}")).collect();
        let body = json!({ "drinks": [{
            "idDrink": 11007,
            "strDrink": "y".repeat(MAX_TITLE + 50),
            "strTags": format!("{long_tag},{}", many_tags.join(",")),
            "strDrinkThumb": "ftp://example.com/a.jpg",
            "strIngredient1": "Gin", "strMeasure1": "1 oz",
        }]});
        let r = parse_list(Upstream::CocktailDb, &body).unwrap().remove(0);
        assert_eq!(r.source_id.as_deref(), Some("11007"));
        assert_eq!(r.title.chars().count(), MAX_TITLE);
        assert_eq!(r.tags.len(), MAX_TAGS);
        assert!(!r.tags.contains(&long_tag));
        assert_eq!(r.image_url, None);
        assert_eq!(r.ingredients.len(), 1);
    }
}
