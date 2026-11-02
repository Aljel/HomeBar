//! Application error type: every handler returns `Result<_, AppError>`, which
//! renders as `{ "error": "..." }` with the matching HTTP status.

use axum::Json;
use axum::extract::multipart::MultipartError;
use axum::extract::rejection::{JsonRejection, PathRejection, QueryRejection};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    BadRequest(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("wrong password")]
    WrongPassword,
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    PayloadTooLarge(String),
    #[error("{0}")]
    Upstream(String),
    #[error("{0}")]
    Unavailable(String),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("internal error: {0}")]
    Internal(String),
}

impl AppError {
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::BadRequest(msg.into())
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::NotFound(msg.into())
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self::Internal(msg.into())
    }

    pub fn status(&self) -> StatusCode {
        match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized | Self::WrongPassword => StatusCode::UNAUTHORIZED,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::PayloadTooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Upstream(_) => StatusCode::BAD_GATEWAY,
            Self::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::Database(_) | Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// Message safe to show to clients (internal details are only logged).
    fn public_message(&self) -> String {
        match self {
            Self::Unauthorized => "admin token missing or invalid".to_owned(),
            Self::Database(_) | Self::Internal(_) => "internal server error".to_owned(),
            other => other.to_string(),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status();
        match &self {
            Self::Database(_) | Self::Internal(_) => {
                tracing::error!(error = %self, "request failed")
            }
            Self::Upstream(_) => tracing::warn!(error = %self, "upstream failure"),
            _ => tracing::debug!(error = %self, %status, "request rejected"),
        }
        (status, Json(json!({ "error": self.public_message() }))).into_response()
    }
}

impl From<JsonRejection> for AppError {
    fn from(rej: JsonRejection) -> Self {
        if rej.status() == StatusCode::PAYLOAD_TOO_LARGE {
            return Self::PayloadTooLarge("request body too large".into());
        }
        Self::BadRequest(format!("invalid JSON body: {}", rej.body_text()))
    }
}

impl From<QueryRejection> for AppError {
    fn from(rej: QueryRejection) -> Self {
        Self::BadRequest(format!("invalid query: {}", rej.body_text()))
    }
}

impl From<PathRejection> for AppError {
    fn from(rej: PathRejection) -> Self {
        Self::BadRequest(format!("invalid path parameter: {}", rej.body_text()))
    }
}

impl From<MultipartError> for AppError {
    fn from(err: MultipartError) -> Self {
        if err.status() == StatusCode::PAYLOAD_TOO_LARGE {
            Self::PayloadTooLarge("file too large (max 8 MB)".into())
        } else {
            Self::BadRequest(format!("invalid multipart body: {}", err.body_text()))
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        Self::Internal(format!("json: {err}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        Self::Internal(format!("io: {err}"))
    }
}
