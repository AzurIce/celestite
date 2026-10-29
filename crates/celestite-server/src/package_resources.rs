//! HTTP and watch integration for the shared read-only package grant policy.
use crate::vault::changes::ChangeHint;
use crate::{ApiError, RemoteAccess, ServerState};
use axum::{routing::post, Extension, Json, Router};
use celestite_core::error::{EditorError, EditorResult, ErrorCode};
use celestite_core::fs::FileEntry;
use celestite_core::preview::native::{PackageGrant, PackageResources as NativePackageResources};
use celestite_core::preview::{PreviewResource, PreviewResourceRequest, ResourceContext};
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
    context: ResourceContext,
    request: PreviewResourceRequest,
}
#[derive(Deserialize)]
struct DirectoryRequest {
    context: ResourceContext,
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
    fn grant(&self, context: &ResourceContext) -> EditorResult<PackageGrant> {
        let grant = self.resources.grant(context)?;
        for root in grant.roots() {
            if root.starts_with(&self.resources.root) {
                continue;
            }
            let mut path = root.clone();
            let mut seen = BTreeSet::new();
            loop {
                if seen.len() >= 40 || !seen.insert(path.clone()) {
                    return Err(EditorError::new(
                        ErrorCode::Unsupported,
                        "Package symbolic link chain is cyclic or too long",
                        root.to_string_lossy().as_ref(),
                    ));
                }
                let mut prefix = PathBuf::new();
                let mut redirect = None;
                for component in path.components() {
                    prefix.push(component);
                    let metadata = match std::fs::symlink_metadata(&prefix) {
                        Ok(metadata) => metadata,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                        Err(error) => {
                            return Err(EditorError::new(
                                ErrorCode::Io,
                                error.to_string(),
                                prefix.to_string_lossy().as_ref(),
                            ))
                        }
                    };
                    if metadata.is_symlink() {
                        // Observe the directory entry itself, so replacing an
                        // alias invalidates readers of its former target too.
                        let parent = prefix.parent().expect("a symbolic link has a parent");
                        let parent = parent.canonicalize().map_err(|error| {
                            EditorError::new(
                                ErrorCode::Io,
                                error.to_string(),
                                parent.to_string_lossy().as_ref(),
                            )
                        })?;
                        self.watch_directory(parent.clone())?;
                        let target = std::fs::read_link(&prefix).map_err(|error| {
                            EditorError::new(
                                ErrorCode::Io,
                                error.to_string(),
                                prefix.to_string_lossy().as_ref(),
                            )
                        })?;
                        let target = if target.is_absolute() {
                            target
                        } else {
                            parent.join(target)
                        };
                        let target = target.join(path.strip_prefix(&prefix).expect("path prefix"));
                        let mut normalized = PathBuf::new();
                        for component in target.components() {
                            match component {
                                std::path::Component::CurDir => {}
                                std::path::Component::ParentDir => {
                                    normalized.pop();
                                }
                                component => normalized.push(component),
                            }
                        }
                        redirect = Some(normalized);
                        break;
                    }
                }
                if let Some(target) = redirect {
                    path = target;
                    continue;
                }
                let mut ancestor = path.as_path();
                while !ancestor.is_dir() {
                    let Some(parent) = ancestor.parent() else {
                        break;
                    };
                    ancestor = parent;
                }
                self.watch_directory(ancestor.to_owned())?;
                break;
            }
        }
        Ok(grant)
    }
    fn watch_resource(
        &self,
        grant: &PackageGrant,
        path: &str,
        directory: bool,
    ) -> EditorResult<()> {
        let path = match grant.observation_directory(path, directory) {
            Ok(path) => path,
            Err(error) if error.code == ErrorCode::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        self.watch_directory(path)
    }

    fn watch_directory(&self, path: PathBuf) -> EditorResult<()> {
        let mut watches = self
            .watches
            .lock()
            .map_err(|_| EditorError::new(ErrorCode::Io, "Package watcher lock failed", ""))?;
        if !watches.paths.contains(&path) {
            if watches.paths.len() >= 2048 {
                return Err(EditorError::new(
                    ErrorCode::Unsupported,
                    "Too many package resource directories",
                    "",
                ));
            }
            watches
                .watcher
                .watch(&path, RecursiveMode::NonRecursive)
                .map_err(|error| EditorError::new(ErrorCode::Io, error.to_string(), ""))?;
            watches.paths.insert(path);
        }
        Ok(())
    }
    #[cfg(test)]
    fn packages(&self, context: &ResourceContext) -> EditorResult<BTreeSet<PathBuf>> {
        Ok(self.grant(context)?.roots().clone())
    }
    fn read(&self, input: ReadRequest) -> EditorResult<PreviewResource> {
        let grant = self.grant(&input.context)?;
        self.watch_resource(&grant, &input.request.path, false)?;
        grant.read(input.request)
    }
    fn directory(&self, input: DirectoryRequest) -> EditorResult<Vec<FileEntry>> {
        let grant = self.grant(&input.context)?;
        self.watch_resource(&grant, &input.path, true)?;
        grant.directory(&input.path)
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
    use super::{PackageResources, ResourceContext};
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
    async fn sibling_modules_follow_the_import_graph_and_stay_out_of_document_history() {
        let repository = tempfile::tempdir().unwrap();
        // Requests use the same canonical identities exposed by the server;
        // macOS temporary paths commonly pass through the /var symlink.
        let repository_root = repository.path().canonicalize().unwrap();
        let root = repository_root.join("docs");
        let package = repository_root.join("packages/widgets");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(package.join("panel")).unwrap();
        std::fs::write(
            root.join("a.not"),
            "#import \"../packages/widgets/lib.notc\" as widgets;\n\n#widgets.panel()[body]",
        )
        .unwrap();
        let transitive = repository_root.join("packages/katex");
        std::fs::create_dir_all(&transitive).unwrap();
        std::fs::write(
            transitive.join("lib.notc"),
            "fn math(text: String) -> InlineContent;",
        )
        .unwrap();
        std::fs::write(
            package.join("lib.notc"),
            "import \"../katex/lib.notc\" as katex;\n\nfn panel()[children: BlockContent] -> BlockContent;\n",
        )
        .unwrap();
        std::fs::write(
            package.join("panel/index.js"),
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
        let source = std::fs::read_to_string(root.join("a.not")).unwrap();
        let context = serde_json::json!({"documentPath": "a.not", "source":source, "overlays": {}});
        let declaration = call(&router, "resources", serde_json::json!({"context":context, "request":{"path":package.join("lib.notc"), "read":true}})).await;
        assert_eq!(declaration.status(), StatusCode::OK);
        let data: serde_json::Value =
            serde_json::from_slice(&declaration.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(data["kind"], "file");
        assert!(!data["data"].as_array().unwrap().is_empty());
        let transitive_declaration = call(&router, "resources", serde_json::json!({"context":context, "request":{"path":transitive.join("lib.notc"), "read":true}})).await;
        assert_eq!(transitive_declaration.status(), StatusCode::OK);
        // Grants follow the exact import graph: dropping the import from the
        // declaration revokes only the transitive module's grant.
        std::fs::write(
            package.join("lib.notc"),
            "fn panel()[children: BlockContent] -> BlockContent;\n",
        )
        .unwrap();
        let revoked = call(&router, "resources", serde_json::json!({"context":context, "request":{"path":transitive.join("lib.notc"),"read":true}})).await;
        assert_eq!(revoked.status(), StatusCode::FORBIDDEN);
        let kept = call(&router, "resources", serde_json::json!({"context":context, "request":{"path":package.join("lib.notc"),"read":true}})).await;
        assert_eq!(kept.status(), StatusCode::OK);
        std::fs::write(
            package.join("lib.notc"),
            "import \"../katex/lib.notc\" as katex;\n\nfn panel()[children: BlockContent] -> BlockContent;\n",
        )
        .unwrap();
        let entries = call(
            &router,
            "directory",
            serde_json::json!({"context":context, "path":package.join("panel")}),
        )
        .await;
        assert_eq!(entries.status(), StatusCode::OK);
        let data: serde_json::Value =
            serde_json::from_slice(&entries.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(
            data[0]["path"],
            package.join("panel/index.js").to_str().unwrap()
        );
        for path in [
            package.join("private.txt"),
            repository_root.join("secret.txt"),
            package.join("panel/../private.txt"),
        ] {
            let denied = call(
                &router,
                "resources",
                serde_json::json!({"context":context, "request":{"path":path, "read":true}}),
            )
            .await;
            assert!(denied.status().is_client_error());
        }
        // An extension import present only in a configuration snapshot grants
        // its module for that context, without touching the saved tree.
        let mermaid = repository_root.join("packages/mermaid");
        std::fs::create_dir_all(&mermaid).unwrap();
        std::fs::write(
            mermaid.join("lib.notc"),
            "fn diagram(text: String) -> InlineContent;\n",
        )
        .unwrap();
        let absent = call(&router, "resources", serde_json::json!({"context":context, "request":{"path":mermaid.join("lib.notc"),"read":true}})).await;
        assert_eq!(absent.status(), StatusCode::FORBIDDEN);
        let overlay = serde_json::json!({"documentPath":"a.not", "source":source, "overlays":{"Notist.toml":"[[extensions]]\nkind = 'replace'\nimports = { katex = '../packages/katex/lib.notc', mermaid = '../packages/mermaid/lib.notc' }\nfrom = 'katex.math'\nto = 'mermaid.diagram'\n"}});
        let granted = call(&router, "resources", serde_json::json!({"context":overlay, "request":{"path":mermaid.join("lib.notc"),"read":true}})).await;
        assert_eq!(granted.status(), StatusCode::OK);
        let resources = PackageResources::new(root.clone(), broadcast::channel(8).0).unwrap();
        assert!(resources
            .packages(&ResourceContext {
                document_path: "a.not".into(),
                source: source.clone(),
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
            && !doc.status.path.contains("packages")));
    }
}

#[cfg(test)]
mod observation_tests {
    use super::{PackageResources, ReadRequest};
    use celestite_core::preview::{PreviewResourceRequest, ResourceContext};
    use std::collections::BTreeMap;
    use tokio::sync::broadcast;

    #[tokio::test]
    async fn reads_observe_nested_module_assets_in_the_new_layout() {
        let repository = tempfile::tempdir().unwrap();
        let root = repository.path().canonicalize().unwrap();
        let vault = root.join("vault");
        let module = root.join("widgets");
        std::fs::create_dir(&vault).unwrap();
        std::fs::create_dir_all(module.join("panel/styles")).unwrap();
        std::fs::write(module.join("lib.notc"), "fn panel() -> BlockContent;").unwrap();
        let asset = module.join("panel/styles/panel.css");
        std::fs::write(&asset, "initial").unwrap();
        let (events, mut receive) = broadcast::channel(32);
        let resources = PackageResources::new(vault, events).unwrap();
        let read = resources
            .read(ReadRequest {
                context: ResourceContext {
                    document_path: "unsaved.not".into(),
                    source: "#import \"../widgets/lib.notc\" as widgets;\n".into(),
                    overlays: BTreeMap::new(),
                },
                request: PreviewResourceRequest {
                    path: asset.to_str().unwrap().into(),
                    read: true,
                },
            })
            .unwrap();
        assert_eq!(read.data.unwrap(), b"initial");
        while receive.try_recv().is_ok() {}
        std::fs::write(&asset, "changed").unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), receive.recv())
            .await
            .expect("nested assets must invalidate project resources")
            .unwrap();
    }
}

#[cfg(all(test, unix))]
mod alias_tests {
    use super::{PackageResources, ReadRequest};
    use celestite_core::preview::{PreviewResourceRequest, ResourceContext};
    use std::collections::BTreeMap;
    use tokio::sync::broadcast;

    #[tokio::test]
    async fn retargeting_a_module_alias_invalidates_and_observes_the_new_target() {
        let repository = tempfile::tempdir().unwrap();
        let base = repository.path().canonicalize().unwrap();
        let vault = base.join("vault");
        let aliases = base.join("aliases");
        std::fs::create_dir(&vault).unwrap();
        std::fs::create_dir(&aliases).unwrap();
        for name in ["one", "two"] {
            let target = base.join(name);
            std::fs::create_dir_all(target.join("panel")).unwrap();
            std::fs::write(target.join("lib.notc"), "fn panel() -> BlockContent;").unwrap();
            std::fs::write(target.join("panel/index.js"), name).unwrap();
        }
        let alias = aliases.join("widgets");
        std::os::unix::fs::symlink(base.join("one"), &alias).unwrap();
        let (events, mut receive) = broadcast::channel(32);
        let resources = PackageResources::new(vault, events).unwrap();
        let read = || {
            resources
                .read(ReadRequest {
                    context: ResourceContext {
                        document_path: "a.not".into(),
                        source: "#import \"../aliases/widgets/lib.notc\" as widgets;\n".into(),
                        overlays: BTreeMap::new(),
                    },
                    request: PreviewResourceRequest {
                        path: alias.join("panel/index.js").to_str().unwrap().into(),
                        read: true,
                    },
                })
                .unwrap()
                .data
                .unwrap()
        };
        assert_eq!(read(), b"one");
        while receive.try_recv().is_ok() {}
        std::fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink(base.join("two"), &alias).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), receive.recv())
            .await
            .expect("replacing an explicitly imported alias must invalidate the module")
            .unwrap();
        assert_eq!(read(), b"two");
        while receive.try_recv().is_ok() {}
        std::fs::write(base.join("two/panel/index.js"), "changed").unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), receive.recv())
            .await
            .expect("the replacement target's assets must stay observed")
            .unwrap();
    }
}
