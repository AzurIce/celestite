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
    Json, Router,
};
mod editor_api;
mod profiles;
mod reconcile;
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
    pub vaults: Vec<VaultConfig>,
}
#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    pub listen: SocketAddr,
    pub allowed_origins: Vec<String>,
    /// Environment variable containing a bearer token; the token is never included in URLs.
    pub token_env: Option<String>,
    pub web_dir: Option<PathBuf>,
    /// Legacy shared directory containing <configured-vault-id>.redb files.
    pub state_dir: Option<PathBuf>,
}
impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            listen: "127.0.0.1:7437".parse().unwrap(),
            allowed_origins: vec![],
            token_env: None,
            web_dir: None,
            state_dir: None,
        }
    }
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VaultConfig {
    pub id: String,
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
    documents: Mutex<Documents>,
    events: broadcast::Sender<ChangeHint>,
    _watcher: Mutex<notify::RecommendedWatcher>,
    reconcile_trigger: reconcile::Trigger,
    reconciler: Mutex<Option<reconcile::Reconciler>>,
}
struct ServerState {
    vaults: HashMap<String, Arc<HostedVault>>,
    shutdown: watch::Sender<bool>,
}
impl Drop for ServerState {
    fn drop(&mut self) {
        // Join while all Vaults are still strongly owned: shutdown/restart must not
        // race a late history commit or leave a database temporarily locked.
        for vault in self.vaults.values() {
            if let Ok(mut worker) = vault.reconciler.lock() {
                if let Some(worker) = worker.as_mut() {
                    worker.stop();
                }
            }
        }
    }
}
pub struct Server {
    pub router: Router,
    pub shutdown: watch::Sender<bool>,
}
#[derive(Clone)]
struct Access {
    token: Option<String>,
    origins: Vec<String>,
}

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
fn authorized(headers: &HeaderMap, access: &Access) -> bool {
    match &access.token {
        None => true,
        Some(token) => {
            headers
                .get(header::AUTHORIZATION)
                .and_then(|h| h.to_str().ok())
                == Some(format!("Bearer {token}").as_str())
        }
    }
}
async fn access_check(
    State(access): State<Access>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        if !access
            .origins
            .iter()
            .any(|allowed| origin.as_bytes() == allowed.as_bytes())
        {
            return failure("PermissionDenied", "This client origin is not allowed")
                .into_response();
        }
    }
    if !authorized(request.headers(), &access) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(VaultError::new(
                "PermissionDenied",
                "Authentication required",
                "",
            )),
        )
            .into_response();
    }
    next.run(request).await
}

/// Paths in config are relative to the config directory. Missing roots and duplicate roots fail startup.
pub fn app(config: Config, base: &std::path::Path) -> Result<Router, Box<dyn std::error::Error>> {
    Ok(build_server(config, base)?.router)
}

pub fn build_server(
    config: Config,
    base: &std::path::Path,
) -> Result<Server, Box<dyn std::error::Error>> {
    let token = config
        .server
        .token_env
        .as_ref()
        .map(|name| {
            std::env::var(name).map_err(|_| format!("Token environment variable {name} is missing"))
        })
        .transpose()?;
    if token.as_ref().is_some_and(|token| token.trim().is_empty()) {
        return Err("Token must not be empty".into());
    }
    if !config.server.listen.ip().is_loopback() && token.is_none() {
        return Err("A token_env is required when listening outside loopback".into());
    }
    let mut origins = config.server.allowed_origins.clone();
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
    let mut vaults = HashMap::new();
    let (prepared, web_dir) = profiles::prepare(
        config.vaults,
        config.server.state_dir.as_deref(),
        config.server.web_dir.as_deref(),
        base,
    )?;
    for profiles::PreparedVault {
        config: vault,
        root,
        history_path,
    } in prepared
    {
        let files = FsVault::open(&root)?;
        let mut documents = Documents::open(history_path.as_deref(), &root, vault.history_mode)?;
        let (trigger, observations) = reconcile::channel();
        let reconcile_signal = trigger.clone();
        let (events, _) = broadcast::channel(128);
        let sender = events.clone();
        let watched_vault = vault.id.clone();
        // Hints are intentionally coarse. Watch errors and reconnects invalidate the entire tree.
        let mut watcher = notify::recommended_watcher(
            move |event: notify::Result<notify::Event>| {
                if let Err(error) = &event {
                    tracing::warn!(vault_id = %watched_vault, %error, "Vault watcher failed; invalidating file tree");
                }
                // Reads produce access events too; forwarding them causes refresh loops.
                if !matches!(event, Ok(ref event) if event.kind.is_access()) {
                    reconcile_signal.request();
                    let _ = sender.send(ChangeHint::all());
                }
            },
        )?;
        watcher.watch(&root, notify::RecursiveMode::Recursive)?;
        // Watch before discovering files so changes during the initial scan are queued.
        documents.reconcile()?;
        documents.publish_changes()?;
        tracing::info!(vault_id = %vault.id, root = %root.display(), read_only = vault.read_only, persistent_history = documents.persistent(), "Vault initialized");
        let hosted = Arc::new(HostedVault {
            id: vault.id.clone(),
            name: vault.name,
            read_only: vault.read_only,
            files: Mutex::new(files),
            documents: Mutex::new(documents),
            events,
            _watcher: Mutex::new(watcher),
            reconcile_trigger: trigger.clone(),
            reconciler: Mutex::new(None),
        });
        let worker = reconcile::Reconciler::start(Arc::downgrade(&hosted), trigger, observations)?;
        *hosted.reconciler.lock().unwrap() = Some(worker);
        vaults.insert(vault.id, hosted);
    }
    let (shutdown, _) = watch::channel(false);
    let state = Arc::new(ServerState {
        vaults,
        shutdown: shutdown.clone(),
    });
    let api = Router::new()
        .merge(editor_api::routes())
        .route("/api/v1/vaults/{id}", get(describe))
        .route("/api/v1/vaults/{id}/stat", get(stat))
        .route("/api/v1/vaults/{id}/directory", get(read_dir).post(mkdir))
        .route("/api/v1/vaults/{id}/file", get(read_file).put(write_file))
        .route("/api/v1/vaults/{id}/entry", axum::routing::delete(remove))
        .route("/api/v1/vaults/{id}/rename", post(rename))
        .route("/api/v1/vaults/{id}/events", get(events))
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(
            Access { token, origins },
            access_check,
        ))
        .layer(
            CorsLayer::new()
                .allow_origin(origin_headers)
                .allow_methods([
                    Method::GET,
                    Method::PUT,
                    Method::POST,
                    Method::DELETE,
                    Method::OPTIONS,
                ])
                .allow_headers([
                    header::AUTHORIZATION,
                    header::CONTENT_TYPE,
                    header::IF_MATCH,
                ])
                .expose_headers([header::ETAG]),
        )
        .with_state(state);
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
                    path = request.uri().path(),
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
    Ok(Server { router, shutdown })
}
fn get_vault(state: &ServerState, id: &str) -> Result<Arc<HostedVault>, ApiError> {
    state
        .vaults
        .get(id)
        .cloned()
        .ok_or_else(|| failure("NotFound", "Vault is not configured"))
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
        tracing::debug!(vault_id = %vault.id, mutation, "Running file operation");
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
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let vault = get_vault(&state, &id)?;
    let documents = vault
        .documents
        .lock()
        .map_err(|_| failure("IO", "Document lock failed"))?;
    Ok(Json(
        serde_json::json!({ "protocol": "celestite-vault", "version": 1, "id": vault.id, "name": vault.name, "readOnly": vault.read_only, "vaultIdentity": documents.identity, "capabilities": { "watch": true, "conditionalWrite": true, "documentEditing": true, "clientReplicaCommit": true, "documentEvents": true, "persistentHistory": documents.persistent(), "vaultCrdt": false } }),
    ))
}
async fn stat(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
    Query(query): Query<FileQuery>,
) -> Result<Json<Option<vault::fs::Entry>>, ApiError> {
    Ok(Json(
        run(get_vault(&state, &id)?, false, move |v| v.stat(&query.path)).await?,
    ))
}
async fn read_dir(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
    Query(query): Query<FileQuery>,
) -> Result<Json<Vec<vault::fs::Entry>>, ApiError> {
    Ok(Json(
        run(get_vault(&state, &id)?, false, move |v| {
            v.read_dir(&query.path)
        })
        .await?,
    ))
}
async fn read_file(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
    Query(query): Query<FileQuery>,
) -> Result<Response, ApiError> {
    let bytes = run(get_vault(&state, &id)?, false, move |v| {
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
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
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
    let version = editor_api::run_documents(get_vault(&state, &id)?, true, move |v, documents| {
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
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
    Query(query): Query<FileQuery>,
) -> Result<StatusCode, ApiError> {
    run(get_vault(&state, &id)?, true, move |v| {
        v.mkdir(&query.path, query.recursive)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn remove(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
    Query(query): Query<FileQuery>,
) -> Result<StatusCode, ApiError> {
    editor_api::run_documents(get_vault(&state, &id)?, true, move |v, documents| {
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
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
    Json(args): Json<Rename>,
) -> Result<StatusCode, ApiError> {
    editor_api::run_documents(get_vault(&state, &id)?, true, move |v, documents| {
        documents.rename(v, &args.from, &args.to)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn events(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let receiver = get_vault(&state, &id)?.events.subscribe();
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
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    fn fixture(read_only: bool) -> (tempfile::TempDir, Router) {
        let root = tempfile::tempdir().unwrap();
        let config = Config {
            server: ServerConfig {
                allowed_origins: vec!["http://127.0.0.1:1432".into()],
                ..Default::default()
            },
            vaults: vec![VaultConfig {
                id: "notes".into(),
                name: "Notes".into(),
                path: root.path().into(),
                read_only,
                ephemeral: true,
                ..Default::default()
            }],
        };
        let router = app(config, root.path()).unwrap();
        (root, router)
    }
    async fn call(
        router: &Router,
        method: &str,
        route: &str,
        data: &'static [u8],
        version: Option<&str>,
    ) -> Response {
        let mut request = Request::builder()
            .method(method)
            .uri(format!("/api/v1/vaults/notes{route}"));
        if let Some(version) = version {
            request = request.header(header::IF_MATCH, version);
        }
        if route == "/rename" {
            request = request.header(header::CONTENT_TYPE, "application/json");
        }
        router
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
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/vaults/notes")
                    .header(header::ORIGIN, "https://untrusted.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(blocked.status(), StatusCode::FORBIDDEN);
        let allowed = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/vaults/notes")
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
        std::env::set_var("CELESTITE_SERVER_UNIT_TOKEN", "unit-token");
        let router = app(
            Config {
                server: ServerConfig {
                    token_env: Some("CELESTITE_SERVER_UNIT_TOKEN".into()),
                    allowed_origins: vec!["https://client.example".into()],
                    ..Default::default()
                },
                vaults: vec![VaultConfig {
                    id: "notes".into(),
                    name: "N".into(),
                    path: root.path().into(),
                    read_only: false,
                    ephemeral: true,
                    ..Default::default()
                }],
            },
            root.path(),
        )
        .unwrap();
        assert_eq!(
            call(&router, "GET", "", b"", None).await.status(),
            StatusCode::UNAUTHORIZED
        );
        let allowed = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/vaults/notes")
                    .header(header::AUTHORIZATION, "Bearer unit-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(allowed.status(), StatusCode::OK);
        let preflight = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/api/v1/vaults/notes/file")
                    .header(header::ORIGIN, "https://client.example")
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "PUT")
                    .header(
                        header::ACCESS_CONTROL_REQUEST_HEADERS,
                        "authorization,if-match,content-type",
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
                vaults: vec![VaultConfig {
                    id: "notes".into(),
                    name: "N".into(),
                    path: root.path().into(),
                    read_only: false,
                    ephemeral: true,
                    ..Default::default()
                }],
            },
            root.path(),
        )
        .unwrap();
        let response = call(&server.router, "GET", "/events", b"", None).await;
        let mut body = response.into_body();
        body.frame().await.unwrap().unwrap();
        server.shutdown.send_replace(true);
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
            vaults: vec![VaultConfig {
                id: "notes".into(),
                name: "N".into(),
                path: "vault".into(),
                read_only: false,
                ephemeral: true,
                ..Default::default()
            }],
        };
        let router = app(config("web"), root.path()).unwrap();
        let ui = router
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
                .clone()
                .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert!(!response.status().is_success());
        }
        std::fs::write(root.path().join("vault/index.html"), "private").unwrap();
        assert!(app(config("vault"), root.path()).is_err());
    }

    #[test]
    fn invalid_configuration_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("nested")).unwrap();
        let vault = |id: &str, path: PathBuf| VaultConfig {
            id: id.into(),
            name: "N".into(),
            path,
            read_only: false,
            ephemeral: true,
            ..Default::default()
        };
        assert!(app(
            Config {
                server: Default::default(),
                vaults: vec![vault("bad/id", root.path().into())]
            },
            root.path()
        )
        .is_err());
        assert!(app(
            Config {
                server: Default::default(),
                vaults: vec![
                    vault("a", root.path().into()),
                    vault("b", root.path().join("nested"))
                ]
            },
            root.path()
        )
        .is_err());
        assert!(app(
            Config {
                server: ServerConfig {
                    listen: "0.0.0.0:7437".parse().unwrap(),
                    ..Default::default()
                },
                vaults: vec![]
            },
            root.path()
        )
        .is_err());
        assert!(app(
            Config {
                server: Default::default(),
                vaults: vec![vault("missing", root.path().join("missing"))]
            },
            root.path()
        )
        .is_err());
    }
}
