//! HTTP file and event endpoints for one hosted Vault.
use crate::vault::changes::ChangeHint;
use crate::vault::runtime::{execute, execute_files};
use crate::{failure, ApiError, RemoteAccess, ServerState};
use axum::{
    body::Bytes,
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Extension, Json, Router,
};
use celestite_core::error::{EditorError, ErrorCode};
use celestite_core::fs::native::revision;
use celestite_core::fs::WriteMode;
use serde::Deserialize;
use std::{convert::Infallible, sync::Arc, time::Duration};
use tokio_stream::{
    wrappers::{BroadcastStream, WatchStream},
    StreamExt,
};

pub(crate) fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route("/{id}/api/v5", get(describe))
        .route("/{id}/api/v5/stat", get(stat))
        .route("/{id}/api/v5/directory", get(read_dir).post(mkdir))
        .route("/{id}/api/v5/file", get(read_file).put(write_file))
        .route("/{id}/api/v5/entry", axum::routing::delete(remove))
        .route("/{id}/api/v5/rename", post(rename))
        .route("/{id}/api/v5/events", get(events))
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
        .map_err(|_| failure(ErrorCode::Io, "Document lock failed"))?;
    Ok(Json(
        serde_json::json!({ "protocol": "celestite-vault", "protocolVersion": crate::PROTOCOL_VERSION, "shareId": grant.id, "name": vault.name, "readOnly": grant.read_only(), "previewResourceRoot": vault.packages.resources.root, "vault": documents.identity, "capabilities": { "watch": true, "conditionalWrite": true, "documentEditing": true, "documentEvents": true, "websocketSync": true, "vaultCrdt": false } }),
    ))
}
async fn stat(
    Extension(access): Extension<RemoteAccess>,
    Query(query): Query<FileQuery>,
) -> Result<Json<Option<celestite_core::fs::FileEntry>>, ApiError> {
    Ok(Json(
        execute_files(access.grant.vault.clone(), false, move |v| {
            v.stat(&query.path)
        })
        .await?,
    ))
}
async fn read_dir(
    Extension(access): Extension<RemoteAccess>,
    Query(query): Query<FileQuery>,
) -> Result<Json<Vec<celestite_core::fs::FileEntry>>, ApiError> {
    Ok(Json(
        execute_files(access.grant.vault.clone(), false, move |v| {
            v.read_dir(&query.path)
        })
        .await?,
    ))
}
async fn read_file(
    Extension(access): Extension<RemoteAccess>,
    Query(query): Query<FileQuery>,
) -> Result<Response, ApiError> {
    let bytes = execute_files(access.grant.vault.clone(), false, move |v| {
        if v.stat(&query.path)?
            .and_then(|e| e.size)
            .is_some_and(|s| s > 64 * 1024 * 1024)
        {
            return Err(EditorError::new(
                ErrorCode::Unsupported,
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
            ErrorCode::Conflict,
            "Replace requires the version returned by reading the file",
        ));
    }
    let version = execute(access.grant.vault.clone(), true, move |v, documents| {
        documents.before_replace(&query.path)?;
        let version = v.write_file(
            &query.path,
            &bytes,
            match query.mode.as_deref() {
                Some("create") => WriteMode::Create,
                Some("replace") => WriteMode::Replace,
                _ => {
                    return Err(EditorError::new(
                        ErrorCode::InvalidPath,
                        "Expected create or replace write mode",
                        &query.path,
                    ))
                }
            },
            expected.as_deref(),
        )?;
        documents.refresh_path(&query.path)?;
        Ok(version)
    })
    .await?;
    Ok((StatusCode::NO_CONTENT, [(header::ETAG, version)]).into_response())
}
async fn mkdir(
    Extension(access): Extension<RemoteAccess>,
    Query(query): Query<FileQuery>,
) -> Result<StatusCode, ApiError> {
    execute_files(access.grant.vault.clone(), true, move |v| {
        v.mkdir(&query.path, query.recursive)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn remove(
    Extension(access): Extension<RemoteAccess>,
    Query(query): Query<FileQuery>,
) -> Result<StatusCode, ApiError> {
    execute(access.grant.vault.clone(), true, move |_, documents| {
        documents.remove(&query.path, query.recursive)
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
    execute(access.grant.vault.clone(), true, move |_, documents| {
        documents.rename(&args.from, &args.to)
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
