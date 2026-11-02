//! Runtime configuration read from environment variables (see docs/API.md).

use std::path::PathBuf;
use std::time::Duration;

pub const DEFAULT_ADMIN_PASSWORD: &str = "homebar";
pub const COCKTAILDB_BASE: &str = "https://www.thecocktaildb.com/api/json/v1/1/";
pub const MEALDB_BASE: &str = "https://www.themealdb.com/api/json/v1/1/";

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub data_dir: PathBuf,
    pub static_dir: PathBuf,
    pub admin_password: String,
    pub external_timeout: Duration,
    pub discover_enabled: bool,
    /// Base URL of TheCocktailDB JSON API (overridable for tests).
    pub cocktaildb_base: String,
    /// Base URL of TheMealDB JSON API (overridable for tests).
    pub mealdb_base: String,
    /// Polite pause before each library-sync request (`LIBRARY_SYNC_DELAY_MS`).
    pub library_delay: Duration,
    /// First retry backoff of library sync, doubled per attempt (`LIBRARY_SYNC_BACKOFF_MS`).
    pub library_backoff: Duration,
}

impl Config {
    /// Reads the configuration from the process environment, falling back to
    /// the documented defaults for missing or unparsable values.
    pub fn from_env() -> Self {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// Builds the configuration from an arbitrary key lookup (testable).
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Self {
        let get = |key: &str| {
            get(key)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        // A typo must not silently become the default: say what was ignored.
        let invalid = |key: &str, value: &str, default: &str| {
            tracing::warn!(%key, %value, %default, "invalid value ignored, using default");
        };
        let port = get("PORT")
            .and_then(|v| {
                let parsed = v.parse::<u16>().ok().filter(|p| *p > 0);
                if parsed.is_none() {
                    invalid("PORT", &v, "8080");
                }
                parsed
            })
            .unwrap_or(8080);
        let timeout_secs = get("EXTERNAL_TIMEOUT_SECS")
            .and_then(|v| {
                let parsed = v.parse::<u64>().ok().filter(|s| (1..=300).contains(s));
                if parsed.is_none() {
                    invalid("EXTERNAL_TIMEOUT_SECS", &v, "8");
                }
                parsed
            })
            .unwrap_or(8);
        let discover_enabled = get("DISCOVER_ENABLED")
            .map(|v| match v.to_ascii_lowercase().as_str() {
                "false" | "0" | "no" | "off" => false,
                "true" | "1" | "yes" | "on" => true,
                _ => {
                    invalid("DISCOVER_ENABLED", &v, "true");
                    true
                }
            })
            .unwrap_or(true);
        let millis = |key: &str, default: u64| {
            get(key)
                .and_then(|v| {
                    let parsed = v.parse::<u64>().ok().filter(|ms| *ms <= 60_000);
                    if parsed.is_none() {
                        invalid(key, &v, &default.to_string());
                    }
                    parsed
                })
                .unwrap_or(default)
        };
        let library_delay = Duration::from_millis(millis("LIBRARY_SYNC_DELAY_MS", 120));
        let library_backoff = Duration::from_millis(millis("LIBRARY_SYNC_BACKOFF_MS", 500));
        Self {
            port,
            data_dir: PathBuf::from(get("DATA_DIR").unwrap_or_else(|| "./data".into())),
            static_dir: PathBuf::from(get("STATIC_DIR").unwrap_or_else(|| "./static".into())),
            // The password itself is not trimmed-away to empty: an empty value means default.
            admin_password: get("ADMIN_PASSWORD").unwrap_or_else(|| DEFAULT_ADMIN_PASSWORD.into()),
            external_timeout: Duration::from_secs(timeout_secs),
            discover_enabled,
            cocktaildb_base: get("COCKTAILDB_BASE_URL").unwrap_or_else(|| COCKTAILDB_BASE.into()),
            mealdb_base: get("MEALDB_BASE_URL").unwrap_or_else(|| MEALDB_BASE.into()),
            library_delay,
            library_backoff,
        }
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("homebar.db")
    }

    pub fn uploads_dir(&self) -> PathBuf {
        self.data_dir.join("uploads")
    }

    pub fn uses_default_password(&self) -> bool {
        self.admin_password == DEFAULT_ADMIN_PASSWORD
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cfg(pairs: &[(&str, &str)]) -> Config {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        Config::from_lookup(|k| map.get(k).cloned())
    }

    #[test]
    fn defaults_match_contract() {
        let c = cfg(&[]);
        assert_eq!(c.port, 8080);
        assert_eq!(c.data_dir, PathBuf::from("./data"));
        assert_eq!(c.static_dir, PathBuf::from("./static"));
        assert_eq!(c.admin_password, "homebar");
        assert!(c.uses_default_password());
        assert_eq!(c.external_timeout, Duration::from_secs(8));
        assert!(c.discover_enabled);
        assert_eq!(c.library_delay, Duration::from_millis(120));
        assert_eq!(c.library_backoff, Duration::from_millis(500));
    }

    #[test]
    fn overrides_are_parsed() {
        let c = cfg(&[
            ("PORT", "9000"),
            ("DISCOVER_ENABLED", "false"),
            ("EXTERNAL_TIMEOUT_SECS", "3"),
            ("ADMIN_PASSWORD", "secret"),
        ]);
        assert_eq!(c.port, 9000);
        assert!(!c.discover_enabled);
        assert_eq!(c.external_timeout, Duration::from_secs(3));
        assert!(!c.uses_default_password());
    }

    #[test]
    fn invalid_values_fall_back_to_defaults() {
        let c = cfg(&[
            ("PORT", "80a"),
            ("EXTERNAL_TIMEOUT_SECS", "0"),
            ("DISCOVER_ENABLED", "flase"),
        ]);
        assert_eq!(c.port, 8080);
        assert_eq!(c.external_timeout, Duration::from_secs(8));
        assert!(c.discover_enabled);
    }
}
