//! Immutable component snapshots for WebViews without Service Worker support.
//! This protocol serves registered bytes only; it never resolves a filesystem path.
use celestite_core::error::{EditorError, EditorResult, ErrorCode};
use serde::Deserialize;
use std::{collections::BTreeMap, sync::Mutex};
use tauri::http::{Response, StatusCode};

const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_FILES: usize = 2048;

#[derive(Deserialize)]
pub struct AssetFile {
    path: String,
    data: Vec<u8>,
}

#[derive(Default)]
struct Scope {
    owner: String,
    bundles: BTreeMap<String, BTreeMap<String, Vec<u8>>>,
}
#[derive(Default)]
struct Snapshots {
    scopes: BTreeMap<String, Scope>,
    bytes: usize,
}
#[derive(Default)]
pub struct AssetStore(Mutex<Snapshots>);

fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() < 16 * 1024
        && !path.contains(['\\', '\0'])
        && path.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

impl AssetStore {
    pub fn register(
        &self,
        owner: &str,
        scope: &str,
        digest: &str,
        files: Vec<AssetFile>,
    ) -> EditorResult<()> {
        if scope.is_empty()
            || scope.len() > 64
            || !scope
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
            || digest.len() != 64
            || !digest.bytes().all(|c| c.is_ascii_hexdigit())
            || files.len() > MAX_FILES
        {
            return Err(EditorError::new(
                ErrorCode::InvalidPath,
                "Invalid component snapshot identity",
                "",
            ));
        }
        let mut bundle = BTreeMap::new();
        let mut size = 0usize;
        for file in files {
            if !valid_path(&file.path) || bundle.contains_key(&file.path) {
                return Err(EditorError::new(
                    ErrorCode::InvalidPath,
                    "Invalid component snapshot path",
                    &file.path,
                ));
            }
            size = size.saturating_add(file.data.len());
            if size > MAX_BYTES {
                return Err(EditorError::new(
                    ErrorCode::PreviewLimit,
                    "Component snapshots exceed 64 MiB",
                    "",
                ));
            }
            bundle.insert(file.path, file.data);
        }
        let mut snapshots = self.0.lock().map_err(crate::io_error)?;
        if let Some(existing) = snapshots.scopes.get(scope) {
            if existing.owner != owner {
                return Err(EditorError::new(
                    ErrorCode::PermissionDenied,
                    "Component scope belongs to another window",
                    "",
                ));
            }
            if let Some(previous) = existing.bundles.get(digest) {
                return if previous == &bundle {
                    Ok(())
                } else {
                    Err(EditorError::new(
                        ErrorCode::Conflict,
                        "A component snapshot cannot be replaced",
                        "",
                    ))
                };
            }
        }
        if snapshots.bytes.saturating_add(size) > MAX_BYTES {
            return Err(EditorError::new(
                ErrorCode::PreviewLimit,
                "Component snapshots exceed 64 MiB; reopen the window",
                "",
            ));
        }
        snapshots
            .scopes
            .entry(scope.into())
            .or_insert_with(|| Scope {
                owner: owner.into(),
                bundles: BTreeMap::new(),
            })
            .bundles
            .insert(digest.into(), bundle);
        snapshots.bytes += size;
        Ok(())
    }

    pub fn clear(&self, owner: &str, scope: &str) -> EditorResult<()> {
        let mut snapshots = self.0.lock().map_err(crate::io_error)?;
        if snapshots
            .scopes
            .get(scope)
            .is_some_and(|value| value.owner != owner)
        {
            return Err(EditorError::new(
                ErrorCode::PermissionDenied,
                "Component scope belongs to another window",
                "",
            ));
        }
        if let Some(scope) = snapshots.scopes.remove(scope) {
            snapshots.bytes -= scope
                .bundles
                .values()
                .flat_map(|bundle| bundle.values())
                .map(Vec::len)
                .sum::<usize>();
        }
        Ok(())
    }

    pub fn clear_owner(&self, owner: &str) -> EditorResult<()> {
        let mut snapshots = self.0.lock().map_err(crate::io_error)?;
        let mut released = 0usize;
        snapshots.scopes.retain(|_, scope| {
            if scope.owner == owner {
                released += scope
                    .bundles
                    .values()
                    .flat_map(|bundle| bundle.values())
                    .map(Vec::len)
                    .sum::<usize>();
                false
            } else {
                true
            }
        });
        snapshots.bytes -= released;
        Ok(())
    }

    pub fn response(&self, owner: &str, path: &str) -> Response<Vec<u8>> {
        let found = (|| {
            let decoded = percent_encoding::percent_decode_str(path)
                .decode_utf8()
                .ok()?;
            let mut parts = decoded.trim_start_matches('/').splitn(3, '/');
            let scope = parts.next()?;
            let digest = parts.next()?;
            let name = parts.next()?;
            if !valid_path(name) {
                return None;
            }
            let snapshots = self.0.lock().ok()?;
            let scope = snapshots.scopes.get(scope)?;
            if scope.owner != owner {
                return None;
            }
            let bytes = scope.bundles.get(digest)?.get(name)?.clone();
            Some((media_type(name), bytes))
        })();
        let (status, content_type, data) = match found {
            Some((content_type, data)) => (StatusCode::OK, content_type, data),
            None => (
                StatusCode::NOT_FOUND,
                "text/plain",
                b"Component snapshot unavailable".to_vec(),
            ),
        };
        Response::builder()
            .status(status)
            .header("Content-Type", content_type)
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .body(data)
            .expect("constant response headers are valid")
    }
}

fn media_type(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "wasm" => "application/wasm",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::{AssetFile, AssetStore};
    use celestite_core::error::ErrorCode;
    use tauri::http::StatusCode;

    #[test]
    fn component_urls_preserve_relative_modules_wasm_and_window_isolation() {
        let assets = AssetStore::default();
        let digest = "a".repeat(64);
        let files = || {
            vec![
                AssetFile {
                    path: "packages/库/components/panel/index.js".into(),
                    data: b"import './dep.js'".to_vec(),
                },
                AssetFile {
                    path: "packages/库/components/panel/dep.js".into(),
                    data: b"export default 1".to_vec(),
                },
                AssetFile {
                    path: "packages/库/components/panel/a.wasm".into(),
                    data: b"\0asm".to_vec(),
                },
            ]
        };
        assets.register("main", "scope", &digest, files()).unwrap();
        assets.register("main", "scope", &digest, files()).unwrap();
        let response = assets.response(
            "main",
            &format!("/scope/{digest}/packages/%E5%BA%93/components/panel/a.wasm"),
        );
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "application/wasm");
        assert_eq!(
            assets
                .response(
                    "other",
                    &format!("/scope/{digest}/packages/库/components/panel/index.js")
                )
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            assets
                .register("main", "scope", &digest, vec![])
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert!(
            assets
                .register(
                    "main",
                    "scope",
                    &"b".repeat(64),
                    vec![AssetFile {
                        path: "../secret".into(),
                        data: vec![]
                    }]
                )
                .is_err()
        );
        assets.clear("main", "scope").unwrap();
        assert_eq!(
            assets
                .response(
                    "main",
                    &format!("/scope/{digest}/packages/库/components/panel/index.js")
                )
                .status(),
            StatusCode::NOT_FOUND
        );
        assets
            .register("main", "old-page", &digest, files())
            .unwrap();
        assets
            .register("other", "other-page", &digest, files())
            .unwrap();
        assets.clear_owner("main").unwrap();
        assert_eq!(
            assets
                .response(
                    "main",
                    &format!("/old-page/{digest}/packages/库/components/panel/index.js")
                )
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            assets
                .response(
                    "other",
                    &format!("/other-page/{digest}/packages/库/components/panel/index.js")
                )
                .status(),
            StatusCode::OK
        );
    }
}
