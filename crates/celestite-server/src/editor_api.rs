//! HTTP is a headless reference host/transport, not part of the core.
use crate::vault::{
    changes::DocumentEvent,
    documents::{DocumentState, Documents},
    fs::{ChangeHint, FsVault, Result, VaultError},
};
use crate::{ApiError, HostedVault, RemoteAccess, ServerState, failure};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use celestite_core::{BufferCommand, EditorMutation, SyncPacket, Version};
use serde::Deserialize;
use std::{convert::Infallible, sync::Arc, time::Duration};
use tokio_stream::StreamExt;

pub(crate) fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route("/{id}/api/v1/documents", get(list))
        .route("/{id}/api/v1/documents/events", get(events))
        .route("/{id}/api/v1/documents/open", post(open))
        .route("/{id}/api/v1/documents/{document}", get(state))
        .route("/{id}/api/v1/documents/{document}/snapshot", get(snapshot))
        .route("/{id}/api/v1/documents/{document}/updates", post(updates))
        .route("/{id}/api/v1/documents/{document}/apply", post(apply))
        .route("/{id}/api/v1/documents/{document}/save", post(save))
        .route(
            "/{id}/api/v1/documents/{document}/retry-observation",
            post(retry_observation),
        )
        .route(
            "/{id}/api/v1/documents/{document}/client-commit",
            post(client_commit),
        )
        .layer(DefaultBodyLimit::max(80 * 1024 * 1024))
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
        tracing::debug!(vault_identity = %vault.id, mutation, "Running document operation");
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

async fn list(
    Extension(access): Extension<RemoteAccess>,
) -> std::result::Result<Json<Vec<DocumentState>>, ApiError> {
    Ok(Json(
        run_documents(access.grant.vault.clone(), false, |files, docs| {
            docs.list(files)
        })
        .await?,
    ))
}

async fn retry_observation(
    Extension(access): Extension<RemoteAccess>,
    Path((_key, document)): Path<(String, String)>,
) -> std::result::Result<Json<DocumentState>, ApiError> {
    Ok(Json(
        run_documents(access.grant.vault.clone(), false, move |files, docs| {
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
    Extension(access): Extension<RemoteAccess>,
    Json(body): Json<Open>,
) -> std::result::Result<Json<DocumentState>, ApiError> {
    Ok(Json(
        run_documents(access.grant.vault.clone(), false, move |files, docs| {
            let id = docs.open_file(files, &body.path)?;
            docs.state(files, &id)
        })
        .await?,
    ))
}

async fn state(
    Extension(access): Extension<RemoteAccess>,
    Path((_key, document)): Path<(String, String)>,
) -> std::result::Result<Json<DocumentState>, ApiError> {
    Ok(Json(
        run_documents(access.grant.vault.clone(), false, move |files, docs| {
            docs.refresh(files, &document)?;
            docs.state(files, &document)
        })
        .await?,
    ))
}

async fn snapshot(
    Extension(access): Extension<RemoteAccess>,
    Path((_key, document)): Path<(String, String)>,
) -> std::result::Result<Json<SyncPacket>, ApiError> {
    Ok(Json(
        run_documents(access.grant.vault.clone(), false, move |files, docs| {
            docs.refresh(files, &document)?;
            docs.snapshot(&document)
        })
        .await?,
    ))
}

async fn updates(
    Extension(access): Extension<RemoteAccess>,
    Path((_key, document)): Path<(String, String)>,
    Json(version): Json<Version>,
) -> std::result::Result<Json<SyncPacket>, ApiError> {
    Ok(Json(
        run_documents(access.grant.vault.clone(), false, move |files, docs| {
            docs.refresh(files, &document)?;
            let packet = docs.updates(&document, &version)?;
            tracing::debug!(document_id = %document, bytes = packet.data.len(), "CRDT updates exported");
            Ok(packet)
        })
        .await?,
    ))
}

async fn apply(
    Extension(access): Extension<RemoteAccess>,
    Path((_key, document)): Path<(String, String)>,
    Json(command): Json<BufferCommand>,
) -> std::result::Result<Json<Arc<EditorMutation>>, ApiError> {
    Ok(Json(
        run_documents(access.grant.vault.clone(), true, move |files, docs| {
            docs.refresh(files, &document)?;
            docs.apply(&document, command)
        })
        .await?,
    ))
}

async fn save(
    Extension(access): Extension<RemoteAccess>,
    Path((_key, document)): Path<(String, String)>,
    Json(version): Json<Version>,
) -> std::result::Result<Json<DocumentState>, ApiError> {
    Ok(Json(
        run_documents(access.grant.vault.clone(), true, move |files, docs| {
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
    Extension(access): Extension<RemoteAccess>,
    Path((_key, document)): Path<(String, String)>,
    Json(body): Json<ClientCommit>,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    Ok(Json(run_documents(access.grant.vault.clone(), true, move |files, docs| {
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
    Extension(access): Extension<RemoteAccess>,
) -> std::result::Result<Response, ApiError> {
    let vault = access.grant.vault.clone();
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
    use crate::testing::Host;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use serde_json::{Value, json};
    use tower::ServiceExt;

    async fn request(router: &Host, method: &str, path: &str, body: Value) -> Value {
        let response = router
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(router.uri(path))
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
                vault: crate::VaultConfig {
                    name: "Notes".into(),
                    path: root.path().into(),
                    ephemeral: true,
                    ..Default::default()
                },
            },
            root.path(),
        )
        .unwrap();
        let stopping = server.shutdown.clone();
        let router = Host::new(server);
        let docs = request(&router, "GET", "/documents", Value::Null).await;
        let mut state = docs[0].clone();
        let id = state["id"].as_str().unwrap().to_owned();
        let response = router
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(router.uri("/documents/events"))
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
            let transaction = json!({"kind":"edit","base":state["snapshot"]["version"],"origin":"test","input":{"kind":"edits","edits":[{"from":end,"to":end,"insert":"x"}]},"undo":{"metadata":null,"positions":[]}});
            state = request(
                &router,
                "POST",
                &format!("/documents/{id}/apply"),
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
            &format!("/documents/{id}/apply"),
            json!({"kind":"edit","base":state["snapshot"]["version"],"origin":"test","input":{"kind":"edits","edits":[{"from":end,"to":end,"insert":"y"}]},"undo":{"metadata":null,"positions":[]}}),
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
        stopping.send_replace(true);
        assert!(
            tokio::time::timeout(Duration::from_secs(5), body.frame())
                .await
                .unwrap()
                .is_none()
        );
    }
}
