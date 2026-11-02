//! `POST /api/uploads` — image upload with magic-byte sniffing.

use axum::extract::{DefaultBodyLimit, Multipart, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::auth::Admin;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub const MAX_UPLOAD_BYTES: usize = 8 * 1024 * 1024;
/// Allowance for multipart boundaries and headers on top of the file itself.
const MULTIPART_OVERHEAD: usize = 64 * 1024;

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/uploads",
        post(upload).layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD)),
    )
}

/// Detects the image type from magic bytes; returns the file extension.
pub fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("png");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    // ISO-BMFF: [size:4]["ftyp"][major brand:4][minor:4][compatible brands...]
    if bytes.len() >= 16 && &bytes[4..8] == b"ftyp" {
        let box_len = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        let end = box_len.clamp(16, bytes.len().min(256));
        let is_avif = |brand: &[u8]| brand == b"avif" || brand == b"avis";
        if is_avif(&bytes[8..12]) || bytes[16..end].as_chunks::<4>().0.iter().any(|b| is_avif(b)) {
            return Some("avif");
        }
    }
    None
}

async fn upload(
    _: Admin,
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> AppResult<(StatusCode, Json<Value>)> {
    while let Some(field) = multipart.next_field().await? {
        if field.name() != Some("file") {
            continue;
        }
        let bytes = field.bytes().await?;
        if bytes.is_empty() {
            return Err(AppError::bad_request("file is empty"));
        }
        if bytes.len() > MAX_UPLOAD_BYTES {
            return Err(AppError::PayloadTooLarge(
                "file too large (max 8 MB)".into(),
            ));
        }
        let ext = sniff_image(&bytes).ok_or_else(|| {
            AppError::bad_request("unsupported file type (jpeg, png, webp, gif or avif expected)")
        })?;
        let dir = state.config.uploads_dir();
        tokio::fs::create_dir_all(&dir).await?;
        let name = format!("{}.{ext}", uuid::Uuid::new_v4());
        tokio::fs::write(dir.join(&name), &bytes).await?;
        tracing::info!(file = %name, size = bytes.len(), "image uploaded");
        return Ok((
            StatusCode::CREATED,
            Json(json!({ "url": format!("/uploads/{name}") })),
        ));
    }
    Err(AppError::bad_request(
        "multipart field \"file\" is required",
    ))
}

#[cfg(test)]
mod tests {
    use super::sniff_image;

    #[test]
    fn sniffs_known_formats() {
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]), Some("jpg"));
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\n...."), Some("png"));
        assert_eq!(sniff_image(b"GIF89a......"), Some("gif"));
        assert_eq!(sniff_image(b"RIFF\x10\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(
            sniff_image(b"\0\0\0\x1cftypavif\0\0\0\0avifmif1miaf"),
            Some("avif")
        );
        assert_eq!(
            sniff_image(b"\0\0\0\x1cftypmif1\0\0\0\0mif1avifmiaf"),
            Some("avif")
        );
    }

    #[test]
    fn rejects_others() {
        assert_eq!(sniff_image(b"<svg xmlns="), None);
        assert_eq!(sniff_image(b"%PDF-1.7"), None);
        assert_eq!(sniff_image(b"\0\0\0\x18ftypmp42\0\0\0\0isom"), None);
        assert_eq!(sniff_image(b""), None);
    }
}
