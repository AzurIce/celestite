//! Tauri hosts native editing and analysis. The WebView carries the existing UI.
#![recursion_limit = "256"]
mod analysis;
mod app_documents;
mod assets;
mod commands;
mod runtime;

use app_documents::AppDocuments;
use assets::AssetStore;
use celestite_core::error::{EditorError, ErrorCode};
use runtime::DesktopRuntime;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::{Emitter, Manager};

struct DesktopState {
    runtime: Arc<DesktopRuntime>,
    documents: Arc<AppDocuments>,
    client: Arc<Mutex<Option<String>>>,
    allow_exit: Arc<AtomicBool>,
}

fn io_error(error: impl std::fmt::Display) -> EditorError {
    EditorError::new(ErrorCode::Io, error.to_string(), "")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let assets = Arc::new(AssetStore::default());
    let protocol_assets = assets.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(assets)
        .register_uri_scheme_protocol("celestite-preview", move |context, request| {
            protocol_assets.response(context.webview_label(), request.uri().path())
        })
        .setup(|app| {
            let data = match std::env::var_os("CELESTITE_APP_DATA_DIR") {
                Some(path) => std::path::PathBuf::from(path),
                None => app.path().app_data_dir()?,
            };
            let documents = Arc::new(AppDocuments::open(&data)?);
            let runtime = Arc::new(DesktopRuntime::open(&data)?);
            app.manage(DesktopState {
                runtime,
                documents,
                client: Arc::new(Mutex::new(None)),
                allow_exit: Arc::new(AtomicBool::new(false)),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let confirmed = window
                    .app_handle()
                    .try_state::<DesktopState>()
                    .is_some_and(|state| state.allow_exit.load(Ordering::Acquire));
                if !confirmed {
                    api.prevent_close();
                    let _ = window.emit("celestite://close-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::desktop_open,
            commands::desktop_core,
            commands::desktop_preview,
            commands::desktop_language,
            commands::desktop_preview_requests,
            commands::desktop_preview_render,
            commands::desktop_package_read,
            commands::desktop_package_directory,
            commands::desktop_close,
            commands::desktop_shutdown,
            commands::desktop_changes,
            commands::desktop_git_status,
            commands::desktop_app_read,
            commands::desktop_app_write,
            commands::desktop_pick_directory,
            commands::desktop_export,
            commands::desktop_assets_register,
            commands::desktop_assets_clear,
        ])
        .build(tauri::generate_context!())
        .expect("Cannot start Celestite desktop");

    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let confirmed = app
                .try_state::<DesktopState>()
                .is_some_and(|state| state.allow_exit.load(Ordering::Acquire));
            if !confirmed {
                api.prevent_exit();
                let _ = app.emit("celestite://close-requested", ());
            }
        }
    });
}
