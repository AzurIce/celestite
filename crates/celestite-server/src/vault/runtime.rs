//! Serial execution and publication shared by every host adapter.
use super::{
    documents::Documents,
    fs::{ChangeHint, FsVault, Result, VaultError},
};
use crate::{failure, ApiError, HostedVault};
use std::sync::Arc;

pub(crate) async fn execute<T: Send + 'static>(
    vault: Arc<HostedVault>,
    mutation: bool,
    action: impl FnOnce(&FsVault, &mut Documents) -> Result<T> + Send + 'static,
) -> std::result::Result<T, ApiError> {
    execute_with_tree(vault, mutation, true, action).await
}
pub(crate) async fn execute_with_tree<T: Send + 'static>(
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
        execute_locked(&vault, mutation, notify_tree, action)
    })
    .await
    .map_err(|_| failure("IO", "Document operation failed"))?
    .map_err(Into::into)
}

/// Background observation uses the same serial boundary and publication even
/// when its action fails after accepting text. Permission is checked by adapters.
pub(crate) fn execute_locked<T>(
    vault: &HostedVault,
    mutation: bool,
    notify_tree: bool,
    action: impl FnOnce(&FsVault, &mut Documents) -> Result<T>,
) -> Result<T> {
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
}

pub(crate) async fn execute_files<T: Send + 'static>(
    vault: Arc<HostedVault>,
    mutation: bool,
    action: impl FnOnce(&FsVault) -> Result<T> + Send + 'static,
) -> std::result::Result<T, ApiError> {
    if mutation && vault.read_only {
        return Err(failure("PermissionDenied", "Vault is read-only"));
    }
    let span = tracing::Span::current();
    tokio::task::spawn_blocking(move || {
        let _entered = span.enter();
        tracing::debug!(vault_identity = %vault.id, mutation, "Running file operation");
        if !mutation {
            // Immutable directory capabilities can read outside the projection
            // mutation lock. A slow download must not hold text acceptance.
            let files = vault
                .files
                .lock()
                .map_err(|_| VaultError::new("IO", "Vault operation lock failed", ""))?
                .clone();
            return action(&files);
        }
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
