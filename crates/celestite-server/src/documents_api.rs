//! Read-only document inspection. Collaboration uses the session protocol.
use crate::vault::changes::DocumentEvent;
use crate::vault::runtime::execute;
use crate::{ApiError, RemoteAccess, ServerState};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Extension, Json, Router,
};
use celestite_core::{SyncPacket, Version};
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
        .layer(DefaultBodyLimit::max(80 * 1024 * 1024))
}

async fn list(
    Extension(access): Extension<RemoteAccess>,
) -> std::result::Result<Json<Vec<celestite_core::EditorDocument>>, ApiError> {
    Ok(Json(
        execute(access.grant.vault.clone(), false, |_, docs| docs.list()).await?,
    ))
}

#[derive(Deserialize)]
struct Open {
    path: String,
}
async fn open(
    Extension(access): Extension<RemoteAccess>,
    Json(body): Json<Open>,
) -> std::result::Result<Json<celestite_core::EditorDocument>, ApiError> {
    Ok(Json(
        execute(access.grant.vault.clone(), false, move |_, docs| {
            let id = docs.open_file(&body.path)?;
            docs.state(&id)
        })
        .await?,
    ))
}

async fn state(
    Extension(access): Extension<RemoteAccess>,
    Path((_key, document)): Path<(String, String)>,
) -> std::result::Result<Json<celestite_core::EditorDocument>, ApiError> {
    Ok(Json(
        execute(access.grant.vault.clone(), false, move |_, docs| {
            docs.refresh(&document)?;
            docs.state(&document)
        })
        .await?,
    ))
}

async fn snapshot(
    Extension(access): Extension<RemoteAccess>,
    Path((_key, document)): Path<(String, String)>,
) -> std::result::Result<Json<SyncPacket>, ApiError> {
    Ok(Json(
        execute(access.grant.vault.clone(), false, move |_, docs| {
            docs.refresh(&document)?;
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
        execute(access.grant.vault.clone(), false, move |_, docs| {
            docs.refresh(&document)?;
            let packet = docs.updates(&document, &version)?;
            tracing::debug!(document_id = %document, bytes = packet.data.len(), "CRDT updates exported");
            Ok(packet)
        })
        .await?,
    ))
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
    let subscription = execute(vault.clone(), false, |_, docs| docs.subscribe()).await?;
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
                        match execute(vault.clone(), false, |_, docs| docs.subscribe()).await {
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
