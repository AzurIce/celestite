use super::{DesktopRuntime, OpenSource};
use celestite_core::{
    error::ErrorCode,
    instance::{InstanceIdentity, Vault},
    preview::{
        PreviewResourceRequest, PreviewTask, ResourceContext, compute_preview_native,
        project::preview_resource_requests,
    },
};
use serde_json::{Value, json};
use std::sync::Arc;

fn value(runtime: &DesktopRuntime, handle: &str, method: &str, params: Value) -> Value {
    let reply = runtime.core(handle, method, params).unwrap();
    assert_eq!(reply["status"], "ok", "{reply}");
    reply["value"].clone()
}
fn edit(runtime: &DesktopRuntime, handle: &str, document: &Value, text: &str) -> Value {
    runtime
        .core(
            handle,
            "apply",
            json!({"id":document["id"], "command": {
                "kind":"edit", "base":document["version"], "input":{"kind":"text", "text":text},
                "undo":{"metadata":{"selection":"caret"}, "positions":[0]}
            }}),
        )
        .unwrap()
}
fn remote_source() -> OpenSource {
    OpenSource::Remote {
        identity: InstanceIdentity {
            instance_id: "desktop-replica".into(),
            vault: Vault {
                vault_id: "remote".into(),
                history_id: "remote-history".into(),
            },
        },
    }
}

fn take_task(runtime: &DesktopRuntime, handle: &str, document: &Value) -> PreviewTask {
    let source = value(
        runtime,
        handle,
        "document_source",
        json!({"ids":[document["id"]]}),
    );
    runtime
        .preview(handle, "synchronize", json!({"source":source}))
        .unwrap();
    runtime
        .preview(
            handle,
            "subscribe",
            json!({"id":document["id"],"sessionId":"view"}),
        )
        .unwrap();
    serde_json::from_value(
        runtime
            .preview(
                handle,
                "take_task",
                json!({"id":document["id"],"source":source}),
            )
            .unwrap(),
    )
    .unwrap()
}

fn await_change(runtime: &DesktopRuntime, handle: &str) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if runtime.changes(handle).unwrap() {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "native watcher did not report a write"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// First-time registration itself invalidates the snapshot, closing the gap
/// between dependency discovery and attaching its non-recursive directory watch.
fn drain_watch_changes(runtime: &DesktopRuntime, handle: &str) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut quiet_since = std::time::Instant::now();
    loop {
        if runtime.changes(handle).unwrap() {
            quiet_since = std::time::Instant::now();
        }
        if quiet_since.elapsed() >= std::time::Duration::from_millis(150) {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "native watcher did not settle"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

fn ready_root_watch(runtime: &DesktopRuntime, handle: &str) {
    value(
        runtime,
        handle,
        "file",
        json!({"method":"readDir", "path":""}),
    );
    drain_watch_changes(runtime, handle);
}

fn assert_no_watch_change(runtime: &DesktopRuntime, handle: &str) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(200);
    while std::time::Instant::now() < deadline {
        assert!(
            !runtime.changes(handle).unwrap(),
            "an unvisited directory produced a watch hint"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[test]
fn private_recovery_cannot_be_exposed_by_opening_an_app_data_ancestor() {
    let directory = tempfile::tempdir().unwrap();
    let app_data = directory.path().join("app-data");
    let runtime = DesktopRuntime::open(&app_data).unwrap();
    for root in [directory.path(), app_data.as_path()] {
        let error = runtime
            .open_session(OpenSource::Directory {
                path: root.to_str().unwrap().into(),
            })
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidPath);
    }
    assert_eq!(std::fs::read_dir(&app_data).unwrap().count(), 0);
    assert!(runtime.sessions.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn private_recovery_rejects_symlinks_into_the_vault_before_creating_metadata() {
    for redirect_parent in [false, true] {
        let storage = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        let runtime = DesktopRuntime::open(storage.path()).unwrap();
        let instances = storage.path().join("instances");
        if redirect_parent {
            std::os::unix::fs::symlink(&root, &instances).unwrap();
        } else {
            std::fs::create_dir(&instances).unwrap();
            let key = blake3::hash(super::path_string(&root).unwrap().as_bytes())
                .to_hex()
                .to_string();
            std::os::unix::fs::symlink(&root, instances.join(key)).unwrap();
        }
        let error = runtime
            .open_session(OpenSource::Directory {
                path: root.to_str().unwrap().into(),
            })
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidPath);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        assert!(runtime.sessions.lock().unwrap().is_empty());
    }
}

#[test]
fn native_text_recovery_preserves_drafts_and_renews_crdt_identity_across_owners() {
    let storage = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("a.md"), "A😀甲\r\n").unwrap();
    let runtime = DesktopRuntime::open(storage.path()).unwrap();
    let source = OpenSource::Directory {
        path: vault.path().to_str().unwrap().into(),
    };
    let session = runtime.open_session(source.clone()).unwrap();
    assert_eq!(
        runtime.open_session(source.clone()).unwrap().handle,
        session.handle
    );
    let alias = runtime
        .open_session(OpenSource::Directory {
            path: vault.path().join(".").to_str().unwrap().into(),
        })
        .unwrap();
    assert_eq!(alias.handle, session.handle);
    let opened = value(&runtime, &session.handle, "open", json!({"path":"a.md"}));
    assert_eq!(opened["snapshot"]["text"], "A😀甲\n");
    let receipt = edit(&runtime, &session.handle, &opened, "A😀新\n");
    assert_eq!(receipt["status"], "ok");
    assert_eq!(receipt["mutations"].as_array().unwrap().len(), 1);
    let reconnected = runtime.open_session(source.clone()).unwrap();
    assert_eq!(reconnected.handle, session.handle);
    assert_eq!(reconnected.identity, session.identity);
    let connected_draft = value(
        &runtime,
        &reconnected.handle,
        "read",
        json!({"id":opened["id"]}),
    );
    assert_eq!(connected_draft["snapshot"]["text"], "A😀新\n");
    assert_eq!(connected_draft["undo"]["canUndo"], true);
    assert_eq!(receipt["mutations"][0]["update"]["beforeLen"], 5);
    assert_eq!(
        std::fs::read_to_string(vault.path().join("a.md")).unwrap(),
        "A😀甲\r\n"
    );
    runtime.close_session(&session.handle).unwrap();
    assert_eq!(
        runtime
            .core(&session.handle, "resident", json!({}))
            .unwrap_err()
            .code,
        ErrorCode::Closed
    );

    let reopened = runtime.open_session(source).unwrap();
    assert_eq!(reopened.identity.instance_id, session.identity.instance_id);
    assert_eq!(
        reopened.identity.vault.vault_id,
        session.identity.vault.vault_id
    );
    assert_ne!(
        reopened.identity.vault.history_id,
        session.identity.vault.history_id
    );
    let draft = value(&runtime, &reopened.handle, "open", json!({"path":"a.md"}));
    assert_ne!(draft["id"], opened["id"]);
    assert_ne!(draft["version"]["identity"], opened["version"]["identity"]);
    assert_eq!(draft["snapshot"]["text"], "A😀新\n");
    assert!(draft.get("persistedVersion").is_none());
    assert_eq!(draft["dirty"], true);
    assert_ne!(draft["peerId"], opened["peerId"]);
    assert_eq!(draft["undo"]["canUndo"], false);
    let saved = value(
        &runtime,
        &reopened.handle,
        "save",
        json!({"id":draft["id"]}),
    );
    assert_eq!(saved["dirty"], false);
    assert_eq!(
        std::fs::read_to_string(vault.path().join("a.md")).unwrap(),
        "A😀新\r\n"
    );
    runtime.shutdown().unwrap();
}

#[test]
fn failed_file_operation_delivers_external_mutations_before_its_error() {
    let storage = tempfile::tempdir().unwrap();
    let runtime = DesktopRuntime::open(storage.path()).unwrap();
    let session = runtime.open_session(OpenSource::Default).unwrap();
    let root = std::path::Path::new(session.root.as_ref().unwrap());
    std::fs::write(root.join("a.md"), "old").unwrap();
    std::fs::write(root.join("existing.md"), "untouched").unwrap();
    let opened = value(&runtime, &session.handle, "open", json!({"path":"a.md"}));
    std::fs::write(root.join("a.md"), "external").unwrap();
    let reply = runtime
        .core(
            &session.handle,
            "file",
            json!({"method":"rename","from":"a.md","to":"existing.md"}),
        )
        .unwrap();
    assert_eq!(reply["status"], "error", "{reply}");
    assert_eq!(reply["error"]["code"], "AlreadyExists");
    assert!(
        reply["mutations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|mutation| mutation["document"]["snapshot"]["text"] == "external"),
        "{reply}"
    );
    let next = runtime
        .core(&session.handle, "read", json!({"id":opened["id"]}))
        .unwrap();
    assert_eq!(next["value"]["snapshot"]["text"], "external");
    assert_eq!(next["mutations"], json!([]));
    assert_eq!(
        std::fs::read_to_string(root.join("existing.md")).unwrap(),
        "untouched"
    );
    runtime.shutdown().unwrap();
}

#[test]
fn failed_close_and_shutdown_keep_all_owners_until_text_checkpoint_can_retry() {
    let storage = tempfile::tempdir().unwrap();
    let runtime = DesktopRuntime::open(storage.path()).unwrap();
    let session = runtime.open_session(OpenSource::Default).unwrap();
    let other = runtime.open_session(remote_source()).unwrap();
    std::fs::write(
        std::path::Path::new(session.root.as_ref().unwrap()).join("a.md"),
        "old",
    )
    .unwrap();
    let opened = value(&runtime, &session.handle, "open", json!({"path":"a.md"}));
    let id = opened["id"].as_str().unwrap();
    let recovery = storage.path().join("default/history/recovery");
    let held = recovery.with_file_name("held-recovery");
    std::fs::rename(&recovery, &held).unwrap();
    std::fs::write(&recovery, "IO fault: directory replaced with a file").unwrap();
    let accepted = edit(&runtime, &session.handle, &opened, "accepted draft");
    assert_eq!(accepted["status"], "ok");
    assert!(accepted["mutations"][0]["document"]["recoveryError"].is_null());
    assert!(accepted["mutations"][0].get("history").is_none());
    assert_eq!(
        accepted["mutations"][0]["document"]["snapshot"]["text"],
        "accepted draft"
    );
    assert!(runtime.close_session(&session.handle).is_err());
    assert!(
        value(&runtime, &session.handle, "read", json!({"id":id}))["recoveryError"].is_string()
    );
    assert!(runtime.shutdown().is_err());
    assert_eq!(
        value(&runtime, &session.handle, "read", json!({"id":id}))["snapshot"]["text"],
        "accepted draft"
    );
    assert_eq!(
        value(&runtime, &other.handle, "resident", json!({})),
        json!([])
    );

    std::fs::remove_file(&recovery).unwrap();
    std::fs::rename(&held, &recovery).unwrap();
    runtime.shutdown().unwrap();
    let reopened = runtime.open_session(OpenSource::Default).unwrap();
    let document = value(&runtime, &reopened.handle, "open", json!({"path":"a.md"}));
    assert_ne!(document["id"], opened["id"]);
    assert_eq!(document["snapshot"]["text"], "accepted draft");
    assert!(document.get("persistedVersion").is_none());
    assert!(document["recoveryError"].is_null());
    runtime.shutdown().unwrap();
}

#[test]
fn preview_executes_native_snapshots_and_revokes_superseded_results() {
    let storage = tempfile::tempdir().unwrap();
    let runtime = DesktopRuntime::open(storage.path()).unwrap();
    let session = runtime.open_session(OpenSource::Default).unwrap();
    std::fs::write(
        std::path::Path::new(session.root.as_ref().unwrap()).join("a.md"),
        "# Hello 😀\n",
    )
    .unwrap();
    let opened = value(&runtime, &session.handle, "open", json!({"path":"a.md"}));
    let source = value(
        &runtime,
        &session.handle,
        "document_source",
        json!({"ids":[opened["id"]]}),
    );
    runtime
        .preview(&session.handle, "synchronize", json!({"source":source}))
        .unwrap();
    let subscription = runtime
        .preview(
            &session.handle,
            "subscribe",
            json!({"id":opened["id"], "sessionId":"view"}),
        )
        .unwrap();
    assert!(subscription["subscriptionId"].is_string());
    let mut task: PreviewTask = serde_json::from_value(
        runtime
            .preview(
                &session.handle,
                "take_task",
                json!({"id":opened["id"], "source":source}),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(task.resource_root, session.root.unwrap());
    for _ in 0..16 {
        let requests = preview_resource_requests(&task);
        if requests.is_empty() {
            break;
        }
        for request in requests {
            let key = request.path.clone();
            let resource = runtime
                .package_read(&session.handle, ResourceContext::from(&task), request)
                .unwrap();
            task.resources.insert(key, resource);
        }
    }
    assert!(preview_resource_requests(&task).is_empty());
    let completion = compute_preview_native(&task);
    assert_eq!(
        runtime
            .preview(
                &session.handle,
                "complete",
                json!({"completion":completion})
            )
            .unwrap(),
        true
    );
    let ready = runtime
        .preview(&session.handle, "state", json!({"id":opened["id"]}))
        .unwrap();
    assert_eq!(ready["status"], "ready", "{ready}");
    assert!(
        ready["result"]["output"]["html"]
            .as_str()
            .unwrap()
            .contains("Hello")
    );
    runtime
        .preview(&session.handle, "clear", json!({}))
        .unwrap();
    assert_eq!(
        runtime
            .preview(
                &session.handle,
                "complete",
                json!({"completion":completion})
            )
            .unwrap(),
        false
    );
    runtime.shutdown().unwrap();
}

#[test]
fn runtime_is_shareable_and_session_close_serializes_with_calls() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<DesktopRuntime>();
    let storage = tempfile::tempdir().unwrap();
    let runtime = Arc::new(DesktopRuntime::open(storage.path()).unwrap());
    let first = runtime.open_session(remote_source()).unwrap();
    let second = runtime.open_session(remote_source()).unwrap();
    let tasks: Vec<_> = [first.handle.clone(), second.handle.clone()]
        .into_iter()
        .map(|handle| {
            let runtime = runtime.clone();
            std::thread::spawn(move || {
                for _ in 0..20 {
                    assert_eq!(value(&runtime, &handle, "resident", json!({})), json!([]));
                }
                runtime.close_session(&handle).unwrap();
            })
        })
        .collect();
    for task in tasks {
        task.join().unwrap();
    }
    runtime.shutdown().unwrap();
}

#[test]
fn native_watch_hints_ignore_reads_and_private_edits_but_report_projection_writes() {
    let storage = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    std::fs::write(vault.path().join("a.md"), "old").unwrap();
    let runtime = DesktopRuntime::open(storage.path()).unwrap();
    let session = runtime
        .open_session(OpenSource::Directory {
            path: vault.path().to_str().unwrap().into(),
        })
        .unwrap();
    ready_root_watch(&runtime, &session.handle);
    assert!(!runtime.changes(&session.handle).unwrap());
    let document = value(&runtime, &session.handle, "open", json!({"path":"a.md"}));
    assert_eq!(
        edit(&runtime, &session.handle, &document, "private draft")["status"],
        "ok"
    );
    std::thread::sleep(std::time::Duration::from_millis(100));
    drain_watch_changes(&runtime, &session.handle);
    assert!(!runtime.changes(&session.handle).unwrap());
    std::fs::write(vault.path().join("a.md"), "external").unwrap();
    await_change(&runtime, &session.handle);
    let remote = runtime.open_session(remote_source()).unwrap();
    assert!(!runtime.changes(&remote.handle).unwrap());
    runtime.shutdown().unwrap();
}

#[test]
fn package_grants_follow_snapshot_dependencies_and_watch_external_components() {
    let storage = tempfile::tempdir().unwrap();
    let repository = tempfile::tempdir().unwrap();
    let root = repository.path().canonicalize().unwrap();
    let docs = root.join("docs");
    let package = root.join("widgets");
    std::fs::create_dir_all(&docs).unwrap();
    std::fs::create_dir_all(package.join("panel")).unwrap();
    std::fs::write(
        docs.join("a.not"),
        "#import \"../widgets/lib.notc\" as widgets;\n\n#widgets.panel()[body]",
    )
    .unwrap();
    std::fs::write(docs.join("b.not"), "plain\n").unwrap();
    std::fs::write(
        package.join("lib.notc"),
        "fn panel()[children: BlockContent] -> BlockContent;",
    )
    .unwrap();
    std::fs::write(package.join("private.txt"), "private").unwrap();
    let component = package.join("panel/index.js");
    std::fs::write(&component, "export default class extends HTMLElement {}").unwrap();
    let runtime = DesktopRuntime::open(storage.path()).unwrap();
    let session = runtime
        .open_session(OpenSource::Directory {
            path: docs.to_str().unwrap().into(),
        })
        .unwrap();
    let document = value(&runtime, &session.handle, "open", json!({"path":"a.not"}));
    let task = take_task(&runtime, &session.handle, &document);
    let declaration = super::display_directory(&package.join("lib.notc"));
    let resource = runtime
        .package_read(
            &session.handle,
            ResourceContext::from(&task),
            PreviewResourceRequest {
                path: declaration.clone(),
                read: true,
            },
        )
        .unwrap();
    assert!(!resource.data.unwrap().is_empty());
    let entries = runtime
        .package_directory(
            &session.handle,
            ResourceContext::from(&task),
            &super::display_directory(&package.join("panel")),
        )
        .unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path, super::display_directory(&component));
    for path in [
        super::display_directory(&package.join("private.txt")),
        super::display_directory(&root.join("secret")),
        "../outside".into(),
    ] {
        let error = runtime
            .package_read(
                &session.handle,
                ResourceContext::from(&task),
                PreviewResourceRequest { path, read: true },
            )
            .unwrap_err();
        assert!(matches!(
            error.code,
            ErrorCode::PermissionDenied | ErrorCode::InvalidPath
        ));
    }
    let mut revoked = task.clone();
    // A document without imports grants nothing.
    revoked.ticket.path = "b.not".into();
    revoked.source = "plain\n".into();
    assert_eq!(
        runtime
            .package_read(
                &session.handle,
                ResourceContext::from(&revoked),
                PreviewResourceRequest {
                    path: declaration,
                    read: true
                }
            )
            .unwrap_err()
            .code,
        ErrorCode::PermissionDenied
    );
    drain_watch_changes(&runtime, &session.handle);
    assert!(!runtime.changes(&session.handle).unwrap());
    std::fs::write(
        &component,
        "export default class Changed extends HTMLElement {}",
    )
    .unwrap();
    await_change(&runtime, &session.handle);
    let remote = runtime.open_session(remote_source()).unwrap();
    assert_eq!(
        runtime
            .package_directory(&remote.handle, ResourceContext::from(&task), "")
            .unwrap_err()
            .code,
        ErrorCode::Unsupported
    );
    runtime.shutdown().unwrap();
}

#[cfg(unix)]
#[test]
fn retargeting_an_explicit_package_symlink_invalidates_its_resource_snapshot() {
    let storage = tempfile::tempdir().unwrap();
    let repository = tempfile::tempdir().unwrap();
    let root = repository.path().canonicalize().unwrap();
    let docs = root.join("docs");
    let aliases = root.join("aliases");
    std::fs::create_dir_all(&docs).unwrap();
    std::fs::create_dir_all(&aliases).unwrap();
    for (name, source) in [
        ("v1", "fn panel()[children: BlockContent] -> BlockContent;"),
        (
            "v2",
            "fn updated()[children: BlockContent] -> BlockContent;",
        ),
    ] {
        let package = root.join(name);
        std::fs::create_dir(&package).unwrap();
        std::fs::write(package.join("lib.notc"), source).unwrap();
    }
    let alias = aliases.join("widgets");
    std::os::unix::fs::symlink(root.join("v1"), &alias).unwrap();
    std::fs::write(
        docs.join("a.not"),
        "#import \"../aliases/widgets/lib.notc\" as widgets;\n\n#widgets.panel()[body]",
    )
    .unwrap();
    let runtime = DesktopRuntime::open(storage.path()).unwrap();
    let session = runtime
        .open_session(OpenSource::Directory {
            path: docs.to_str().unwrap().into(),
        })
        .unwrap();
    let document = value(&runtime, &session.handle, "open", json!({"path":"a.not"}));
    let task = take_task(&runtime, &session.handle, &document);
    let path = super::display_directory(&alias.join("lib.notc"));
    let read = || {
        runtime
            .package_read(
                &session.handle,
                ResourceContext::from(&task),
                PreviewResourceRequest {
                    path: path.clone(),
                    read: true,
                },
            )
            .unwrap()
            .data
            .unwrap()
    };
    assert!(String::from_utf8(read()).unwrap().contains("fn panel"));
    drain_watch_changes(&runtime, &session.handle);
    std::fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(root.join("v2"), &alias).unwrap();
    await_change(&runtime, &session.handle);
    assert!(String::from_utf8(read()).unwrap().contains("fn updated"));
    runtime.shutdown().unwrap();
}

#[cfg(unix)]
#[test]
fn an_explicit_broken_package_link_observes_its_target_becoming_available() {
    let storage = tempfile::tempdir().unwrap();
    let repository = tempfile::tempdir().unwrap();
    let root = repository.path().canonicalize().unwrap();
    let docs = root.join("docs");
    let aliases = root.join("aliases");
    let targets = root.join("targets");
    for path in [&docs, &aliases, &targets] {
        std::fs::create_dir(path).unwrap();
    }
    let alias = aliases.join("widgets");
    let package = targets.join("widgets");
    std::os::unix::fs::symlink("../targets/widgets", &alias).unwrap();
    std::fs::write(
        docs.join("a.not"),
        "#import \"../aliases/widgets/lib.notc\" as widgets;\n\n#widgets.panel()[body]",
    )
    .unwrap();
    let runtime = DesktopRuntime::open(storage.path()).unwrap();
    let session = runtime
        .open_session(OpenSource::Directory {
            path: docs.to_str().unwrap().into(),
        })
        .unwrap();
    let document = value(&runtime, &session.handle, "open", json!({"path":"a.not"}));
    let task = take_task(&runtime, &session.handle, &document);
    let request = PreviewResourceRequest {
        path: super::display_directory(&alias.join("lib.notc")),
        read: true,
    };
    assert!(
        runtime
            .package_read(
                &session.handle,
                ResourceContext::from(&task),
                request.clone()
            )
            .unwrap()
            .kind
            .is_none()
    );
    drain_watch_changes(&runtime, &session.handle);
    std::fs::create_dir(&package).unwrap();
    std::fs::write(
        package.join("lib.notc"),
        "fn panel()[children: BlockContent] -> BlockContent;",
    )
    .unwrap();
    await_change(&runtime, &session.handle);
    assert!(
        !runtime
            .package_read(&session.handle, ResourceContext::from(&task), request)
            .unwrap()
            .data
            .unwrap()
            .is_empty()
    );
    runtime.shutdown().unwrap();
}

#[test]
fn replacement_webview_revokes_views_and_remote_owners_but_keeps_local_draft_and_undo() {
    let storage = tempfile::tempdir().unwrap();
    let runtime = DesktopRuntime::open(storage.path()).unwrap();
    let session = runtime.open_session(OpenSource::Default).unwrap();
    std::fs::write(
        std::path::Path::new(session.root.as_ref().unwrap()).join("a.md"),
        "old",
    )
    .unwrap();
    let document = value(&runtime, &session.handle, "open", json!({"path":"a.md"}));
    let task = take_task(&runtime, &session.handle, &document);
    let old_events = runtime
        .preview(&session.handle, "events", json!({}))
        .unwrap();
    assert_eq!(old_events[0]["sequence"], 1);
    runtime
        .preview(&session.handle, "invalidate_project", json!({}))
        .unwrap();
    assert_eq!(
        edit(&runtime, &session.handle, &document, "kept draft")["status"],
        "ok"
    );
    let remote = runtime.open_session(remote_source()).unwrap();
    runtime.reset_views().unwrap();
    assert_eq!(
        runtime
            .preview(&session.handle, "events", json!({}))
            .unwrap(),
        json!([])
    );
    let reconnected = runtime.open_session(OpenSource::Default).unwrap();
    assert_eq!(reconnected.handle, session.handle);
    let draft = value(
        &runtime,
        &session.handle,
        "read",
        json!({"id":document["id"]}),
    );
    assert_eq!(draft["snapshot"]["text"], "kept draft");
    assert_eq!(draft["undo"]["canUndo"], true);
    assert_eq!(
        runtime
            .preview(
                &session.handle,
                "complete",
                json!({"completion":compute_preview_native(&task)})
            )
            .unwrap(),
        false
    );
    assert_eq!(
        runtime
            .preview(&session.handle, "state", json!({"id":document["id"]}))
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    assert_eq!(
        runtime
            .core(&remote.handle, "resident", json!({}))
            .unwrap_err()
            .code,
        ErrorCode::Closed
    );
    let replacement = take_task(&runtime, &session.handle, &draft);
    assert_ne!(replacement.ticket.session_id, task.ticket.session_id);
    let events = runtime
        .preview(&session.handle, "events", json!({}))
        .unwrap();
    assert_eq!(events.as_array().unwrap().len(), 1);
    assert_eq!(events[0]["sequence"], 1);
    assert_eq!(events[0]["documentId"], document["id"]);
    runtime.reset_views().unwrap();
    runtime.shutdown().unwrap();
}

#[test]
fn remote_sessions_keep_private_volatile_history_and_personal_undo() {
    use celestite_buffer::{Buffer, types::DocumentIdentity};
    let storage = tempfile::tempdir().unwrap();
    let runtime = DesktopRuntime::open(storage.path()).unwrap();
    let session = runtime.open_session(remote_source()).unwrap();
    assert!(session.root.is_none());
    let host = Buffer::with_peer_id(
        DocumentIdentity {
            document_id: "remote-doc".into(),
            history_id: "document-history".into(),
        },
        9_007_199_254_740_993,
        "host text",
    )
    .unwrap();
    let document = value(
        &runtime,
        &session.handle,
        "join",
        json!({"path":"a.md", "packet":host.export_snapshot().unwrap(), "peerId":"9007199254740994"}),
    );
    assert!(document.get("persistedVersion").is_none());
    assert_eq!(
        edit(&runtime, &session.handle, &document, "private draft")["status"],
        "ok"
    );
    let draft = value(
        &runtime,
        &session.handle,
        "read",
        json!({"id":document["id"]}),
    );
    assert_eq!(draft["snapshot"]["text"], "private draft");
    assert!(draft.get("persistedVersion").is_none());
    let undo = runtime
        .core(
            &session.handle,
            "apply",
            json!({"id":document["id"], "command":{"kind":"undo","base":draft["version"]}}),
        )
        .unwrap();
    assert_eq!(undo["status"], "ok");
    assert_eq!(
        undo["mutations"][0]["document"]["snapshot"]["text"],
        "host text"
    );
    assert_eq!(host.text(), "host text");
    runtime.close_session(&session.handle).unwrap();
    let reopened = runtime.open_session(remote_source()).unwrap();
    assert_eq!(
        value(&runtime, &reopened.handle, "resident", json!({})),
        json!([])
    );
    runtime.shutdown().unwrap();
}

#[test]
fn unvisited_trees_and_sibling_paths_do_not_watch_until_a_directory_is_read() {
    let storage = tempfile::tempdir().unwrap();
    let repository = tempfile::tempdir().unwrap();
    let root = repository.path().join("vault");
    for index in 0..64 {
        let directory = root.join(format!("archive/{index}/one/two/three/four"));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("note.md"), "untouched").unwrap();
    }
    let runtime = DesktopRuntime::open(storage.path()).unwrap();
    let session = runtime
        .open_session(OpenSource::Directory {
            path: root.to_str().unwrap().into(),
        })
        .unwrap();
    ready_root_watch(&runtime, &session.handle);
    let visited = "archive/0/one/two/three/four";
    let file = root.join(visited).join("note.md");
    std::fs::write(&file, "changed while unvisited").unwrap();
    std::fs::write(
        repository.path().join("unrelated-sibling"),
        "outside the root",
    )
    .unwrap();
    assert_no_watch_change(&runtime, &session.handle);

    let entries = value(
        &runtime,
        &session.handle,
        "file",
        json!({"method":"readDir", "path":visited}),
    );
    assert_eq!(entries[0]["path"], format!("{visited}/note.md"));
    drain_watch_changes(&runtime, &session.handle);
    std::fs::write(&file, "changed after expansion").unwrap();
    await_change(&runtime, &session.handle);
    let opened = value(
        &runtime,
        &session.handle,
        "open",
        json!({"path":format!("{visited}/note.md")}),
    );
    assert_eq!(opened["snapshot"]["text"], "changed after expansion");
    runtime.shutdown().unwrap();
}

#[cfg(unix)]
#[test]
fn ordinary_symbolic_link_ancestors_never_acquire_outside_watches() {
    let storage = tempfile::tempdir().unwrap();
    let repository = tempfile::tempdir().unwrap();
    let root = repository.path().join("vault");
    let outside = repository.path().join("outside");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(outside.join("deep")).unwrap();
    std::fs::write(outside.join("deep/note.md"), "outside").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
    let runtime = DesktopRuntime::open(storage.path()).unwrap();
    let session = runtime
        .open_session(OpenSource::Directory {
            path: root.to_str().unwrap().into(),
        })
        .unwrap();
    ready_root_watch(&runtime, &session.handle);
    for (method, path) in [
        ("readDir", "link"),
        ("readDir", "link/deep"),
        ("readFileSnapshot", "link/deep/note.md"),
    ] {
        let result = runtime
            .core(
                &session.handle,
                "file",
                json!({"method":method, "path":path}),
            )
            .unwrap();
        assert_eq!(result["status"], "error", "{result}");
        assert_eq!(result["error"]["code"], "Unsupported", "{result}");
    }
    drain_watch_changes(&runtime, &session.handle);
    std::fs::write(outside.join("deep/note.md"), "still outside").unwrap();
    assert_no_watch_change(&runtime, &session.handle);
    runtime.shutdown().unwrap();
}

#[test]
fn replacing_an_expanded_directory_rebuilds_its_watch_before_later_writes() {
    let storage = tempfile::tempdir().unwrap();
    let repository = tempfile::tempdir().unwrap();
    let root = repository.path().join("vault");
    let directory = root.join("parent/expanded");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("a.md"), "old directory").unwrap();
    let runtime = DesktopRuntime::open(storage.path()).unwrap();
    let session = runtime
        .open_session(OpenSource::Directory {
            path: root.to_str().unwrap().into(),
        })
        .unwrap();
    value(
        &runtime,
        &session.handle,
        "file",
        json!({"method":"readDir", "path":"parent/expanded"}),
    );
    drain_watch_changes(&runtime, &session.handle);
    std::fs::rename(&directory, repository.path().join("previous-directory")).unwrap();
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(directory.join("a.md"), "new directory").unwrap();
    await_change(&runtime, &session.handle);
    drain_watch_changes(&runtime, &session.handle);
    // No intervening readDir/open can repair the watch for this assertion.
    std::fs::write(directory.join("a.md"), "later external edit").unwrap();
    await_change(&runtime, &session.handle);
    let opened = value(
        &runtime,
        &session.handle,
        "open",
        json!({"path":"parent/expanded/a.md"}),
    );
    assert_eq!(opened["snapshot"]["text"], "later external edit");
    runtime.shutdown().unwrap();
}

#[test]
fn a_replaced_root_reports_disconnection_while_private_drafts_remain_exportable() {
    use celestite_buffer::{Buffer, types::HistoryPacket};
    let storage = tempfile::tempdir().unwrap();
    let repository = tempfile::tempdir().unwrap();
    let root = repository.path().join("vault");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("a.md"), "original projection").unwrap();
    let runtime = DesktopRuntime::open(storage.path()).unwrap();
    let session = runtime
        .open_session(OpenSource::Directory {
            path: root.to_str().unwrap().into(),
        })
        .unwrap();
    let document = value(&runtime, &session.handle, "open", json!({"path":"a.md"}));
    assert_eq!(
        edit(&runtime, &session.handle, &document, "private draft")["status"],
        "ok"
    );
    std::fs::rename(&root, repository.path().join("original-root")).unwrap();
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("a.md"), "replacement projection").unwrap();
    for params in [
        json!({"method":"readDir", "path":""}),
        json!({"method":"readFileSnapshot", "path":"a.md"}),
        json!({"method":"writeFile", "path":"new.md", "data":[120], "options":{"mode":"create"}}),
    ] {
        let writing = params["method"] == "writeFile";
        let reply = runtime.core(&session.handle, "file", params).unwrap();
        assert_eq!(reply["status"], "error", "{reply}");
        assert_eq!(reply["error"]["code"], "Closed", "{reply}");
        if writing {
            assert_eq!(reply["error"]["writeNotStarted"], true, "{reply}");
        }
    }
    let draft = value(
        &runtime,
        &session.handle,
        "read",
        json!({"id":document["id"]}),
    );
    assert_eq!(draft["snapshot"]["text"], "private draft");
    let packet: HistoryPacket = serde_json::from_value(value(
        &runtime,
        &session.handle,
        "export_snapshot",
        json!({"id":document["id"]}),
    ))
    .unwrap();
    assert_eq!(
        Buffer::from_snapshot(&packet).unwrap().text(),
        "private draft"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("a.md")).unwrap(),
        "replacement projection"
    );
    assert_eq!(
        std::fs::read_to_string(repository.path().join("original-root/a.md")).unwrap(),
        "original projection"
    );
    assert!(!root.join("new.md").exists());
    assert!(!repository.path().join("original-root/new.md").exists());
    runtime.shutdown().unwrap();
}

#[test]
fn restored_resident_documents_are_watched_without_reopening_their_paths() {
    let storage = tempfile::tempdir().unwrap();
    let repository = tempfile::tempdir().unwrap();
    let root = repository.path().join("vault");
    std::fs::create_dir_all(root.join("nested/deep")).unwrap();
    let file = root.join("nested/deep/a.md");
    std::fs::write(&file, "before restart").unwrap();
    let source = OpenSource::Directory {
        path: root.to_str().unwrap().into(),
    };
    let runtime = DesktopRuntime::open(storage.path()).unwrap();
    let session = runtime.open_session(source.clone()).unwrap();
    let document = value(
        &runtime,
        &session.handle,
        "open",
        json!({"path":"nested/deep/a.md"}),
    );
    edit(&runtime, &session.handle, &document, "before restart local");
    runtime.shutdown().unwrap();

    let session = runtime.open_session(source).unwrap();
    let restored = value(&runtime, &session.handle, "resident", json!({}))[0].clone();
    assert_ne!(restored["id"], document["id"]);
    assert_eq!(restored["snapshot"]["text"], "before restart local");
    // Registration is background work; wait for its initial invalidation to
    // settle without a file operation that could install the missing watch.
    drain_watch_changes(&runtime, &session.handle);
    std::fs::write(&file, "external after restart").unwrap();
    await_change(&runtime, &session.handle);
    let refreshed = value(
        &runtime,
        &session.handle,
        "observe_files",
        json!({"ids":[restored["id"]]}),
    );
    assert_eq!(
        refreshed[0]["snapshot"]["text"],
        "external after restart local"
    );
    runtime.shutdown().unwrap();
}

#[test]
fn immediate_close_and_shutdown_do_not_deadlock_watch_registration_barriers() {
    use std::sync::{Barrier, mpsc};
    let storage = tempfile::tempdir().unwrap();
    let runtime = Arc::new(DesktopRuntime::open(storage.path()).unwrap());
    for round in 0..8 {
        let session = runtime.open_session(OpenSource::Default).unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let (send, receive) = mpsc::channel();
        let reader = {
            let runtime = runtime.clone();
            let handle = session.handle.clone();
            let barrier = barrier.clone();
            let send = send.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let result = runtime.core(&handle, "file", json!({"method":"readDir", "path":""}));
                match result {
                    Ok(reply) => assert!(
                        reply["status"] == "ok" || reply["error"]["code"] == "Closed",
                        "{reply}"
                    ),
                    Err(error) => assert_eq!(error.code, ErrorCode::Closed),
                }
                send.send(()).unwrap();
            })
        };
        let closer = {
            let runtime = runtime.clone();
            let handle = session.handle.clone();
            let barrier = barrier.clone();
            let send = send.clone();
            std::thread::spawn(move || {
                barrier.wait();
                if round % 2 == 0 {
                    runtime.close_session(&handle).unwrap();
                } else {
                    runtime.shutdown().unwrap();
                }
                send.send(()).unwrap();
            })
        };
        barrier.wait();
        for _ in 0..2 {
            receive
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("watch registration and owner shutdown deadlocked");
        }
        reader.join().unwrap();
        closer.join().unwrap();
    }
    runtime.shutdown().unwrap();
}

/// The native language host drives the service's resource rounds from real
/// disk: Vault files by relative key, `..`-escaped modules beside the root.
#[test]
fn language_host_reads_modules_from_disk() {
    let storage = tempfile::tempdir().unwrap();
    let workspace = storage.path().join("workspace");
    let root = workspace.join("project/vault");
    let package = workspace.join("widgets");
    std::fs::create_dir_all(root.join("docs")).unwrap();
    std::fs::create_dir_all(&package).unwrap();
    std::fs::write(
        package.join("lib.notc"),
        "fn panel(title: String) -> BlockContent;\n",
    )
    .unwrap();
    let runtime = DesktopRuntime::open(&storage.path().join("app")).unwrap();
    let session = runtime
        .open_session(OpenSource::Directory {
            path: root.to_str().unwrap().into(),
        })
        .unwrap();
    let say = |message: Value| {
        runtime
            .language(
                &session.handle,
                super::LanguageCommand::Message {
                    message: message.to_string(),
                },
            )
            .unwrap()
            .into_iter()
            .map(|message| serde_json::from_str::<Value>(&message).unwrap())
            .collect::<Vec<_>>()
    };
    let initialize = say(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}));
    assert_eq!(
        initialize[0]["result"]["serverInfo"]["name"],
        "celestite-notist"
    );
    let uri = "file:///vault/docs/a.not";
    let text = "#import \"../../../widgets/lib.notc\" as widgets;\n\n#widgets.panel(\"标题\")\n";
    let opened = say(json!({
        "jsonrpc":"2.0","method":"textDocument/didOpen",
        "params":{"textDocument":{"uri":uri,"version":1,"text":text}}
    }));
    let diagnostics = opened
        .iter()
        .find_map(|message| {
            (message["method"] == "textDocument/publishDiagnostics"
                && message["params"]["uri"] == uri)
                .then(|| message["params"]["diagnostics"].clone())
        })
        .expect("publish diagnostics");
    assert_eq!(
        diagnostics,
        json!([]),
        "declared calls analyze cleanly: {opened:?}"
    );
    let hover = say(json!({
        "jsonrpc":"2.0","id":2,"method":"textDocument/hover",
        "params":{"textDocument":{"uri":uri},"position":{"line":2,"character":10}}
    }));
    assert!(
        hover[0]["result"]["contents"]["value"]
            .as_str()
            .unwrap()
            .contains("panel"),
        "hover reads the module declaration from disk: {hover:?}"
    );
    drain_watch_changes(&runtime, &session.handle);
    std::fs::write(
        package.join("lib.notc"),
        "fn panel(changed: String) -> BlockContent;\n",
    )
    .unwrap();
    await_change(&runtime, &session.handle);
    assert!(
        runtime
            .language(&session.handle, super::LanguageCommand::Invalidate)
            .unwrap()
            .is_empty()
    );
    let refreshed = say(json!({
        "jsonrpc":"2.0","id":3,"method":"textDocument/hover",
        "params":{"textDocument":{"uri":uri},"position":{"line":2,"character":10}}
    }));
    assert!(
        refreshed[0]["result"]["contents"]["value"]
            .as_str()
            .unwrap()
            .contains("changed"),
        "invalidated language resources must be read from the observed module"
    );
    runtime
        .language(&session.handle, super::LanguageCommand::Reset)
        .unwrap();
    let reset =
        say(json!({"id":4,"method":"textDocument/hover","params":{"textDocument":{"uri":uri}}}));
    assert_eq!(reset[0]["error"]["code"], -32002);
    say(json!({"id":5,"method":"initialize"}));
    let stale = say(
        json!({"id":6,"method":"textDocument/hover","params":{"textDocument":{"uri":uri},"position":{"line":2,"character":10}}}),
    );
    assert!(
        stale[0]["result"].is_null(),
        "restarted native endpoint must not retain documents"
    );
    runtime.close_session(&session.handle).unwrap();
    assert!(
        runtime
            .language(&session.handle, super::LanguageCommand::Invalidate)
            .unwrap_err()
            .code
            == ErrorCode::Closed
    );
}

/// Measure a real directory using disposable private recovery; only enumerate Vault files.
#[test]
#[ignore = "requires CELESTITE_BENCH_VAULT and an isolated test process"]
fn measure_open() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::path::PathBuf::from(
        std::env::var_os("CELESTITE_BENCH_VAULT")
            .ok_or("Set CELESTITE_BENCH_VAULT to a Vault directory")?,
    )
    .canonicalize()?;
    let private = tempfile::tempdir()?;
    let runtime = DesktopRuntime::open(private.path())?;
    let started = std::time::Instant::now();
    let session = runtime.open_session(OpenSource::Directory {
        path: root.to_str().ok_or("Expected a UTF-8 path")?.into(),
    })?;
    let open = started.elapsed();
    let started = std::time::Instant::now();
    let entries = runtime.core(
        &session.handle,
        "file",
        json!({"method": "readDir", "path": ""}),
    )?;
    let list = started.elapsed();
    if entries["status"] != "ok" {
        return Err(format!("Directory enumeration failed: {entries}").into());
    }
    let watches = native_watch_count();
    let started = std::time::Instant::now();
    runtime.shutdown()?;
    println!(
        "{}",
        json!({
            "open_ms": open.as_secs_f64() * 1000.0,
            "root_listing_ms": list.as_secs_f64() * 1000.0,
            "root_entries": entries["value"].as_array().map(Vec::len),
            "native_directory_watches": watches,
            "shutdown_ms": started.elapsed().as_secs_f64() * 1000.0,
        })
    );
    Ok(())
}

#[cfg(target_os = "linux")]
fn native_watch_count() -> Option<usize> {
    Some(
        std::fs::read_dir("/proc/self/fdinfo")
            .ok()?
            .filter_map(Result::ok)
            .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
            .map(|info| {
                info.lines()
                    .filter(|line| line.starts_with("inotify wd:"))
                    .count()
            })
            .sum(),
    )
}

#[cfg(not(target_os = "linux"))]
fn native_watch_count() -> Option<usize> {
    None
}

#[cfg(unix)]
#[test]
fn language_resources_reject_external_module_file_symlinks() {
    let storage = tempfile::tempdir().unwrap();
    let root = storage.path().join("workspace/vault");
    let modules = storage.path().join("workspace/widgets");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&modules).unwrap();
    let secret = storage.path().join("unrelated.notc");
    std::fs::write(&secret, "fn panel() -> BlockContent;").unwrap();
    std::os::unix::fs::symlink(&secret, modules.join("lib.notc")).unwrap();
    let runtime = DesktopRuntime::open(&storage.path().join("app")).unwrap();
    let session = runtime
        .open_session(OpenSource::Directory {
            path: root.to_str().unwrap().into(),
        })
        .unwrap();
    let say = |message: Value| {
        runtime
            .language(
                &session.handle,
                super::LanguageCommand::Message {
                    message: message.to_string(),
                },
            )
            .unwrap()
    };
    say(json!({"id":1,"method":"initialize"}));
    let messages = say(json!({
        "method":"textDocument/didOpen",
        "params":{"textDocument":{"uri":"file:///vault/a.not","version":1,"text":"#import \"../widgets/lib.notc\" as widgets;\n\n#widgets.panel()\n"}}
    }));
    assert!(
        messages
            .iter()
            .any(|message| message.contains("resource must be a file or directory")),
        "language IO must share the no-follow preview capability: {messages:?}"
    );
    runtime.shutdown().unwrap();
}

#[test]
fn native_git_status_observes_the_vault_and_remote_sessions_have_none() {
    let git = |root: &std::path::Path, args: &[&str]| {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    if !std::process::Command::new("git")
        .arg("--version")
        .output()
        .is_ok_and(|output| output.status.success())
    {
        return;
    }
    let storage = tempfile::tempdir().unwrap();
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    git(&root, &["init", "-q"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    git(&root, &["config", "user.name", "Test"]);
    std::fs::write(root.join("a.md"), "base").unwrap();
    git(&root, &["add", "a.md"]);
    git(&root, &["commit", "-qm", "base"]);
    std::fs::write(root.join("a.md"), "changed").unwrap();
    std::fs::write(root.join("new.md"), "new").unwrap();

    let runtime = DesktopRuntime::open(storage.path()).unwrap();
    let session = runtime
        .open_session(OpenSource::Directory {
            path: root.to_str().unwrap().into(),
        })
        .unwrap();
    let status = runtime.git_status(&session.handle).unwrap().unwrap();
    assert!(status.entries.iter().any(|entry| {
        entry.path == "a.md" && entry.worktree == celestite_core::protocol::git::GitChange::Modified
    }));
    assert!(
        status
            .entries
            .iter()
            .any(|entry| entry.path == "new.md" && entry.untracked)
    );

    let remote = runtime.open_session(remote_source()).unwrap();
    assert_eq!(runtime.git_status(&remote.handle).unwrap(), None);
    runtime.shutdown().unwrap();
}
