//! HTTP and watch integration for the shared read-only package grant policy.
use crate::vault::changes::ChangeHint;
use crate::{ApiError, RemoteAccess, ServerState};
use axum::{routing::post, Extension, Json, Router};
use celestite_core::error::{EditorError, EditorResult, ErrorCode};
use celestite_core::fs::FileEntry;
use celestite_core::preview::native::{
    Context, PackageGrant, PackageResources as NativePackageResources,
};
use celestite_core::preview::{PreviewResource, PreviewResourceRequest};
use notify::{RecursiveMode, Watcher};
use serde::Deserialize;
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::broadcast;

#[derive(Deserialize)]
struct ReadRequest {
    context: Context,
    request: PreviewResourceRequest,
}
#[derive(Deserialize)]
struct DirectoryRequest {
    context: Context,
    path: String,
}
struct Watches {
    watcher: notify::RecommendedWatcher,
    paths: BTreeSet<PathBuf>,
}
pub(crate) struct PackageResources {
    pub(crate) resources: NativePackageResources,
    watches: Mutex<Watches>,
}
impl PackageResources {
    pub fn new(
        root: PathBuf,
        events: broadcast::Sender<ChangeHint>,
    ) -> Result<Self, notify::Error> {
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            if !matches!(event, Ok(ref event) if event.kind.is_access()) {
                let _ = events.send(ChangeHint::all());
            }
        })?;
        Ok(Self {
            resources: NativePackageResources::new(root),
            watches: Mutex::new(Watches {
                watcher,
                paths: BTreeSet::new(),
            }),
        })
    }
    fn grant(&self, context: &Context) -> EditorResult<PackageGrant> {
        let grant = self.resources.grant(context)?;
        let mut watches = self
            .watches
            .lock()
            .map_err(|_| EditorError::new(ErrorCode::Io, "Package watcher lock failed", ""))?;
        for root in grant.roots() {
            if root.starts_with(&self.resources.root) {
                continue;
            }
            let mut ancestor = root.as_path();
            while !ancestor.is_dir() {
                let Some(parent) = ancestor.parent() else {
                    break;
                };
                ancestor = parent;
            }
            for (path, mode) in [
                (ancestor.to_owned(), RecursiveMode::NonRecursive),
                (root.join("components"), RecursiveMode::Recursive),
            ] {
                if !path.is_dir() || watches.paths.contains(&path) {
                    continue;
                }
                if watches.paths.len() >= 2048 {
                    return Err(EditorError::new(
                        ErrorCode::Unsupported,
                        "Too many package resource directories",
                        "",
                    ));
                }
                watches
                    .watcher
                    .watch(&path, mode)
                    .map_err(|error| EditorError::new(ErrorCode::Io, error.to_string(), ""))?;
                watches.paths.insert(path);
            }
        }
        Ok(grant)
    }
    #[cfg(test)]
    fn packages(&self, context: &Context) -> EditorResult<BTreeSet<PathBuf>> {
        Ok(self.grant(context)?.roots().clone())
    }
    fn read(&self, input: ReadRequest) -> EditorResult<PreviewResource> {
        self.grant(&input.context)?.read(input.request)
    }
    fn directory(&self, input: DirectoryRequest) -> EditorResult<Vec<FileEntry>> {
        self.grant(&input.context)?.directory(&input.path)
    }
}
pub(crate) fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route("/{id}/api/v5/preview/resources", post(read))
        .route("/{id}/api/v5/preview/directory", post(directory))
}
async fn read(
    Extension(access): Extension<RemoteAccess>,
    Json(input): Json<ReadRequest>,
) -> Result<Json<PreviewResource>, ApiError> {
    let vault = access.grant.vault.clone();
    tokio::task::spawn_blocking(move || vault.packages.read(input))
        .await
        .map_err(|_| crate::failure(ErrorCode::Io, "Package IO failed"))?
        .map(Json)
        .map_err(Into::into)
}
async fn directory(
    Extension(access): Extension<RemoteAccess>,
    Json(input): Json<DirectoryRequest>,
) -> Result<Json<Vec<FileEntry>>, ApiError> {
    let vault = access.grant.vault.clone();
    tokio::task::spawn_blocking(move || vault.packages.directory(input))
        .await
        .map_err(|_| crate::failure(ErrorCode::Io, "Package IO failed"))?
        .map(Json)
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::{Context, PackageResources};
    use crate::testing::Host;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use std::collections::BTreeMap;
    use tokio::sync::broadcast;
    use tower::ServiceExt;

    async fn call(
        router: &Host,
        route: &str,
        input: serde_json::Value,
    ) -> axum::response::Response {
        router
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(router.uri(&format!("/preview/{route}")))
                    .header("content-type", "application/json")
                    .body(Body::from(input.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }
    #[tokio::test]
    async fn sibling_packages_use_notist_configuration_and_stay_out_of_document_history() {
        let repository = tempfile::tempdir().unwrap();
        // Requests use the same canonical identities exposed by the server;
        // macOS temporary paths commonly pass through the /var symlink.
        let repository_root = repository.path().canonicalize().unwrap();
        let root = repository_root.join("docs");
        let package = repository_root.join("packages/widgets");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(package.join("components/panel")).unwrap();
        std::fs::write(
            root.join("Notist.toml"),
            "[dependencies]\nwidgets = {path = '../packages/widgets'}",
        )
        .unwrap();
        std::fs::write(root.join("a.not"), "#widgets::panel()[body]").unwrap();
        std::fs::write(
            package.join("Notist.toml"),
            "[package]\nname = 'widgets'\n[dependencies]\nkatex = {path = '../katex'}\n",
        )
        .unwrap();
        let transitive = repository_root.join("packages/katex");
        std::fs::create_dir_all(&transitive).unwrap();
        std::fs::write(
            transitive.join("Notist.toml"),
            "[package]\nname = 'katex'\n",
        )
        .unwrap();
        std::fs::write(
            transitive.join("lib.notc"),
            "fn math(text: String) -> InlineContent;",
        )
        .unwrap();
        std::fs::write(
            package.join("lib.notc"),
            "fn panel()[children: Content] -> Content;",
        )
        .unwrap();
        std::fs::write(
            package.join("components/panel/index.js"),
            "export default class extends HTMLElement {}",
        )
        .unwrap();
        std::fs::write(package.join("private.txt"), "not a component").unwrap();
        let config = crate::Config {
            server: crate::ServerConfig::default(),
            vault: crate::VaultConfig {
                name: "Docs".into(),
                path: root.clone(),
                ..Default::default()
            },
        };
        let router = Host::new(crate::build_server(config, &repository_root).unwrap());
        let context = serde_json::json!({"documentPath": "a.not", "overlays": {}});
        let declaration = call(&router, "resources", serde_json::json!({"context":context, "request":{"path":package.join("lib.notc"), "read":true}})).await;
        assert_eq!(declaration.status(), StatusCode::OK);
        let data: serde_json::Value =
            serde_json::from_slice(&declaration.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(data["kind"], "file");
        assert!(!data["data"].as_array().unwrap().is_empty());
        let manifest = call(&router, "resources", serde_json::json!({"context":context, "request":{"path":transitive.join("Notist.toml"), "read":true}})).await;
        assert_eq!(manifest.status(), StatusCode::OK);
        // Resource grants must follow the exact manifest snapshot used by the Worker.
        let snapshot = serde_json::json!({"documentPath":"a.not", "overlays":{package.join("Notist.toml").to_str().unwrap(): "[package]\nname = 'widgets'\n"}});
        let revoked = call(&router, "resources", serde_json::json!({"context":snapshot, "request":{"path":transitive.join("lib.notc"),"read":true}})).await;
        assert_eq!(revoked.status(), StatusCode::FORBIDDEN);
        let entries = call(
            &router,
            "directory",
            serde_json::json!({"context":context, "path":package.join("components/panel")}),
        )
        .await;
        assert_eq!(entries.status(), StatusCode::OK);
        let data: serde_json::Value =
            serde_json::from_slice(&entries.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(
            data[0]["path"],
            package.join("components/panel/index.js").to_str().unwrap()
        );
        for path in [
            package.join("private.txt"),
            repository_root.join("secret.txt"),
            package.join("components/../private.txt"),
        ] {
            let denied = call(
                &router,
                "resources",
                serde_json::json!({"context":context, "request":{"path":path, "read":true}}),
            )
            .await;
            assert!(denied.status().is_client_error());
        }
        // Configuration edits are snapshots: no write to the saved configuration.
        let overlay = serde_json::json!({"documentPath":"a.not", "overlays":{"Notist.toml":"[dependencies]\nother = {path = '../packages/missing'}"}});
        let revoked = call(&router, "resources", serde_json::json!({"context":overlay, "request":{"path":package.join("lib.notc"),"read":true}})).await;
        assert_eq!(revoked.status(), StatusCode::FORBIDDEN);
        assert!(std::fs::read_to_string(root.join("Notist.toml"))
            .unwrap()
            .contains("widgets"));
        let resources = PackageResources::new(root.clone(), broadcast::channel(8).0).unwrap();
        assert!(resources
            .packages(&Context {
                document_path: "a.not".into(),
                overlays: BTreeMap::new()
            })
            .unwrap()
            .contains(&package));
        let mut documents = crate::vault::documents::Documents::open(&root, &[0; 32]).unwrap();
        documents.open_file("a.not").unwrap();
        assert!(documents.resident().unwrap().iter().all(|doc| !doc
            .status
            .path
            .contains("lib.notc")
            && !doc.status.path.contains("components")));
    }
}
