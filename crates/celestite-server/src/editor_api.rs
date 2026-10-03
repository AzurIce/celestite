//! HTTP is a headless reference host/transport, not part of the core.
use crate::vault::{
    documents::{DocumentState, Documents},
    fs::{ChangeHint, FsVault, Result, VaultError},
};
use crate::{failure, get_vault, ApiError, HostedVault, ServerState};
use axum::{
    extract::{Path, State},
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
    tokio::task::spawn_blocking(move || {
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
            docs.updates(&document, &version)
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
            let result = docs.import(&document, packet)?;
            Ok(Reply {
                result,
                document: docs.state(files, &document)?,
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
            docs.state(files, &document)
        })
        .await?,
    ))
}
