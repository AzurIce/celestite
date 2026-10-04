//! HTTP is a headless reference host/transport, not part of the core.
use crate::vault::{
    documents::{DocumentState, Documents},
    fs::{ChangeHint, FsVault, Result, VaultError},
};
use crate::{failure, get_vault, ApiError, HostedVault, ServerState};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    routing::{get, post},
    Json, Router,
};
use celestite_core::{ChangeEvent, ImportResult, SyncPacket, Transaction, UndoContext, Version};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route("/api/v1/vaults/{id}/documents", get(list))
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
        if mutation {
            let _ = vault.events.send(ChangeHint::all());
        }
        result
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
