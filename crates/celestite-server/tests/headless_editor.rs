//! Independent production cores communicating through real WebSocket sessions.
mod support;
use celestite_buffer::Buffer;
use serde_json::{json, Value};
use support::{ClientReplica, Host};

async fn state(host: &Host, id: &str) -> Value {
    host.json("GET", &format!("/documents/{id}"), Value::Null)
        .await
}
#[tokio::test]
async fn independent_cores_merge_and_undo_only_their_own_operations() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "A😀B").unwrap();
    let host = Host::start(root.path(), false).await;
    let mut a = host.client_replica().await;
    let mut b = host.client_replica().await;
    let id = a.open("a.md").await;
    assert_eq!(b.open("a.md").await, id);
    assert_ne!(a.core.peer_id(&id).unwrap(), b.core.peer_id(&id).unwrap());
    a.edit(&id, 5, 5, "甲").await;
    b.edit(&id, 5, 5, "乙").await;
    a.sync(&id).await;
    b.sync(&id).await;
    let merged = a.core.read(&id).unwrap().snapshot;
    assert_eq!(merged.text, b.core.read(&id).unwrap().snapshot.text);
    assert_eq!(merged.version, b.core.read(&id).unwrap().snapshot.version);
    assert!(merged.text.contains('甲') && merged.text.contains('乙'));
    a.undo(&id, false).await;
    b.sync(&id).await;
    assert_eq!(b.core.read(&id).unwrap().snapshot.text.as_ref(), "A😀乙B");
    b.undo(&id, false).await;
    a.sync(&id).await;
    assert_eq!(a.core.read(&id).unwrap().snapshot.text.as_ref(), "A😀B");
    assert_eq!(
        std::fs::read_to_string(root.path().join("a.md")).unwrap(),
        "A😀B"
    );
    a.close().await;
    b.close().await;
    host.stop().await;
}
#[tokio::test]
async fn session_admission_rejects_foreign_peers_histories_and_missing_dependencies() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "base").unwrap();
    let host = Host::start(root.path(), false).await;
    let mut client = host.client_replica().await;
    let id = client.open("a.md").await;
    let before = state(&host, &id).await;
    let seed = client.core.snapshot(&id).unwrap();
    let mut foreign = Buffer::from_snapshot(&seed).unwrap();
    let _ = foreign.replace_text("foreign").unwrap();
    let rejected = client.request("updates", json!({"id":id,"packet":foreign.export_updates_since(&client.core.read(&id).unwrap().snapshot.version).unwrap(),"version":foreign.version(),"operation":1})).await;
    assert_eq!(rejected["error"]["code"], "InvalidEdit");
    let mut wrong = seed.clone();
    wrong.identity.history_id = "other history".into();
    let rejected = client
        .request(
            "updates",
            json!({"id":id,"packet":wrong,"version":foreign.version(),"operation":1}),
        )
        .await;
    assert!(!rejected["error"].is_null());
    let assigned = client.core.peer_id(&id).unwrap();
    let mut disconnected = Buffer::from_snapshot_with_peer_id(&seed, assigned).unwrap();
    let _ = disconnected.replace_text("first").unwrap();
    let missing = disconnected.version();
    let _ = disconnected.replace_text("second").unwrap();
    let rejected = client.request("updates", json!({"id":id,"packet":disconnected.export_updates_since(&missing).unwrap(),"version":disconnected.version(),"operation":1})).await;
    assert_eq!(rejected["error"]["code"], "InvalidEdit");
    assert_eq!(state(&host, &id).await["snapshot"], before["snapshot"]);
    client.edit(&id, 4, 4, " valid").await;
    client.close().await;
    host.stop().await;
}
#[tokio::test]
async fn file_save_uses_a_causal_checkpoint_and_preserves_encoding() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "\u{feff}A😀B\r\nline\r\n").unwrap();
    let host = Host::start(root.path(), false).await;
    let mut client = host.client_replica().await;
    let id = client.open("a.md").await;
    let initial = client.core.read(&id).unwrap();
    client.edit(&id, 5, 5, "中文").await;
    let stale = client
        .request("save", json!({"id":id,"version":initial.snapshot.version}))
        .await;
    assert_eq!(stale["error"]["code"], "StaleVersion");
    let version = client.core.read(&id).unwrap().snapshot.version;
    let saved = client.ok("save", json!({"id":id,"version":version})).await;
    client.accept(saved).await;
    assert_eq!(
        std::fs::read_to_string(root.path().join("a.md")).unwrap(),
        "\u{feff}A😀中文B\r\nline\r\n"
    );
    client.close().await;
    host.stop().await;
}
#[tokio::test]
async fn moves_preserve_identity_and_deleted_documents_reject_late_updates_and_saves() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "base").unwrap();
    let host = Host::start(root.path(), false).await;
    let mut client = host.client_replica().await;
    let id = client.open("a.md").await;
    host.json("POST", "/rename", json!({"from":"a.md","to":"b.md"}))
        .await;
    client.sync(&id).await;
    assert_eq!(client.core.read(&id).unwrap().path, "b.md");
    let late = client.core.edit(&id, [(0..0, "late")]).await.unwrap();
    host.json("DELETE", "/entry?path=b.md", Value::Null).await;
    assert_eq!(client.request("updates", json!({"id":id,"packet":late.update.operation,"version":late.update.after,"operation":1})).await["error"]["code"], "NotFound");
    client.sync(&id).await;
    assert!(client.core.read(&id).unwrap().deleted);
    let version = client.core.read(&id).unwrap().snapshot.version;
    let save = client
        .request("save", json!({"id":id,"version":version}))
        .await;
    assert_eq!(save["error"]["code"], "NotFound");
    assert!(!root.path().join("b.md").exists());
    client.close().await;
    host.stop().await;
}
#[tokio::test]
async fn readonly_sessions_receive_updates_but_cannot_submit_operations() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "base").unwrap();
    let host = Host::start(root.path(), false).await;
    let mut client = host.client_replica().await;
    let mut reader = ClientReplica::connect(&host.readonly_url).await;
    let id = client.open("a.md").await;
    reader.open("a.md").await;
    client.edit(&id, 4, 4, " changed").await;
    reader.sync(&id).await;
    assert_eq!(
        reader.core.read(&id).unwrap().snapshot.text.as_ref(),
        "base changed"
    );
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
    client.close().await;
    reader.close().await;
    host.stop().await;
}
#[tokio::test]
async fn membership_tracks_subscriptions_views_and_disconnects_without_text_changes() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "base").unwrap();
    let host = Host::start(root.path(), false).await;
    let mut observer = host.client_replica().await;
    let mut client = host.client_replica().await;
    let id = client.open("a.md").await;
    let peer_id = client.core.peer_id(&id).unwrap();
    client.edit(&id, 4, 4, " draft").await;
    let member_id = client.session.clone();
    client
        .ok(
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
    client.ok("unsubscribe", json!({"id":id})).await;
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
    client.sync(&id).await;
    assert_eq!(client.core.peer_id(&id).unwrap(), peer_id);
    assert!(client.core.read(&id).unwrap().undo.can_undo);
    assert_eq!(state(&host, &id).await["snapshot"], before);
    client.close().await;
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
