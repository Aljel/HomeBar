//! Shared application state handed to every handler.

use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::sync::{Mutex, broadcast, watch};

use crate::auth::derive_token;
use crate::config::Config;
use crate::external::ExternalClient;
use crate::library::LibrarySync;
use crate::models::Order;
use crate::pantry::RecipeIndex;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub config: Arc<Config>,
    pub admin_token: Arc<str>,
    pub external: ExternalClient,
    pub orders_tx: broadcast::Sender<Order>,
    /// Flipped to `true` on shutdown so long-lived SSE streams end and the
    /// graceful shutdown can complete.
    pub shutdown: Arc<watch::Sender<bool>>,
    /// Serialises login attempts so failed ones can be rate limited globally.
    pub login_gate: Arc<Mutex<()>>,
    /// Background bulk-import job status.
    pub library: Arc<LibrarySync>,
    /// Cached recipe summaries + ingredient keys for availability ranking.
    pub recipe_index: Arc<RecipeIndex>,
}

impl AppState {
    pub fn new(db: SqlitePool, config: Config) -> Result<Self, reqwest::Error> {
        let http = reqwest::Client::builder()
            .timeout(config.external_timeout)
            .connect_timeout(config.external_timeout)
            .user_agent(concat!("HomeBar/", env!("CARGO_PKG_VERSION")))
            .build()?;
        let (orders_tx, _) = broadcast::channel(128);
        let (shutdown, _) = watch::channel(false);
        Ok(Self {
            db,
            admin_token: derive_token(&config.admin_password).into(),
            external: ExternalClient::new(http, &config.cocktaildb_base, &config.mealdb_base),
            config: Arc::new(config),
            orders_tx,
            shutdown: Arc::new(shutdown),
            login_gate: Arc::new(Mutex::new(())),
            library: Arc::new(LibrarySync::default()),
            recipe_index: Arc::new(RecipeIndex::default()),
        })
    }

    /// Signals all SSE streams to finish.
    pub fn trigger_shutdown(&self) {
        self.shutdown.send_replace(true);
    }
}
