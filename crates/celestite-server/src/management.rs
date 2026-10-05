//! This router is served only on the host's private Unix socket.
use crate::{failure, shares::Permission, ApiError, ServerState};
use axum::{
    extract::{Path, State},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    permission: Permission,
    #[serde(default)]
    label: String,
}

pub(crate) fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route("/vaults/{vault}/shares", get(list).post(create))
        .route(
            "/vaults/{vault}/shares/{share}",
            axum::routing::delete(revoke),
        )
        .layer(axum::extract::DefaultBodyLimit::max(4096))
}
fn vault(state: &ServerState, id: &str) -> Result<Arc<crate::HostedVault>, ApiError> {
    state
        .vaults
        .get(id)
        .cloned()
        .ok_or_else(|| failure("NotFound", "Vault not found"))
}
async fn list(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
) -> Result<Json<Vec<crate::Share>>, ApiError> {
    Ok(Json(vault(&state, &id)?.shares.list()))
}
async fn create(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
    Json(input): Json<Create>,
) -> Result<Json<crate::CreatedShare>, ApiError> {
    state
        .shares
        .create(vault(&state, &id)?, input.permission, input.label)
        .map(Json)
        .map_err(|error| {
            tracing::error!(%error, "Share creation failed");
            failure("IO", "Share creation failed")
        })
}
async fn revoke(
    State(state): State<Arc<ServerState>>,
    Path((id, share)): Path<(String, String)>,
) -> Result<axum::http::StatusCode, ApiError> {
    state
        .shares
        .revoke(&vault(&state, &id)?, &share)
        .await
        .map_err(|error| {
            tracing::error!(%error, "Share revocation failed");
            failure("NotFound", "Share revocation failed")
        })?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}
