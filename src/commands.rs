//! IPC adapter for application-owned sessions and shared editor policy.
use crate::{
    DesktopState,
    app_documents::AppDocument,
    assets::{AssetFile, AssetStore},
    runtime::{OpenSource, SessionDescriptor},
};
use celestite_core::{
    error::{EditorError, EditorResult},
    fs::FileEntry,
    preview::{
        PreviewCompletion, PreviewResource, PreviewResourceRequest, PreviewTask, compute_preview,
    },
};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

async fn blocking<T: Send + 'static>(
    action: impl FnOnce() -> EditorResult<T> + Send + 'static,
) -> EditorResult<T> {
    tauri::async_runtime::spawn_blocking(action)
        .await
        .map_err(crate::io_error)?
}

#[tauri::command]
pub async fn desktop_open(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    assets: State<'_, Arc<AssetStore>>,
    source: OpenSource,
    client_id: String,
) -> EditorResult<SessionDescriptor> {
    let runtime = state.runtime.clone();
    let client = state.client.clone();
    let assets = assets.inner().clone();
    let owner = window.label().to_owned();
    let allow_exit = state.allow_exit.clone();
    blocking(move || {
        let mut previous = client.lock().map_err(crate::io_error)?;
        if previous.as_ref() != Some(&client_id) {
            runtime.reset_views()?;
            assets.clear_owner(&owner)?;
            *previous = Some(client_id);
        }
        let session = runtime.open_session(source)?;
        allow_exit.store(false, std::sync::atomic::Ordering::Release);
        Ok(session)
    })
    .await
}
#[tauri::command]
pub async fn desktop_core(
    state: State<'_, DesktopState>,
    handle: String,
    method: String,
    params: Value,
) -> EditorResult<Value> {
    let runtime = state.runtime.clone();
    blocking(move || runtime.core(&handle, &method, params)).await
}
#[tauri::command]
pub async fn desktop_preview(
    state: State<'_, DesktopState>,
    handle: String,
    method: String,
    params: Value,
) -> EditorResult<Value> {
    let runtime = state.runtime.clone();
    blocking(move || runtime.preview(&handle, &method, params)).await
}
#[tauri::command]
pub async fn desktop_preview_requests(
    task: PreviewTask,
) -> EditorResult<Vec<PreviewResourceRequest>> {
    blocking(move || {
        crate::analysis::run(|| celestite_core::preview::project::preview_resource_requests(&task))
    })
    .await
}
#[tauri::command]
pub async fn desktop_preview_render(task: PreviewTask) -> EditorResult<PreviewCompletion> {
    blocking(move || crate::analysis::run(|| compute_preview(&task))).await
}
#[tauri::command]
pub async fn desktop_package_read(
    state: State<'_, DesktopState>,
    handle: String,
    task: PreviewTask,
    request: PreviewResourceRequest,
) -> EditorResult<PreviewResource> {
    let runtime = state.runtime.clone();
    blocking(move || runtime.package_read(&handle, task, request)).await
}
#[tauri::command]
pub async fn desktop_package_directory(
    state: State<'_, DesktopState>,
    handle: String,
    task: PreviewTask,
    path: String,
) -> EditorResult<Vec<FileEntry>> {
    let runtime = state.runtime.clone();
    blocking(move || runtime.package_directory(&handle, task, &path)).await
}
#[tauri::command]
pub async fn desktop_close(state: State<'_, DesktopState>, handle: String) -> EditorResult<()> {
    let runtime = state.runtime.clone();
    blocking(move || runtime.close_session(&handle)).await
}
#[tauri::command]
pub async fn desktop_shutdown(state: State<'_, DesktopState>) -> EditorResult<()> {
    let runtime = state.runtime.clone();
    let client = state.client.clone();
    let allow_exit = state.allow_exit.clone();
    blocking(move || {
        // Opening a new owner and publishing exit confirmation must have the
        // same order. Otherwise a concurrent open can fall between shutdown
        // and this flag, leaving a live owner behind a stale confirmation.
        let _client = client.lock().map_err(crate::io_error)?;
        runtime.shutdown()?;
        allow_exit.store(true, std::sync::atomic::Ordering::Release);
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn desktop_changes(state: State<'_, DesktopState>, handle: String) -> EditorResult<bool> {
    let runtime = state.runtime.clone();
    blocking(move || runtime.changes(&handle)).await
}
#[tauri::command]
pub async fn desktop_app_read(
    state: State<'_, DesktopState>,
    name: AppDocument,
) -> EditorResult<Option<String>> {
    let documents = state.documents.clone();
    blocking(move || documents.read(name)).await
}
#[tauri::command]
pub async fn desktop_app_write(
    state: State<'_, DesktopState>,
    name: AppDocument,
    document: Value,
) -> EditorResult<()> {
    let documents = state.documents.clone();
    blocking(move || documents.write(name, &document)).await
}
#[tauri::command]
pub async fn desktop_pick_directory(app: AppHandle) -> EditorResult<Option<String>> {
    blocking(move || {
        app.dialog()
            .file()
            .set_title("打开 Vault 目录")
            .blocking_pick_folder()
            .map(|path| {
                let path = path.into_path().map_err(crate::io_error)?;
                let canonical = path.canonicalize().map_err(crate::io_error)?;
                Ok(crate::runtime::display_directory(&canonical))
            })
            .transpose()
    })
    .await
}
#[tauri::command]
pub async fn desktop_export(app: AppHandle, name: String, data: Vec<u8>) -> EditorResult<bool> {
    blocking(move || {
        let name = name
            .rsplit(['/', '\\'])
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or("document");
        let Some(path) = app
            .dialog()
            .file()
            .set_title("导出文件")
            .set_file_name(name)
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = path.into_path().map_err(crate::io_error)?;
        celestite_core::fs::native::write_bytes(&path, &data)?;
        Ok(true)
    })
    .await
}
#[tauri::command]
pub async fn desktop_assets_register(
    window: WebviewWindow,
    state: State<'_, Arc<AssetStore>>,
    scope: String,
    digest: String,
    files: Vec<AssetFile>,
) -> EditorResult<()> {
    state.register(window.label(), &scope, &digest, files)
}
#[tauri::command]
pub async fn desktop_assets_clear(
    window: WebviewWindow,
    state: State<'_, Arc<AssetStore>>,
    scope: String,
) -> Result<(), EditorError> {
    state.clear(window.label(), &scope)
}
