//! Independent production cores communicating through real WebSocket sessions.
mod support;
use celestite_core::*;
use serde_json::{json, Value};
use std::time::Duration;
use support::{Host, Peer};

async fn state(host: &Host, id: &str) -> Value {
    host.json("GET", &format!("/documents/{id}"), Value::Null)
        .await
}
async fn settled(host: &Host, id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let state = state(host, id).await;
            if state["externalChange"].is_null() {
                return state;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn independent_cores_merge_and_undo_only_their_own_operations() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "A😀B").unwrap();
    let host = Host::start(root.path(), false).await;
    let mut a = host.peer().await;
    let mut b = host.peer().await;
    let id = a.open("a.md").await;
    assert_eq!(b.open("a.md").await, id);
    assert_ne!(
        a.core.read(&id).unwrap().writer_id,
        b.core.read(&id).unwrap().writer_id
    );
    a.edit(&id, 3, 3, "甲").await;
    b.edit(&id, 3, 3, "乙").await;
    a.sync(&id).await;
    b.sync(&id).await;
    let merged = a.core.read(&id).unwrap().snapshot;
    assert_eq!(
        merged,
        TextSnapshot {
            revision: merged.revision,
            ..b.core.read(&id).unwrap().snapshot
        }
    );
    assert!(merged.text.contains('甲') && merged.text.contains('乙'));
    a.undo(&id, false).await;
    b.sync(&id).await;
    assert_eq!(b.core.read(&id).unwrap().snapshot.text, "A😀乙B");
    b.undo(&id, false).await;
    a.sync(&id).await;
    assert_eq!(a.core.read(&id).unwrap().snapshot.text, "A😀B");
    assert_eq!(
        std::fs::read_to_string(root.path().join("a.md")).unwrap(),
        "A😀B"
    );
    a.close().await;
    b.close().await;
    host.stop().await;
}
#[tokio::test]
async fn session_admission_rejects_foreign_writers_histories_and_missing_dependencies() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "base").unwrap();
    let host = Host::start(root.path(), false).await;
    let mut peer = host.peer().await;
    let id = peer.open("a.md").await;
    let before = state(&host, &id).await;
    let seed = peer.core.snapshot(&id).unwrap();
    let mut foreign = Buffer::from_snapshot(&seed, None).unwrap();
    let _ = foreign
        .apply(BufferCommand::Edit(Edit::replace(
            &foreign.snapshot(),
            "foreign",
        )))
        .unwrap();
    let rejected = peer.request("updates", json!({"id":id,"packet":foreign.export_updates_since(&peer.core.read(&id).unwrap().snapshot.version).unwrap(),"version":foreign.version(),"operation":1})).await;
    assert_eq!(rejected["error"]["code"], "InvalidEdit");
    let mut wrong = seed.clone();
    wrong.identity.history_id = "other history".into();
    let rejected = peer
        .request(
            "updates",
            json!({"id":id,"packet":wrong,"version":foreign.version(),"operation":1}),
        )
        .await;
    assert!(!rejected["error"].is_null());
    let assigned = peer.core.read(&id).unwrap().writer_id.parse().unwrap();
    let mut disconnected = Buffer::from_snapshot(&seed, Some(assigned)).unwrap();
    let _ = disconnected
        .apply(BufferCommand::Edit(Edit::replace(
            &disconnected.snapshot(),
            "first",
        )))
        .unwrap();
    let missing = disconnected.version();
    let _ = disconnected
        .apply(BufferCommand::Edit(Edit::replace(
            &disconnected.snapshot(),
            "second",
        )))
        .unwrap();
    let rejected = peer.request("updates", json!({"id":id,"packet":disconnected.export_updates_since(&missing).unwrap(),"version":disconnected.version(),"operation":1})).await;
    assert_eq!(rejected["error"]["code"], "InvalidEdit");
    assert_eq!(state(&host, &id).await["snapshot"], before["snapshot"]);
    peer.edit(&id, 4, 4, " valid").await;
    peer.close().await;
    host.stop().await;
}
#[tokio::test]
async fn file_save_uses_a_causal_checkpoint_and_preserves_encoding() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "\u{feff}A😀B\r\nline\r\n").unwrap();
    let host = Host::start(root.path(), false).await;
    let mut peer = host.peer().await;
    let id = peer.open("a.md").await;
    let initial = peer.core.read(&id).unwrap();
    peer.edit(&id, 3, 3, "中文").await;
    let stale = peer
        .request("save", json!({"id":id,"version":initial.snapshot.version}))
        .await;
    assert_eq!(stale["error"]["code"], "StaleVersion");
    let version = peer.core.read(&id).unwrap().snapshot.version;
    let saved = peer.ok("save", json!({"id":id,"version":version})).await;
    peer.accept(saved).await;
    assert_eq!(
        std::fs::read_to_string(root.path().join("a.md")).unwrap(),
        "\u{feff}A😀中文B\r\nline\r\n"
    );
    peer.close().await;
    host.stop().await;
}
#[tokio::test]
async fn external_changes_merge_without_becoming_personal_undo() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "A middle B").unwrap();
    let host = Host::start(root.path(), false).await;
    let mut peer = host.peer().await;
    let id = peer.open("a.md").await;
    let writer = peer.core.read(&id).unwrap().writer_id;
    peer.edit(&id, 2, 8, "MIDDLE").await;
    std::fs::write(root.path().join("a.md"), "LEFT middle RIGHT").unwrap();
    settled(&host, &id).await;
    peer.sync(&id).await;
    assert_eq!(
        peer.core.read(&id).unwrap().snapshot.text,
        "LEFT MIDDLE RIGHT"
    );
    assert_eq!(peer.core.read(&id).unwrap().writer_id, writer);
    assert_eq!(
        peer.undo(&id, false).await.snapshot.text,
        "LEFT middle RIGHT"
    );
    peer.close().await;
    host.stop().await;
}
#[tokio::test]
async fn moves_preserve_identity_and_deleted_documents_reject_late_updates_and_saves() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "base").unwrap();
    let host = Host::start(root.path(), false).await;
    let mut peer = host.peer().await;
    let id = peer.open("a.md").await;
    host.json("POST", "/rename", json!({"from":"a.md","to":"b.md"}))
        .await;
    peer.sync(&id).await;
    assert_eq!(peer.core.read(&id).unwrap().path, "b.md");
    host.json("DELETE", "/entry?path=b.md", Value::Null).await;
    peer.sync(&id).await;
    assert!(peer.core.read(&id).unwrap().deleted);
    let version = peer.core.read(&id).unwrap().snapshot.version;
    let save = peer
        .request("save", json!({"id":id,"version":version}))
        .await;
    assert_eq!(save["error"]["code"], "NotFound");
    assert!(!root.path().join("b.md").exists());
    peer.close().await;
    host.stop().await;
}
#[tokio::test]
async fn readonly_sessions_receive_updates_but_cannot_submit_operations() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "base").unwrap();
    let host = Host::start(root.path(), false).await;
    let mut writer = host.peer().await;
    let mut reader = Peer::connect(&host.readonly_url).await;
    let id = writer.open("a.md").await;
    reader.open("a.md").await;
    writer.edit(&id, 4, 4, " changed").await;
    reader.sync(&id).await;
    assert_eq!(reader.core.read(&id).unwrap().snapshot.text, "base changed");
    let denied = reader.request("updates", json!({"id":id,"packet":reader.core.snapshot(&id).unwrap(),"version":reader.core.read(&id).unwrap().snapshot.version,"operation":1})).await;
    assert_eq!(denied["error"]["code"], "PermissionDenied");
    let denied = reader
        .request(
            "save",
            json!({"id":id,"version":reader.core.read(&id).unwrap().snapshot.version}),
        )
        .await;
    assert_eq!(denied["error"]["code"], "PermissionDenied");
    reader.ok("unsubscribe", json!({"id":id})).await;
    writer.close().await;
    reader.close().await;
    host.stop().await;
}
#[tokio::test]
async fn membership_tracks_subscriptions_views_and_disconnects_without_text_changes() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "base").unwrap();
    let host = Host::start(root.path(), false).await;
    let mut observer = host.peer().await;
    let mut peer = host.peer().await;
    let id = peer.open("a.md").await;
    let writer = peer.core.read(&id).unwrap().writer_id;
    peer.edit(&id, 4, 4, " draft").await;
    let member_id = peer.session.clone();
    peer.ok(
        "set_view",
        json!({"viewId":"editor","documentId":id,"focused":true}),
    )
    .await;
    let members = observer
        .next_members(|state| {
            state["members"].as_array().is_some_and(|members| {
                members.iter().any(|m| {
                    m["sessionId"] == member_id
                        && m["views"].as_array().is_some_and(|v| !v.is_empty())
                })
            })
        })
        .await;
    assert_eq!(members["members"].as_array().unwrap().len(), 2);
    let before = state(&host, &id).await["snapshot"].clone();
    peer.ok("unsubscribe", json!({"id":id})).await;
    observer
        .next_members(|state| {
            state["members"].as_array().is_some_and(|members| {
                members.iter().any(|m| {
                    m["sessionId"] == member_id
                        && m["documents"] == json!([])
                        && m["views"] == json!([])
                })
            })
        })
        .await;
    peer.sync(&id).await;
    assert_eq!(peer.core.read(&id).unwrap().writer_id, writer);
    assert!(peer.core.read(&id).unwrap().undo.can_undo);
    assert_eq!(state(&host, &id).await["snapshot"], before);
    peer.close().await;
    observer
        .next_members(|state| {
            state["members"]
                .as_array()
                .is_some_and(|members| members.iter().all(|m| m["sessionId"] != member_id))
        })
        .await;
    observer.close().await;
    host.stop().await;
}
#[tokio::test]
async fn production_anchor_rpc_checks_versions_and_unicode_boundaries() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "A😀B").unwrap();
    let host = Host::start(root.path(), false).await;
    let mut peer = host.peer().await;
    let id = peer.open("a.md").await;
    let version = peer.core.read(&id).unwrap().snapshot.version;
    let anchors = peer
        .core
        .execute_service(
            "anchors_at",
            json!({"id":id,"version":version,"positions":[[3,"before"]]}),
        )
        .await
        .unwrap();
    assert!(peer
        .core
        .execute_service(
            "anchors_at",
            json!({"id":id,"version":version,"positions":[[2,"before"]]})
        )
        .await
        .is_err());
    peer.edit(&id, 0, 0, "前").await;
    assert_eq!(
        peer.core
            .execute_service(
                "anchors_at",
                json!({"id":id,"version":version,"positions":[[3,"before"]]})
            )
            .await
            .unwrap_err()
            .code,
        "StaleVersion"
    );
    let resolved = peer
        .core
        .execute_service(
            "resolve_anchors",
            json!({"id":id,"checkpoint":version,"anchors":anchors}),
        )
        .await
        .unwrap();
    assert_eq!(resolved[1][0]["offset"], 4);
    peer.close().await;
    host.stop().await;
}
