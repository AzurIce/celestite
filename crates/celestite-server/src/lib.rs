#![recursion_limit = "256"]
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Extension, Json, Router,
};
mod editor_api;
mod package_resources;
mod profile;
mod reconcile;
mod shares;
mod sync;
pub use shares::{Permission, VaultLinks};
pub mod vault;
use notify::Watcher;
use serde::Deserialize;
use std::{
    collections::HashMap,
    convert::Infallible,
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::{broadcast, watch};
use tokio_stream::{
    wrappers::{BroadcastStream, WatchStream},
    StreamExt,
};
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use vault::documents::Documents;
use vault::fs::{revision, ChangeHint, FsVault, VaultError};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub server: ServerConfig,
    pub vault: VaultConfig,
}
#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    pub listen: SocketAddr,
    pub allowed_origins: Vec<String>,
    /// Public HTTP(S) origin/deployment prefix used in startup connection URLs.
    pub public_url: Option<String>,
    pub web_dir: Option<PathBuf>,
}
impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            listen: "127.0.0.1:7437".parse().unwrap(),
            allowed_origins: vec![],
            public_url: None,
            web_dir: None,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VaultConfig {
    #[serde(default = "default_vault_name")]
    pub name: String,
    pub path: PathBuf,
    #[serde(default)]
    pub read_only: bool,
    /// Private directory containing this Vault's history.redb.
    pub state_dir: Option<PathBuf>,
    /// Explicitly discard history on shutdown; intended for temporary tests.
    #[serde(default)]
    pub ephemeral: bool,
    /// Initialization/reset is a one-shot CLI action, never a startup policy in TOML.
    #[serde(skip)]
    pub history_mode: HistoryMode,
    /// Optional random secret to derive and rotate the two capability links.
    pub share_key: Option<String>,
}

fn default_vault_name() -> String {
    "Vault".into()
}
impl Default for VaultConfig {
    fn default() -> Self {
        Self {
            name: default_vault_name(),
            path: PathBuf::new(),
            read_only: false,
            state_dir: None,
            ephemeral: false,
            history_mode: HistoryMode::Recover,
            share_key: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum HistoryMode {
    #[default]
    Recover,
    Initialize,
    Reset,
}
struct HostedVault {
    id: String,
    name: String,
    read_only: bool,
    files: Mutex<FsVault>,
    packages: package_resources::PackageResources,
    documents: Mutex<Documents>,
    events: broadcast::Sender<ChangeHint>,
    _watcher: Mutex<notify::RecommendedWatcher>,
    reconcile_trigger: reconcile::Trigger,
    reconciler: Mutex<Option<reconcile::Reconciler>>,
}
struct ServerState {
    vault: Arc<HostedVault>,
    shares: shares::Registry,
    origins: Vec<String>,
    shutdown: watch::Sender<bool>,
}
impl Drop for ServerState {
    fn drop(&mut self) {
        // Join before releasing the Vault so restart cannot race a late history commit.
        if let Ok(mut worker) = self.vault.reconciler.lock() {
            if let Some(worker) = worker.as_mut() {
                worker.stop();
            }
        }
    }
}
pub struct Server {
    pub router: Router,
    pub shutdown: watch::Sender<bool>,
    pub links: VaultLinks,
}
#[derive(Clone)]
struct RemoteAccess {
    grant: Arc<shares::Grant>,
}

#[derive(Debug)]
pub struct ApiError(VaultError);
impl From<VaultError> for ApiError {
    fn from(error: VaultError) -> Self {
        Self(error)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self.0.code {
            "InvalidPath" => StatusCode::BAD_REQUEST,
            "NotFound" => StatusCode::NOT_FOUND,
            "PermissionDenied" => StatusCode::FORBIDDEN,
            "AlreadyExists" | "DirectoryNotEmpty" | "Conflict" | "StaleVersion" => {
                StatusCode::CONFLICT
            }
            "InvalidEdit" => StatusCode::BAD_REQUEST,
            "FilesystemDiffTimeout" | "FilesystemReconciliationPending" => StatusCode::CONFLICT,
            "NotDirectory" | "NotFile" => StatusCode::UNPROCESSABLE_ENTITY,
            "Unsupported" => StatusCode::NOT_IMPLEMENTED,
            "QuotaExceeded" => StatusCode::INSUFFICIENT_STORAGE,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        if status.is_server_error() {
            tracing::error!(code = self.0.code, message = %self.0.message, path = %self.0.path, "Vault operation failed");
        } else {
            tracing::debug!(code = self.0.code, message = %self.0.message, path = %self.0.path, "Vault operation rejected");
        }
        (status, Json(self.0)).into_response()
    }
}
fn failure(code: &'static str, message: &str) -> ApiError {
    VaultError::new(code, message, "").into()
}
fn request_operation(method: &Method, tail: &str) -> shares::Operation {
    use shares::Operation;
    if matches!(*method, Method::GET | Method::HEAD)
        || (*method == Method::POST
            && (tail == "/documents/open"
                || tail == "/preview/resources"
                || tail == "/preview/directory"
                || (tail.starts_with("/documents/") && tail.ends_with("/updates"))))
    {
        Operation::Read
    } else {
        Operation::Edit
    }
}
async fn access_check(
    State(state): State<Arc<ServerState>>,
    Path(params): Path<HashMap<String, String>>,
    mut request: axum::extract::Request,
    next: Next,
) -> Response {
    let Some(key) = params.get("id") else {
        return failure("NotFound", "Share not found").into_response();
    };
    let grant = match state.shares.resolve(key) {
        Ok(grant) => grant,
        Err(error) => return error.into_response(),
    };
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        if !state
            .origins
            .iter()
            .any(|allowed| origin.as_bytes() == allowed.as_bytes())
        {
            return failure("PermissionDenied", "This client origin is not allowed")
                .into_response();
        }
    }
    let tail = request
        .uri()
        .path()
        .split_once("/api/v1")
        .map(|(_, tail)| tail)
        .unwrap_or("");
    let operation = request_operation(request.method(), tail);
    if let Err(error) = grant.check(operation) {
        return error.into_response();
    }
    request.extensions_mut().insert(RemoteAccess { grant });
    next.run(request).await
}
async fn api_headers(request: axum::extract::Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

fn log_path(path: &str) -> String {
    if let Some((_, tail)) = path.split_once("/api/v1") {
        format!("/<redacted>/api/v1{tail}")
    } else if path.split('/').any(|segment| {
        shares::key_permission(segment).is_some() || (segment.contains('%') && segment.len() >= 43)
    }) {
        "/<redacted>".into()
    } else {
        path.into()
    }
}

pub fn connection_base_url(
    configured: Option<&str>,
    listen: SocketAddr,
) -> Result<String, Box<dyn std::error::Error>> {
    let Some(configured) = configured else {
        return Ok(format!("http://{listen}"));
    };
    let mut url = url::Url::parse(configured)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("public_url must be an HTTP(S) origin/deployment prefix without credentials, query or fragment".into());
    }
    url.set_path(url.path().trim_end_matches('/').to_owned().as_str());
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

pub fn build_server(
    config: Config,
    base: &std::path::Path,
) -> Result<Server, Box<dyn std::error::Error>> {
    connection_base_url(config.server.public_url.as_deref(), config.server.listen)?;
    let mut origins = config.server.allowed_origins.clone();
    if let Some(public_url) = &config.server.public_url {
        origins.push(url::Url::parse(public_url)?.origin().ascii_serialization());
    }
    origins.push(format!("http://{}", config.server.listen));
    if config.server.listen.ip().is_loopback() {
        origins.push(format!("http://localhost:{}", config.server.listen.port()));
    }
    let origin_headers: Vec<HeaderValue> = origins
        .iter()
        .map(|o| {
            let header = HeaderValue::from_str(o)?;
            if !(o.starts_with("http://") || o.starts_with("https://")) || o.ends_with('/') {
                return Err("Origins must be http(s) origins without trailing slash".into());
            }
            Ok(header)
        })
        .collect::<Result<_, Box<dyn std::error::Error>>>()?;
    let (
        profile::PreparedVault {
            config: vault,
            root,
            history_path,
        },
        web_dir,
    ) = profile::prepare(config.vault, config.server.web_dir.as_deref(), base)?;
    let files = FsVault::open(&root)?;
    let mut documents = Documents::open(history_path.as_deref(), &root, vault.history_mode)?;
    let seed = shares::seed(vault.share_key.as_deref(), &documents.share_seed)?;
    let identity = documents.identity.id.clone();
    let (trigger, observations) = reconcile::channel();
    let reconcile_signal = trigger.clone();
    let (file_events, _) = broadcast::channel(128);
    let sender = file_events.clone();
    let watched_vault = identity.clone();
    // Hints are intentionally coarse. Watch errors and reconnects invalidate the entire tree.
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Err(error) = &event {
            tracing::warn!(vault_identity = %watched_vault, %error, "Vault watcher failed; invalidating file tree");
        }
        // Reads produce access events too; forwarding them causes refresh loops.
        if !matches!(event, Ok(ref event) if event.kind.is_access()) {
            reconcile_signal.request();
            let _ = sender.send(ChangeHint::all());
        }
    })?;
    watcher.watch(&root, notify::RecursiveMode::Recursive)?;
    // Watch before discovering files so changes during the initial scan are queued.
    documents.reconcile()?;
    documents.publish_changes()?;
    tracing::info!(vault_identity = %identity, root = %root.display(), read_only = vault.read_only, persistent_history = documents.persistent(), "Vault initialized");
    let hosted = Arc::new(HostedVault {
        id: identity.clone(),
        name: vault.name,
        read_only: vault.read_only,
        packages: package_resources::PackageResources::new(root.clone(), file_events.clone())?,
        files: Mutex::new(files),
        documents: Mutex::new(documents),
        events: file_events,
        _watcher: Mutex::new(watcher),
        reconcile_trigger: trigger.clone(),
        reconciler: Mutex::new(None),
    });
    let worker = reconcile::Reconciler::start(Arc::downgrade(&hosted), trigger, observations)?;
    *hosted.reconciler.lock().unwrap() = Some(worker);
    let (shares, links) = shares::Registry::new(hosted.clone(), &seed, &identity)?;
    let (shutdown, _) = watch::channel(false);
    let state = Arc::new(ServerState {
        vault: hosted,
        shares,
        origins,
        shutdown: shutdown.clone(),
    });
    let api = Router::new()
        .merge(package_resources::routes())
        .merge(editor_api::routes())
        .merge(sync::routes())
        .route("/{id}/api/v1", get(describe))
        .route("/{id}/api/v1/stat", get(stat))
        .route("/{id}/api/v1/directory", get(read_dir).post(mkdir))
        .route("/{id}/api/v1/file", get(read_file).put(write_file))
        .route("/{id}/api/v1/entry", axum::routing::delete(remove))
        .route("/{id}/api/v1/rename", post(rename))
        .route("/{id}/api/v1/events", get(events))
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), access_check))
        .layer(
            CorsLayer::new()
                .allow_origin(origin_headers)
                .allow_methods([
                    Method::GET,
                    Method::HEAD,
                    Method::PUT,
                    Method::POST,
                    Method::DELETE,
                    Method::OPTIONS,
                ])
                .allow_headers([header::CONTENT_TYPE, header::IF_MATCH])
                .expose_headers([header::ETAG]),
        )
        .layer(middleware::from_fn(api_headers))
        .with_state(state.clone());
    let mut router = Router::new().merge(api);
    if let Some(directory) = web_dir {
        tracing::info!(directory = %directory.display(), "Serving Web UI");
        // Only assets from the configured UI directory, never files from Vault roots.
        router = router
            .route_service("/debug/sync", ServeFile::new(directory.join("index.html")))
            .fallback_service(ServeDir::new(directory));
    }
    // Deliberately omit query strings, headers and bodies from request logs.
    static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
    let router = router.layer(
        TraceLayer::new_for_http()
            .make_span_with(|request: &axum::extract::Request| {
                tracing::info_span!(
                    "http.request",
                    request_id = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed),
                    method = %request.method(),
                    path = %log_path(request.uri().path()),
                )
            })
            .on_response(
                |response: &Response, latency: Duration, _span: &tracing::Span| {
                    let status = response.status().as_u16();
                    let latency_ms = latency.as_secs_f64() * 1000.0;
                    if response.status().is_server_error() {
                        tracing::error!(status, latency_ms, "HTTP response");
                    } else if response.status().is_client_error() {
                        tracing::warn!(status, latency_ms, "HTTP response");
                    } else {
                        tracing::debug!(status, latency_ms, "HTTP response");
                    }
                },
            )
            .on_failure(()),
    );
    Ok(Server {
        router,
        shutdown,
        links,
    })
}

async fn run<T: Send + 'static>(
    vault: Arc<HostedVault>,
    mutation: bool,
    action: impl FnOnce(&FsVault) -> vault::fs::Result<T> + Send + 'static,
) -> Result<T, ApiError> {
    if mutation && vault.read_only {
        return Err(failure("PermissionDenied", "Vault is read-only"));
    }
    let span = tracing::Span::current();
    tokio::task::spawn_blocking(move || {
        let _entered = span.enter();
        tracing::debug!(vault_identity = %vault.id, mutation, "Running file operation");
        let files = vault
            .files
            .lock()
            .map_err(|_| VaultError::new("IO", "Vault operation lock failed", ""))?;
        let result = action(&files);
        // Failed recursive operations can partially complete, so invalidate on failure too.
        if mutation {
            vault.reconcile_trigger.request();
            let _ = vault.events.send(ChangeHint::all());
        }
        result
    })
    .await
    .map_err(|_| failure("IO", "Vault operation failed"))?
    .map_err(Into::into)
}
#[derive(Deserialize)]
struct FileQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    recursive: bool,
    mode: Option<String>,
}
async fn describe(
    Extension(access): Extension<RemoteAccess>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let grant = access.grant.clone();
    let vault = grant.vault.clone();
    let documents = vault
        .documents
        .lock()
        .map_err(|_| failure("IO", "Document lock failed"))?;
    Ok(Json(
        serde_json::json!({ "protocol": "celestite-vault", "version": 1, "shareId": grant.id, "name": vault.name, "readOnly": grant.read_only(), "previewResourceRoot": vault.packages.root, "vaultIdentity": documents.identity, "capabilities": { "watch": true, "conditionalWrite": true, "documentEditing": true, "clientReplicaCommit": true, "documentEvents": true, "websocketSync": true, "persistentHistory": documents.persistent(), "vaultCrdt": false } }),
    ))
}
async fn stat(
    Extension(access): Extension<RemoteAccess>,
    Query(query): Query<FileQuery>,
) -> Result<Json<Option<vault::fs::Entry>>, ApiError> {
    Ok(Json(
        run(access.grant.vault.clone(), false, move |v| {
            v.stat(&query.path)
        })
        .await?,
    ))
}
async fn read_dir(
    Extension(access): Extension<RemoteAccess>,
    Query(query): Query<FileQuery>,
) -> Result<Json<Vec<vault::fs::Entry>>, ApiError> {
    Ok(Json(
        run(access.grant.vault.clone(), false, move |v| {
            v.read_dir(&query.path)
        })
        .await?,
    ))
}
async fn read_file(
    Extension(access): Extension<RemoteAccess>,
    Query(query): Query<FileQuery>,
) -> Result<Response, ApiError> {
    let bytes = run(access.grant.vault.clone(), false, move |v| {
        if v.stat(&query.path)?
            .and_then(|e| e.size)
            .is_some_and(|s| s > 64 * 1024 * 1024)
        {
            return Err(VaultError::new(
                "Unsupported",
                "MVP file limit is 64 MiB",
                &query.path,
            ));
        }
        v.read_file_limited(&query.path, 64 * 1024 * 1024)
    })
    .await?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::ETAG, revision(&bytes)),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        bytes,
    )
        .into_response())
}
async fn write_file(
    Extension(access): Extension<RemoteAccess>,
    Query(query): Query<FileQuery>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Response, ApiError> {
    let expected = headers
        .get(header::IF_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    if query.mode.as_deref() == Some("replace") && expected.is_none() {
        return Err(failure(
            "Conflict",
            "Replace requires the version returned by reading the file",
        ));
    }
    let version =
        editor_api::run_documents(access.grant.vault.clone(), true, move |v, documents| {
            documents.before_replace(&query.path)?;
            let version = v.write_file(
                &query.path,
                &bytes,
                query.mode.as_deref().unwrap_or(""),
                expected.as_deref(),
            )?;
            documents.refresh_path(v, &query.path)?;
            Ok(version)
        })
        .await?;
    Ok((StatusCode::NO_CONTENT, [(header::ETAG, version)]).into_response())
}
async fn mkdir(
    Extension(access): Extension<RemoteAccess>,
    Query(query): Query<FileQuery>,
) -> Result<StatusCode, ApiError> {
    run(access.grant.vault.clone(), true, move |v| {
        v.mkdir(&query.path, query.recursive)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn remove(
    Extension(access): Extension<RemoteAccess>,
    Query(query): Query<FileQuery>,
) -> Result<StatusCode, ApiError> {
    editor_api::run_documents(access.grant.vault.clone(), true, move |v, documents| {
        documents.remove(v, &query.path, query.recursive)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
struct Rename {
    from: String,
    to: String,
}
async fn rename(
    Extension(access): Extension<RemoteAccess>,
    Json(args): Json<Rename>,
) -> Result<StatusCode, ApiError> {
    editor_api::run_documents(access.grant.vault.clone(), true, move |v, documents| {
        documents.rename(v, &args.from, &args.to)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn events(
    State(state): State<Arc<ServerState>>,
    Extension(access): Extension<RemoteAccess>,
) -> Result<Response, ApiError> {
    let receiver = access.grant.vault.clone().events.subscribe();
    let first = tokio_stream::once(Ok::<_, Infallible>(
        Event::default().json_data(ChangeHint::all()).unwrap(),
    ));
    let hints = BroadcastStream::new(receiver)
        .map(|event| Some(event.unwrap_or_else(|_| ChangeHint::all())));
    let stopping = WatchStream::new(state.shutdown.subscribe())
        .filter(|stopping| *stopping)
        .map(|_| None::<ChangeHint>);
    let stream = hints
        .merge(stopping)
        .take_while(Option::is_some)
        .map(|hint| Ok::<_, Infallible>(Event::default().json_data(hint.unwrap()).unwrap()));
    Ok(Sse::new(first.chain(stream))
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response())
}

#[cfg(test)]
pub(crate) mod testing {
    #[derive(Clone)]
    pub struct Host {
        pub router: axum::Router,
        pub key: String,
    }
    impl Host {
        pub fn new(server: crate::Server) -> Self {
            let key = server.links.key(crate::Permission::Edit).to_owned();
            Self {
                router: server.router,
                key,
            }
        }
        pub fn uri(&self, tail: &str) -> String {
            format!("/{}/api/v1{tail}", self.key)
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn request_logs_redact_share_credentials_including_encoded_urls() {
        let key = "A".repeat(43);
        assert_eq!(super::log_path(&format!("/{key}")), "/<redacted>");
        assert_eq!(
            super::log_path(&format!("/ro-{key}/api/v1/documents")),
            "/<redacted>/api/v1/documents"
        );
        assert_eq!(
            super::log_path(&format!("/%41{}", "A".repeat(42))),
            "/<redacted>"
        );
        assert_eq!(super::log_path("/assets/app.js"), "/assets/app.js");
    }
    use super::*;
    use crate::testing::Host;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    fn fixture(read_only: bool) -> (tempfile::TempDir, Host) {
        let root = tempfile::tempdir().unwrap();
        let config = Config {
            server: ServerConfig {
                allowed_origins: vec!["http://127.0.0.1:1432".into()],
                ..Default::default()
            },
            vault: VaultConfig {
                name: "Notes".into(),
                path: root.path().into(),
                read_only,
                ephemeral: true,
                ..Default::default()
            },
        };
        let router = Host::new(build_server(config, root.path()).unwrap());
        (root, router)
    }
    async fn call(
        router: &Host,
        method: &str,
        route: &str,
        data: &'static [u8],
        version: Option<&str>,
    ) -> Response {
        let mut request = Request::builder().method(method).uri(router.uri(route));
        if let Some(version) = version {
            request = request.header(header::IF_MATCH, version);
        }
        if route == "/rename" {
            request = request.header(header::CONTENT_TYPE, "application/json");
        }
        router
            .router
            .clone()
            .oneshot(request.body(Body::from(data)).unwrap())
            .await
            .unwrap()
    }
    #[tokio::test]
    async fn descriptor_and_binary_roundtrip_with_conditional_save() {
        let (_root, router) = fixture(false);
        let descriptor = call(&router, "GET", "", b"", None)
            .await
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let descriptor: serde_json::Value = serde_json::from_slice(&descriptor).unwrap();
        assert_eq!(descriptor["protocol"], "celestite-vault");
        assert!(descriptor.get("path").is_none());
        let created = call(
            &router,
            "PUT",
            "/file?path=a.md&mode=create",
            b"\0\xffhello",
            None,
        )
        .await;
        assert_eq!(created.status(), StatusCode::NO_CONTENT);
        let read = call(&router, "GET", "/file?path=a.md", b"", None).await;
        let version = read
            .headers()
            .get(header::ETAG)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            read.into_body().collect().await.unwrap().to_bytes(),
            b"\0\xffhello"[..]
        );
        assert_eq!(
            call(
                &router,
                "PUT",
                "/file?path=a.md&mode=replace",
                b"new",
                Some(&version)
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
        let stale = call(
            &router,
            "PUT",
            "/file?path=a.md&mode=replace",
            b"stale",
            Some(&version),
        )
        .await;
        assert_eq!(stale.status(), StatusCode::CONFLICT);
        assert_eq!(
            call(&router, "GET", "/file?path=a.md", b"", None)
                .await
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes(),
            b"new"[..]
        );
        assert_eq!(
            call(
                &router,
                "PUT",
                "/file?path=a.md&mode=replace",
                b"no condition",
                None
            )
            .await
            .status(),
            StatusCode::CONFLICT
        );
    }
    #[tokio::test]
    async fn directory_move_delete_and_root_protection() {
        let (_root, router) = fixture(false);
        assert_eq!(
            call(
                &router,
                "POST",
                "/directory?path=a/b&recursive=true",
                b"",
                None
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
        call(&router, "PUT", "/file?path=a/b/x&mode=create", b"x", None).await;
        assert_eq!(
            call(
                &router,
                "POST",
                "/rename",
                br#"{"from":"a","to":"new"}"#,
                None
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            call(&router, "GET", "/file?path=new/b/x", b"", None)
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            call(&router, "DELETE", "/entry?path=new", b"", None)
                .await
                .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            call(
                &router,
                "DELETE",
                "/entry?path=new&recursive=true",
                b"",
                None
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            call(&router, "DELETE", "/entry?path=&recursive=true", b"", None)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(&router, "GET", "/stat?path=../outside", b"", None)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    #[tokio::test]
    async fn concurrent_creation_never_overwrites() {
        let (root, router) = fixture(false);
        let mut tasks = Vec::new();
        for _ in 0..10 {
            let router = router.clone();
            tasks.push(tokio::spawn(async move {
                call(&router, "PUT", "/file?path=one&mode=create", b"safe", None)
                    .await
                    .status()
            }));
        }
        let mut successes = 0;
        for task in tasks {
            match task.await.unwrap() {
                StatusCode::NO_CONTENT => successes += 1,
                StatusCode::CONFLICT => {}
                status => panic!("unexpected {status}"),
            }
        }
        assert_eq!(successes, 1);
        assert_eq!(std::fs::read(root.path().join("one")).unwrap(), b"safe");
    }
    #[tokio::test]
    async fn read_only_vault_and_cors_enforcement() {
        let (root, router) = fixture(true);
        std::fs::write(root.path().join("a"), b"a").unwrap();
        assert_eq!(
            call(&router, "GET", "/file?path=a", b"", None)
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            call(&router, "PUT", "/file?path=x&mode=create", b"x", None)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        let blocked = router
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(router.uri(""))
                    .header(header::ORIGIN, "https://untrusted.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(blocked.status(), StatusCode::FORBIDDEN);
        let allowed = router
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(router.uri(""))
                    .header(header::ORIGIN, "http://127.0.0.1:1432")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            allowed
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            "http://127.0.0.1:1432"
        );
    }
    #[tokio::test]
    async fn authentication_and_preflight() {
        let root = tempfile::tempdir().unwrap();
        let server = build_server(
            Config {
                server: ServerConfig {
                    allowed_origins: vec!["https://client.example".into()],
                    ..Default::default()
                },
                vault: VaultConfig {
                    name: "N".into(),
                    path: root.path().into(),
                    read_only: false,
                    ephemeral: true,
                    ..Default::default()
                },
            },
            root.path(),
        )
        .unwrap();
        let router = Host::new(server);
        let missing = router
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/invalid/api/v1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        let allowed = router
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(router.uri(""))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(allowed.status(), StatusCode::OK);
        let preflight = router
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri(router.uri("/file"))
                    .header(header::ORIGIN, "https://client.example")
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "PUT")
                    .header(
                        header::ACCESS_CONTROL_REQUEST_HEADERS,
                        "if-match,content-type",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(preflight.status(), StatusCode::OK);
        assert_eq!(
            preflight
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            "https://client.example"
        );
    }
    #[tokio::test]
    async fn event_stream_invalidates_after_mutation() {
        let (_root, router) = fixture(false);
        let response = call(&router, "GET", "/events", b"", None).await;
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/event-stream"
        );
        let mut body = response.into_body();
        assert!(body
            .frame()
            .await
            .unwrap()
            .unwrap()
            .data_ref()
            .unwrap()
            .starts_with(b"data:"));
        call(&router, "GET", "/directory?path=", b"", None).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(150), body.frame())
                .await
                .is_err(),
            "reading a directory must not generate a change hint"
        );
        call(&router, "PUT", "/file?path=a&mode=create", b"a", None).await;
        let frame = tokio::time::timeout(Duration::from_secs(2), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(frame.data_ref().unwrap().starts_with(b"data:"));
    }
    #[tokio::test]
    async fn shutdown_ends_event_streams() {
        let root = tempfile::tempdir().unwrap();
        let server = build_server(
            Config {
                server: Default::default(),
                vault: VaultConfig {
                    name: "N".into(),
                    path: root.path().into(),
                    read_only: false,
                    ephemeral: true,
                    ..Default::default()
                },
            },
            root.path(),
        )
        .unwrap();
        let shutdown = server.shutdown.clone();
        let router = Host::new(server);
        let response = call(&router, "GET", "/events", b"", None).await;
        let mut body = response.into_body();
        body.frame().await.unwrap().unwrap();
        shutdown.send_replace(true);
        assert!(tokio::time::timeout(Duration::from_secs(1), body.frame())
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn static_ui_is_separate_from_vault_files() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("web")).unwrap();
        std::fs::create_dir(root.path().join("vault")).unwrap();
        std::fs::write(root.path().join("web/index.html"), "<h1>UI</h1>").unwrap();
        std::fs::write(root.path().join("vault/private.md"), "private").unwrap();
        let config = |web_dir: &str| Config {
            server: ServerConfig {
                web_dir: Some(web_dir.into()),
                ..Default::default()
            },
            vault: VaultConfig {
                name: "N".into(),
                path: "vault".into(),
                read_only: false,
                ephemeral: true,
                ..Default::default()
            },
        };
        let router = Host::new(build_server(config("web"), root.path()).unwrap());
        let ui = router
            .router
            .clone()
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(ui.status(), StatusCode::OK);
        assert_eq!(
            ui.into_body().collect().await.unwrap().to_bytes(),
            "<h1>UI</h1>"
        );
        let debug = router
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/debug/sync")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(debug.status(), StatusCode::OK);
        assert_eq!(
            debug.into_body().collect().await.unwrap().to_bytes(),
            "<h1>UI</h1>"
        );
        for uri in ["/private.md", "/../vault/private.md", "/api/v1/unknown"] {
            let response = router
                .router
                .clone()
                .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert!(!response.status().is_success());
        }
        std::fs::write(root.path().join("vault/index.html"), "private").unwrap();
        assert!(build_server(config("vault"), root.path()).is_err());
    }

    #[test]
    fn invalid_configuration_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        for vault in [
            VaultConfig {
                path: root.path().join("missing"),
                ephemeral: true,
                ..Default::default()
            },
            VaultConfig {
                path: root.path().into(),
                name: " ".into(),
                ephemeral: true,
                ..Default::default()
            },
        ] {
            assert!(build_server(
                Config {
                    server: Default::default(),
                    vault
                },
                root.path()
            )
            .is_err());
        }
        assert!(toml::from_str::<Config>("[server]\n").is_err());
        assert!(toml::from_str::<Config>("[[vaults]]\npath = \"notes\"\n").is_err());
    }
}
