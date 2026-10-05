//! HTTP is a headless reference host/transport, not part of the core.
use crate::vault::{
    changes::DocumentEvent,
    documents::{DocumentState, Documents},
    fs::{ChangeHint, FsVault, Result, VaultError},
};
use crate::{failure, get_vault, ApiError, HostedVault, ServerState};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use celestite_core::{ChangeEvent, ImportResult, SyncPacket, Transaction, UndoContext, Version};
use serde::{Deserialize, Serialize};
use std::{convert::Infallible, sync::Arc, time::Duration};
use tokio_stream::StreamExt;

pub(crate) fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route("/api/v1/vaults/{id}/documents", get(list))
        .route("/api/v1/vaults/{id}/documents/events", get(events))
        .route("/api/v1/vaults/{id}/documents/open", post(open))
        .route("/api/v1/vaults/{id}/documents/{document}", get(state))
        .route(
            "/api/v1/vaults/{id}/documents/{document}/snapshot",
            get(snapshot),
        )
        .route(
            "/api/v1/vaults/{id}/documents/{document}/updates",
            post(updates),
        )
        .route(
            "/api/v1/vaults/{id}/documents/{document}/import",
            post(import),
        )
        .route(
            "/api/v1/vaults/{id}/documents/{document}/transact",
            post(transact),
        )
        .route("/api/v1/vaults/{id}/documents/{document}/undo", post(undo))
        .route("/api/v1/vaults/{id}/documents/{document}/redo", post(redo))
        .route("/api/v1/vaults/{id}/documents/{document}/save", post(save))
        .route(
            "/api/v1/vaults/{id}/documents/{document}/retry-observation",
            post(retry_observation),
        )
        .route(
            "/api/v1/vaults/{id}/documents/{document}/client-commit",
            post(client_commit),
        )
        .layer(DefaultBodyLimit::max(80 * 1024 * 1024))
        .layer(axum::middleware::from_fn(no_cache))
}

async fn no_cache(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

pub(crate) async fn run_documents<T: Send + 'static>(
    vault: Arc<HostedVault>,
    mutation: bool,
    action: impl FnOnce(&FsVault, &mut Documents) -> Result<T> + Send + 'static,
) -> std::result::Result<T, ApiError> {
    run_documents_with_tree(vault, mutation, true, action).await
}
pub(crate) async fn run_documents_with_tree<T: Send + 'static>(
    vault: Arc<HostedVault>,
    mutation: bool,
    notify_tree: bool,
    action: impl FnOnce(&FsVault, &mut Documents) -> Result<T> + Send + 'static,
) -> std::result::Result<T, ApiError> {
    if mutation && vault.read_only {
        return Err(failure("PermissionDenied", "Vault is read-only"));
    }
    let span = tracing::Span::current();
    tokio::task::spawn_blocking(move || {
        let _entered = span.enter();
        tracing::debug!(vault_id = %vault.id, mutation, "Running document operation");
        // Same order for every document/file operation.
        let files = vault
            .files
            .lock()
            .map_err(|_| VaultError::new("IO", "Vault lock failed", ""))?;
        let mut documents = vault
            .documents
            .lock()
            .map_err(|_| VaultError::new("IO", "Document lock failed", ""))?;
        let result = action(&files, &mut documents);
        let published = documents.publish_changes();
        if documents.has_file_observations() {
            vault.reconcile_trigger.request();
        }
        if notify_tree && (mutation || published.as_ref().is_ok_and(|changed| *changed)) {
            let _ = vault.events.send(ChangeHint::all());
        }
        result.and_then(|value| published.map(|_| value))
    })
    .await
    .map_err(|_| failure("IO", "Document operation failed"))?
    .map_err(Into::into)
}

#[derive(Serialize)]
struct Reply<T: Serialize> {
    result: T,
    document: DocumentState,
}

async fn list(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
) -> std::result::Result<Json<Vec<DocumentState>>, ApiError> {
    Ok(Json(
        run_documents(get_vault(&state, &id)?, false, |files, docs| {
            docs.list(files)
        })
        .await?,
    ))
}

async fn retry_observation(
    State(state): State<Arc<ServerState>>,
    Path((id, document)): Path<(String, String)>,
) -> std::result::Result<Json<DocumentState>, ApiError> {
    Ok(Json(
        run_documents(get_vault(&state, &id)?, false, move |files, docs| {
            docs.retry_file_observation(&document)?;
            docs.state(files, &document)
        })
        .await?,
    ))
}

#[derive(Deserialize)]
struct Open {
    path: String,
}
async fn open(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
    Json(body): Json<Open>,
) -> std::result::Result<Json<DocumentState>, ApiError> {
    Ok(Json(
        run_documents(get_vault(&state, &id)?, false, move |files, docs| {
            let id = docs.open_file(files, &body.path)?;
            docs.state(files, &id)
        })
        .await?,
    ))
}

async fn state(
    State(state): State<Arc<ServerState>>,
    Path((id, document)): Path<(String, String)>,
) -> std::result::Result<Json<DocumentState>, ApiError> {
    Ok(Json(
        run_documents(get_vault(&state, &id)?, false, move |files, docs| {
            docs.refresh(files, &document)?;
            docs.state(files, &document)
        })
        .await?,
    ))
}

async fn snapshot(
    State(state): State<Arc<ServerState>>,
    Path((id, document)): Path<(String, String)>,
) -> std::result::Result<Json<SyncPacket>, ApiError> {
    Ok(Json(
        run_documents(get_vault(&state, &id)?, false, move |files, docs| {
            docs.refresh(files, &document)?;
            docs.snapshot(&document)
        })
        .await?,
    ))
}

async fn updates(
    State(state): State<Arc<ServerState>>,
    Path((id, document)): Path<(String, String)>,
    Json(version): Json<Version>,
) -> std::result::Result<Json<SyncPacket>, ApiError> {
    Ok(Json(
        run_documents(get_vault(&state, &id)?, false, move |files, docs| {
            docs.refresh(files, &document)?;
            let packet = docs.updates(&document, &version)?;
            tracing::debug!(document_id = %document, bytes = packet.data.len(), "CRDT updates exported");
            Ok(packet)
        })
        .await?,
    ))
}

async fn transact(
    State(state): State<Arc<ServerState>>,
    Path((id, document)): Path<(String, String)>,
    Json(transaction): Json<Transaction>,
) -> std::result::Result<Json<Reply<Option<ChangeEvent>>>, ApiError> {
    Ok(Json(
        run_documents(get_vault(&state, &id)?, true, move |files, docs| {
            docs.refresh(files, &document)?;
            let result = docs.transact(&document, transaction)?;
            Ok(Reply {
                result,
                document: docs.state(files, &document)?,
            })
        })
        .await?,
    ))
}

async fn import(
    State(state): State<Arc<ServerState>>,
    Path((id, document)): Path<(String, String)>,
    Json(packet): Json<SyncPacket>,
) -> std::result::Result<Json<Reply<ImportResult>>, ApiError> {
    Ok(Json(
        run_documents(get_vault(&state, &id)?, true, move |files, docs| {
            docs.refresh(files, &document)?;
            let bytes = packet.data.len();
            let kind = packet.kind;
            let result = docs.import(&document, packet)?;
            let state = docs.state(files, &document)?;
            tracing::info!(document_id = %document, ?kind, bytes, pending = result.pending, changed = result.event.is_some(), persistent_history = docs.persistent(), durable = state.durable_version.as_ref() == Some(&state.snapshot.version), "CRDT packet imported");
            tracing::debug!(document_id = %document, version = ?state.snapshot.version, durable_version = ?state.durable_version, "CRDT import receipt");
            Ok(Reply {
                result,
                document: state,
            })
        })
        .await?,
    ))
}

async fn undo(
    State(state): State<Arc<ServerState>>,
    Path((id, document)): Path<(String, String)>,
    Json(context): Json<UndoContext>,
) -> std::result::Result<Json<Reply<Option<ChangeEvent>>>, ApiError> {
    history(state, id, document, context, false).await
}
async fn redo(
    State(state): State<Arc<ServerState>>,
    Path((id, document)): Path<(String, String)>,
    Json(context): Json<UndoContext>,
) -> std::result::Result<Json<Reply<Option<ChangeEvent>>>, ApiError> {
    history(state, id, document, context, true).await
}
async fn history(
    state: Arc<ServerState>,
    id: String,
    document: String,
    context: UndoContext,
    redo: bool,
) -> std::result::Result<Json<Reply<Option<ChangeEvent>>>, ApiError> {
    Ok(Json(
        run_documents(get_vault(&state, &id)?, true, move |files, docs| {
            docs.refresh(files, &document)?;
            let result = docs.undo(&document, context, redo)?;
            Ok(Reply {
                result,
                document: docs.state(files, &document)?,
            })
        })
        .await?,
    ))
}

async fn save(
    State(state): State<Arc<ServerState>>,
    Path((id, document)): Path<(String, String)>,
    Json(version): Json<Version>,
) -> std::result::Result<Json<DocumentState>, ApiError> {
    Ok(Json(
        run_documents(get_vault(&state, &id)?, true, move |files, docs| {
            docs.refresh(files, &document)?;
            docs.save(files, &document, version)?;
            let state = docs.state(files, &document)?;
            tracing::info!(document_id = %document, path = %state.path, dirty = state.dirty, "Document saved to disk");
            tracing::debug!(document_id = %document, saved_version = ?state.saved_version, "Document save receipt");
            Ok(state)
        })
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientCommit {
    packet: Option<SyncPacket>,
    expected_revision: String,
    action: String,
}
async fn client_commit(
    State(state): State<Arc<ServerState>>,
    Path((id, document)): Path<(String, String)>,
    Json(body): Json<ClientCommit>,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    Ok(Json(run_documents(get_vault(&state, &id)?, true, move |files, docs| {
        docs.commit_replica(&document, body.packet, &body.expected_revision, &body.action)?;
        Ok(serde_json::json!({"document": docs.state(files, &document)?, "packet": docs.snapshot(&document)?}))
    }).await?))
}

fn event_frame(event: DocumentEvent) -> Event {
    Event::default()
        .event("documents")
        .id(format!("{}:{}", event.stream_id, event.sequence))
        .json_data(event)
        .expect("document metadata serializes")
}

async fn events(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
) -> std::result::Result<Response, ApiError> {
    let vault = get_vault(&state, &id)?;
    let subscription = run_documents(vault.clone(), false, |_, docs| docs.subscribe()).await?;
    let first = tokio_stream::once(Ok::<_, Infallible>(event_frame(subscription.initial)));
    let stopping = state.shutdown.subscribe();
    let changes = futures_lite::stream::unfold(
        (vault, subscription.receiver, stopping),
        |(vault, mut receiver, mut stopping)| async move {
            if *stopping.borrow() {
                return None;
            }
            let event = tokio::select! {
                _ = stopping.changed() => return None,
                event = receiver.recv() => event,
            };
            let event = match event {
                Ok(event) => event,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    // Atomically take a new state and a new receiver, rather than
                    // replaying an incomplete suffix after a dropped notification.
                    let subscription =
                        match run_documents(vault.clone(), false, |_, docs| docs.subscribe()).await
                        {
                            Ok(subscription) => subscription,
                            Err(_) => return None,
                        };
                    receiver = subscription.receiver;
                    subscription.initial
                }
            };
            Some((
                Ok::<_, Infallible>(event_frame(event)),
                (vault, receiver, stopping),
            ))
        },
    );
    Ok(Sse::new(first.chain(changes))
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use tower::ServiceExt;

    async fn request(router: &Router, method: &str, path: &str, body: Value) -> Value {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(format!("/api/v1/vaults/notes{path}"))
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert!(
            status.is_success(),
            "{status}: {}",
            String::from_utf8_lossy(&bytes)
        );
        serde_json::from_slice(&bytes).unwrap()
    }
    async fn next(body: &mut Body) -> Value {
        let bytes = tokio::time::timeout(Duration::from_secs(5), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .into_data()
            .unwrap();
        let frame = std::str::from_utf8(&bytes).unwrap();
        serde_json::from_str(
            frame
                .lines()
                .find_map(|line| line.strip_prefix("data: "))
                .unwrap(),
        )
        .unwrap()
    }
    #[tokio::test]
    async fn snapshot_subscription_and_lag_recovery_do_not_lose_updates() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.md"), "base").unwrap();
        let server = crate::build_server(
            crate::Config {
                server: crate::ServerConfig::default(),
                vaults: vec![crate::VaultConfig {
                    id: "notes".into(),
                    name: "Notes".into(),
                    path: root.path().into(),
                    ephemeral: true,
                    ..Default::default()
                }],
            },
            root.path(),
        )
        .unwrap();
        let router = server.router;
        let docs = request(&router, "GET", "/documents", Value::Null).await;
        let mut state = docs[0].clone();
        let id = state["id"].as_str().unwrap().to_owned();
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/vaults/notes/documents/events")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let mut body = response.into_body();
        let initial = next(&mut body).await;
        assert_eq!(initial["kind"], "resync");
        // The receiver is already subscribed, even though the consumer has not
        // requested any snapshot or polled the next frame.
        for _ in 0..140 {
            let end = state["snapshot"]["text"].as_str().unwrap().len();
            let transaction = json!({
                "expected_version":state["snapshot"]["version"],"origin":"test",
                "edits":[{"from":end,"to":end,"insert":"x"}]
            });
            state = request(
                &router,
                "POST",
                &format!("/documents/{id}/transact"),
                transaction,
            )
            .await["document"]
                .clone();
        }
        let recovered = next(&mut body).await;
        assert_eq!(recovered["kind"], "resync");
        assert_eq!(recovered["streamId"], initial["streamId"]);
        assert_eq!(
            recovered["documents"][0]["version"],
            state["snapshot"]["version"]
        );
        assert!(
            recovered["sequence"].as_u64().unwrap() > initial["sequence"].as_u64().unwrap() + 128
        );
        let end = state["snapshot"]["text"].as_str().unwrap().len();
        state = request(
            &router,
            "POST",
            &format!("/documents/{id}/transact"),
            json!({
                "expected_version":state["snapshot"]["version"],"origin":"test",
                "edits":[{"from":end,"to":end,"insert":"y"}]
            }),
        )
        .await["document"]
            .clone();
        let changed = next(&mut body).await;
        assert_eq!(changed["kind"], "changed");
        assert_eq!(
            changed["sequence"].as_u64().unwrap(),
            recovered["sequence"].as_u64().unwrap() + 1
        );
        assert_eq!(
            changed["documents"][0]["version"],
            state["snapshot"]["version"]
        );
        server.shutdown.send_replace(true);
        assert!(tokio::time::timeout(Duration::from_secs(5), body.frame())
            .await
            .unwrap()
            .is_none());
    }
}
