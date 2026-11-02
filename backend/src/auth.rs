//! Host (admin) authentication.
//!
//! The token is `hex(HMAC-SHA256(key = ADMIN_PASSWORD, msg = "homebar-admin-v1"))`,
//! so it is deterministic and survives restarts. All comparisons are constant time.

use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::error::AppError;
use crate::state::AppState;

const TOKEN_MESSAGE: &[u8] = b"homebar-admin-v1";

/// Derives the admin token for a password.
pub fn derive_token(password: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(password.as_bytes())
        .expect("HMAC accepts keys of any length");
    mac.update(TOKEN_MESSAGE);
    hex::encode(mac.finalize().into_bytes())
}

/// Constant-time token comparison.
pub fn token_matches(expected: &str, candidate: &str) -> bool {
    expected.as_bytes().ct_eq(candidate.as_bytes()).into()
}

/// Checks a login password by deriving its token and comparing in constant time.
pub fn password_matches(expected_token: &str, password: &str) -> bool {
    token_matches(expected_token, &derive_token(password))
}

/// Extracts the bearer token from an `Authorization` header value.
pub fn bearer_token(parts: &Parts) -> Option<&str> {
    let value = parts.headers.get(AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.trim().split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| token.trim())
        .filter(|t| !t.is_empty())
}

pub fn is_admin(state: &AppState, parts: &Parts) -> bool {
    bearer_token(parts).is_some_and(|t| token_matches(&state.admin_token, t))
}

/// Guard extractor for admin-only handlers: rejects with 401 unless the request
/// carries a valid `Authorization: Bearer <token>` header.
#[derive(Debug, Clone, Copy)]
pub struct Admin;

impl FromRequestParts<AppState> for Admin {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if is_admin(state, parts) {
            Ok(Admin)
        } else {
            Err(AppError::Unauthorized)
        }
    }
}

/// Non-failing variant: tells whether the caller is the host.
#[derive(Debug, Clone, Copy)]
pub struct MaybeAdmin(pub bool);

impl FromRequestParts<AppState> for MaybeAdmin {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        Ok(MaybeAdmin(is_admin(state, parts)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;

    #[test]
    fn token_is_deterministic_hex_sha256() {
        let a = derive_token("homebar");
        assert_eq!(a, derive_token("homebar"));
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, derive_token("homebar2"));
    }

    #[test]
    fn token_matches_known_vector() {
        // Independent check: HMAC-SHA256(key="key", msg="homebar-admin-v1") computed via the
        // same primitive, guarding against accidental key/message swaps.
        let mut mac = Hmac::<Sha256>::new_from_slice(b"key").unwrap();
        mac.update(b"homebar-admin-v1");
        assert_eq!(
            derive_token("key"),
            hex::encode(mac.finalize().into_bytes())
        );
        let mut swapped = Hmac::<Sha256>::new_from_slice(b"homebar-admin-v1").unwrap();
        swapped.update(b"key");
        assert_ne!(
            derive_token("key"),
            hex::encode(swapped.finalize().into_bytes())
        );
    }

    #[test]
    fn comparisons() {
        let t = derive_token("pw");
        assert!(token_matches(&t, &t));
        assert!(!token_matches(&t, &t[..63]));
        assert!(!token_matches(&t, ""));
        assert!(password_matches(&t, "pw"));
        assert!(!password_matches(&t, "PW"));
    }

    #[test]
    fn bearer_parsing() {
        let (parts, _) = Request::builder()
            .header("Authorization", "Bearer abc ")
            .body(())
            .unwrap()
            .into_parts();
        assert_eq!(bearer_token(&parts), Some("abc"));
        let (parts, _) = Request::builder()
            .header("Authorization", "Basic abc")
            .body(())
            .unwrap()
            .into_parts();
        assert_eq!(bearer_token(&parts), None);
        let (parts, _) = Request::builder().body(()).unwrap().into_parts();
        assert_eq!(bearer_token(&parts), None);
    }
}
