//! Bulk library sync: imports the whole of TheMealDB / TheCocktailDB in a
//! background task with shared progress status.
//!
//! Politeness: at most [`CONCURRENCY`] requests in flight, a small delay before
//! every request, exponential backoff on 429 / 5xx / network errors. Already
//! imported recipes are skipped, and every recipe is written in its own
//! transaction. The job stops when the server shuts down.

use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::time::Instant;

use futures_util::StreamExt;
use futures_util::stream;
use serde_json::Value;

use crate::catalog::{Category, catalog, normalize};
use crate::error::{AppError, AppResult};
use crate::external::{ExternalError, Upstream, parse_list};
use crate::models::{LibrarySyncStatus, Recipe, Source, now_rfc3339};
use crate::repo;
use crate::state::AppState;

/// Maximum number of upstream requests in flight.
pub const CONCURRENCY: usize = 4;
/// Retries after the first attempt.
const MAX_RETRIES: u32 = 6;
/// Upper bound for a single backoff sleep.
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Upper bound for the adaptive extra delay added after rate limiting.
const MAX_EXTRA_DELAY_MS: u64 = 2_000;

/// Shared status of the (single) sync job.
#[derive(Debug, Default)]
pub struct LibrarySync {
    status: Mutex<LibrarySyncStatus>,
    /// Shared throttle: after a 429 every worker pauses until this instant.
    cooldown_until: Mutex<Option<Instant>>,
    /// Adaptive extra per-request delay (ms): grows on 429, decays on success.
    extra_delay_ms: AtomicU64,
}

impl LibrarySync {
    pub fn status(&self) -> LibrarySyncStatus {
        self.lock().clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, LibrarySyncStatus> {
        // A panic while holding the lock cannot leave the plain-data status
        // inconsistent in a harmful way, so poisoning is ignored.
        self.status.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn cooldown(&self) -> Option<Instant> {
        *self
            .cooldown_until
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// Called on 429: everyone pauses for `pause` and slows down afterwards.
    fn rate_limited(&self, pause: Duration) {
        let until = Instant::now() + pause;
        let mut c = self
            .cooldown_until
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if c.is_none_or(|cur| cur < until) {
            *c = Some(until);
        }
        let extra = self.extra_delay_ms.load(Ordering::Relaxed);
        self.extra_delay_ms.store(
            (extra * 2).clamp(250, MAX_EXTRA_DELAY_MS),
            Ordering::Relaxed,
        );
    }

    fn succeeded(&self) {
        let extra = self.extra_delay_ms.load(Ordering::Relaxed);
        if extra > 0 {
            self.extra_delay_ms
                .store(extra - extra.div_ceil(20), Ordering::Relaxed);
        }
    }

    fn update(&self, f: impl FnOnce(&mut LibrarySyncStatus)) {
        f(&mut self.lock());
    }

    /// Starts a background sync of `sources` (in order). 409 if one is running.
    pub fn start(state: &AppState, sources: Vec<Source>) -> AppResult<LibrarySyncStatus> {
        let snapshot = {
            let mut s = state.library.lock();
            if s.running {
                return Err(AppError::Conflict("library sync is already running".into()));
            }
            state.library.extra_delay_ms.store(0, Ordering::Relaxed);
            *state
                .library
                .cooldown_until
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = None;
            *s = LibrarySyncStatus {
                running: true,
                source: sources.first().copied(),
                started_at: Some(now_rfc3339()),
                ..LibrarySyncStatus::default()
            };
            s.clone()
        };
        let st = state.clone();
        tokio::spawn(async move {
            let mut shutdown = st.shutdown.subscribe();
            let cancelled = tokio::select! {
                () = run(&st, &sources) => false,
                _ = shutdown.wait_for(|stop| *stop) => true,
            };
            st.library.update(|s| {
                s.running = false;
                s.finished_at = Some(now_rfc3339());
                if cancelled {
                    s.last_error = Some("cancelled: server is shutting down".into());
                }
            });
            let s = st.library.status();
            tracing::info!(
                imported = s.imported,
                skipped = s.skipped,
                failed = s.failed,
                cancelled,
                "library sync finished"
            );
        });
        Ok(snapshot)
    }
}

async fn run(st: &AppState, sources: &[Source]) {
    for &source in sources {
        st.library.update(|s| {
            s.source = Some(source);
            s.done = 0;
            s.total = 0;
        });
        tracing::info!(source = source.as_str(), "library sync started");
        let result = match source {
            Source::Themealdb => sync_meals(st).await,
            Source::Thecocktaildb => sync_cocktails(st).await,
            Source::Own => Ok(()),
        };
        if let Err(e) = result {
            tracing::warn!(source = source.as_str(), error = %e, "library sync aborted");
            st.library
                .update(|s| s.last_error = Some(format!("{}: {e}", source.as_str())));
        }
    }
}

/// One upstream GET with polite delay, shared cooldown and retries.
async fn get_json(
    st: &AppState,
    up: Upstream,
    endpoint: &str,
    query: &[(&str, &str)],
) -> Result<Value, ExternalError> {
    let lib = &st.library;
    let mut attempt = 0;
    loop {
        if let Some(until) = lib.cooldown() {
            tokio::time::sleep_until(until).await;
        }
        let extra = Duration::from_millis(lib.extra_delay_ms.load(Ordering::Relaxed));
        tokio::time::sleep(st.config.library_delay + extra).await;
        match st.external.get_json(up, endpoint, query).await {
            Ok(v) => {
                lib.succeeded();
                return Ok(v);
            }
            Err(e) if e.is_retryable() && attempt < MAX_RETRIES => {
                let backoff = (st.config.library_backoff * 2u32.pow(attempt)).min(MAX_BACKOFF);
                tracing::debug!(error = %e, ?backoff, attempt, "upstream request failed, retrying");
                if e.is_rate_limited() {
                    lib.rate_limited(backoff);
                } else {
                    tokio::time::sleep(backoff).await;
                }
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

fn note_error(st: &AppState, msg: String) {
    tracing::warn!(error = %msg, "library sync request failed");
    st.library.update(|s| s.last_error = Some(msg));
}

/// Writes one upstream recipe in its own transaction. `Ok(false)` = already there.
async fn import_one(st: &AppState, source: Source, recipe: &Recipe) -> AppResult<bool> {
    let Some(id) = recipe.source_id.as_deref() else {
        return Err(AppError::internal("upstream recipe without id"));
    };
    let mut tx = crate::db::begin_write(&st.db).await?;
    if repo::find_imported(&mut tx, source, id).await?.is_some() {
        return Ok(false);
    }
    repo::insert_imported(&mut tx, recipe, source, id).await?;
    tx.commit().await?;
    Ok(true)
}

fn record_import(st: &AppState, source: Source, recipe: &Recipe, result: AppResult<bool>) {
    match result {
        Ok(true) => st.library.update(|s| {
            s.imported += 1;
            s.done += 1;
        }),
        Ok(false) => st.library.update(|s| {
            s.skipped += 1;
            s.done += 1;
        }),
        Err(e) => {
            tracing::warn!(source = source.as_str(), title = %recipe.title, error = %e, "import failed");
            st.library.update(|s| {
                s.failed += 1;
                s.done += 1;
                s.last_error = Some(format!("import of \"{}\" failed", recipe.title));
            });
        }
    }
}

async fn existing_ids(st: &AppState, source: Source) -> AppResult<HashSet<String>> {
    let mut conn = st.db.acquire().await?;
    repo::imported_ids(&mut conn, source).await
}

// ---------------------------------------------------------------------------
// TheMealDB: search.php?f=<a..z> returns full meals.
// ---------------------------------------------------------------------------

async fn sync_meals(st: &AppState) -> AppResult<()> {
    let up = Upstream::MealDb;
    let mut pages = stream::iter(('a'..='z').map(String::from))
        .map(|l| {
            let st = st.clone();
            async move {
                let r = get_json(&st, up, "search.php", &[("f", l.as_str())]).await;
                (l, r)
            }
        })
        .buffer_unordered(CONCURRENCY);

    let mut seen = HashSet::new();
    let mut meals: Vec<Recipe> = Vec::new();
    while let Some((letter, result)) = pages.next().await {
        match result.and_then(|body| parse_list(up, &body)) {
            Ok(list) => {
                for r in list {
                    if r.source_id
                        .as_ref()
                        .is_some_and(|id| seen.insert(id.clone()))
                    {
                        meals.push(r);
                    }
                }
            }
            Err(e) => note_error(st, format!("search.php?f={letter}: {e}")),
        }
    }
    drop(pages);

    let existing = existing_ids(st, Source::Themealdb).await?;
    st.library.update(|s| s.total = meals.len());
    for meal in &meals {
        let already = meal
            .source_id
            .as_ref()
            .is_some_and(|id| existing.contains(id));
        let result = if already {
            Ok(false)
        } else {
            import_one(st, Source::Themealdb, meal).await
        };
        record_import(st, Source::Themealdb, meal, result);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// TheCocktailDB: list endpoints are capped at 100 with the free key, so ids
// are collected from many filters and then looked up one by one.
// ---------------------------------------------------------------------------

/// String values of `field` in `{ "drinks": [ {field: ...}, ... ] }`.
fn list_values(body: &Value, field: &str) -> Vec<String> {
    body.get("drinks")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|it| it.get(field))
                .filter_map(|v| match v {
                    Value::String(s) => Some(s.trim().to_owned()),
                    Value::Number(n) => Some(n.to_string()),
                    _ => None,
                })
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Bar ingredients from the catalog worth filtering by.
fn catalog_bar_names() -> Vec<String> {
    catalog()
        .entries()
        .iter()
        .filter(|e| {
            matches!(
                e.category,
                Category::Spirits
                    | Category::Liqueurs
                    | Category::Wine
                    | Category::Beer
                    | Category::Mixers
                    | Category::Juices
                    | Category::Syrups
                    | Category::Bitters
            ) && !e.staple
        })
        .map(|e| normalize(&e.name_en))
        .collect()
}

async fn sync_cocktails(st: &AppState) -> AppResult<()> {
    let up = Upstream::CocktailDb;

    // 1. Filter values.
    let mut lists = Vec::new();
    for (param, field) in [
        ("c", "strCategory"),
        ("g", "strGlass"),
        ("i", "strIngredient1"),
    ] {
        match get_json(st, up, "list.php", &[(param, "list")]).await {
            Ok(body) => lists.push((param, list_values(&body, field))),
            Err(e) => note_error(st, format!("list.php?{param}=list: {e}")),
        }
    }
    let mut filters: Vec<(String, String)> = Vec::new();
    let mut seen_filters = HashSet::new();
    let mut push = |param: &'static str, value: String| {
        if seen_filters.insert((param, value.to_lowercase())) {
            filters.push((param.to_owned(), value));
        }
    };
    push("a", "Alcoholic".into());
    push("a", "Non_Alcoholic".into());
    for (param, values) in lists {
        for v in values {
            push(param, v);
        }
    }
    for name in catalog_bar_names() {
        push("i", name);
    }

    // 2. Collect drink ids.
    let mut ids_stream = stream::iter(filters)
        .map(|(param, value): (String, String)| {
            let st = st.clone();
            async move {
                let r = get_json(&st, up, "filter.php", &[(param.as_str(), value.as_str())]).await;
                (param, value, r)
            }
        })
        .buffer_unordered(CONCURRENCY);
    let mut ids: Vec<String> = Vec::new();
    let mut seen_ids = HashSet::new();
    while let Some((param, value, result)) = ids_stream.next().await {
        match result {
            Ok(body) => {
                for id in list_values(&body, "idDrink") {
                    if id.chars().all(|c| c.is_ascii_digit()) && seen_ids.insert(id.clone()) {
                        ids.push(id);
                    }
                }
            }
            Err(e) => note_error(st, format!("filter.php?{param}={value}: {e}")),
        }
    }
    drop(ids_stream);

    // 3. Look up and import the ones not yet imported.
    let existing = existing_ids(st, Source::Thecocktaildb).await?;
    let (known, todo): (Vec<String>, Vec<String>) =
        ids.into_iter().partition(|id| existing.contains(id));
    st.library.update(|s| {
        s.total = known.len() + todo.len();
        s.skipped += known.len();
        s.done += known.len();
    });
    let mut lookups = stream::iter(todo)
        .map(|id| {
            let st = st.clone();
            async move {
                let r = get_json(&st, up, "lookup.php", &[("i", id.as_str())]).await;
                (id, r)
            }
        })
        .buffer_unordered(CONCURRENCY);
    while let Some((id, result)) = lookups.next().await {
        let drink = result.and_then(|body| {
            if body.is_null() {
                Ok(None)
            } else {
                parse_list(up, &body).map(|l| l.into_iter().next())
            }
        });
        match drink {
            Ok(Some(drink)) => {
                let r = import_one(st, Source::Thecocktaildb, &drink).await;
                record_import(st, Source::Thecocktaildb, &drink, r);
            }
            Ok(None) => st.library.update(|s| {
                s.failed += 1;
                s.done += 1;
                s.last_error = Some(format!("drink {id} not found upstream"));
            }),
            Err(e) => {
                note_error(st, format!("lookup.php?i={id}: {e}"));
                st.library.update(|s| {
                    s.failed += 1;
                    s.done += 1;
                });
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn list_values_handles_odd_shapes() {
        let body =
            json!({ "drinks": [{ "idDrink": "1" }, { "idDrink": 2 }, { "idDrink": null }, {}] });
        assert_eq!(list_values(&body, "idDrink"), vec!["1", "2"]);
        assert!(list_values(&json!({ "drinks": "None Found" }), "idDrink").is_empty());
        assert!(list_values(&Value::Null, "idDrink").is_empty());
    }

    #[test]
    fn catalog_bar_names_are_plain() {
        let names = catalog_bar_names();
        assert!(names.contains(&"gin".to_owned()));
        assert!(!names.iter().any(|n| n.contains('(') || n == "ice"));
    }
}
