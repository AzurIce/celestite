//! Wire invariants, using the same real-server client as the editor integration suite.
mod support;
use serde_json::{json, Value};
use std::time::Duration;
use support::{next, send, Host};
use tokio_tungstenite::{connect_async, tungstenite::client::IntoClientRequest};

fn fixture() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "ab🦀cd\nsecond\n").unwrap();
    std::fs::write(root.path().join("unopened.md"), "untouched").unwrap();
    root
}

#[tokio::test]
async fn sessions_subscribe_only_when_they_open_a_buffer() {
    let root = fixture();
    let host = Host::start(root.path(), false).await;
    let mut observer = host.client_replica().await;
    assert_eq!(host.json("GET", "/documents", Value::Null).await, json!([]));
    let mut editor = host.client_replica().await;
    let id = editor.open("a.md").await;
    editor.edit(&id, 0, 0, "live ").await;
    assert!(tokio::time::timeout(Duration::from_millis(200), async {
        loop {
            assert_ne!(next(&mut observer.socket).await["kind"], "document");
        }
    })
    .await
    .is_err());
    assert_eq!(
        observer
            .request(
                "probe",
                json!({"id":id,"version":editor.core.read(&id).unwrap().snapshot.version})
            )
            .await["error"]["code"],
        "InvalidEdit"
    );
    assert_eq!(observer.open("a.md").await, id);
    assert_eq!(
        observer.core.read(&id).unwrap().snapshot.text,
        editor.core.read(&id).unwrap().snapshot.text
    );
    observer.close().await;
    editor.close().await;
    host.stop().await;
}

#[tokio::test]
async fn reconnect_can_reopen_a_moved_buffer_by_identity() {
    let root = fixture();
    let host = Host::start(root.path(), false).await;
    let mut old = host.client_replica().await;
    let id = old.open("a.md").await;
    let peer_id = old.core.peer_id(&id).unwrap();
    let text = old.edit(&id, 0, 0, "unsaved ").await.snapshot.text;
    old.close().await;
    host.json("POST", "/rename", json!({"from":"a.md","to":"renamed.md"}))
        .await;
    let mut new = host.client_replica().await;
    new.sync(&id).await;
    assert_eq!(new.core.read(&id).unwrap().path, "renamed.md");
    assert_ne!(new.core.peer_id(&id).unwrap(), peer_id);
    assert_eq!(new.core.read(&id).unwrap().snapshot.text, text);
    new.close().await;
    host.stop().await;
}

#[tokio::test]
async fn operation_replay_is_idempotent_and_new_sessions_reject_old_peers() {
    let root = fixture();
    let host = Host::start(root.path(), false).await;
    let mut old = host.client_replica().await;
    let id = old.open("a.md").await;
    let mutation = old.core.edit(&id, [(0..0, "confirmed")]).await.unwrap();
    let update = json!({"id":id,"packet":mutation.update.operation,"version":mutation.update.after,"operation":1});
    let ack = old.ok("updates", update.clone()).await;
    assert_eq!(old.ok("updates", update.clone()).await, ack);
    let mut altered = update;
    altered["version"]["clocks"][old.core.peer_id(&id).unwrap().to_string()] = json!(999);
    assert_eq!(
        old.request("updates", altered).await["error"]["code"],
        "InvalidEdit"
    );
    let orphan = old.core.edit(&id, [(0..0, "unsent")]).await.unwrap();
    let unsent = orphan.update.after.clone();
    let peer_id = old.core.peer_id(&id).unwrap();
    old.close().await;
    let mut new = host.client_replica().await;
    new.sync(&id).await;
    assert_ne!(new.core.peer_id(&id).unwrap(), peer_id);
    assert_eq!(
        new.request(
            "updates",
            json!({"id":id,"packet":orphan.update.operation,"version":unsent,"operation":1})
        )
        .await["error"]["code"],
        "InvalidEdit"
    );
    for (label, version, committed) in [
        ("accepted", ack["version"].clone(), true),
        ("unsent", serde_json::to_value(unsent).unwrap(), false),
    ] {
        assert_eq!(
            new.ok("probe", json!({"id":id,"version":version})).await["committed"],
            committed,
            "{label}"
        );
    }
    new.close().await;
    host.stop().await;
}

#[tokio::test]
async fn external_changes_are_pushed_only_for_open_buffers() {
    let root = fixture();
    let host = Host::start(root.path(), false).await;
    let mut client = host.client_replica().await;
    let id = client.open("a.md").await;
    std::fs::write(root.path().join("a.md"), "external🦀").unwrap();
    loop {
        let frame = next(&mut client.socket).await;
        client.accept(frame).await;
        if client.core.read(&id).unwrap().snapshot.text.as_ref() == "external🦀" {
            break;
        }
    }
    std::fs::write(root.path().join("unopened.md"), "observed without opening").unwrap();
    assert!(tokio::time::timeout(Duration::from_millis(200), async {
        loop {
            let frame = next(&mut client.socket).await;
            if frame["kind"] == "document" {
                assert_eq!(frame["document"]["id"], id);
                client.accept(frame).await;
            }
        }
    })
    .await
    .is_err());
    assert_eq!(
        host.json("GET", "/documents", Value::Null)
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let unopened = client.open("unopened.md").await;
    assert_eq!(
        client.core.read(&unopened).unwrap().snapshot.text.as_ref(),
        "observed without opening"
    );
    client.close().await;
    host.stop().await;
}

#[tokio::test]
async fn handshake_auth_history_and_read_only_are_enforced() {
    let root = fixture();
    let host = Host::start(root.path(), true).await;
    let identity = host.identity().await;
    for (label, handshake, code) in [
        (
            "protocol",
            json!({"protocolVersion":0,"vaultIdentity":identity}),
            "PermissionDenied",
        ),
        (
            "history",
            json!({"protocolVersion":3,"vaultIdentity":{"id":"wrong","historyId":"wrong"}}),
            "Conflict",
        ),
    ] {
        let mut socket = host.socket().await;
        send(&mut socket, handshake).await;
        assert_eq!(next(&mut socket).await["code"], code, "{label}");
    }
    let mut request = (host.url.replace("http:", "ws:") + "/sync")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", "http://evil".parse().unwrap());
    assert!(
        matches!(connect_async(request).await.unwrap_err(), tokio_tungstenite::tungstenite::Error::Http(response) if response.status()==403)
    );
    assert_eq!(
        host.client
            .get(format!("{}/documents/sync", host.url))
            .header("Upgrade", "websocket")
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::NOT_FOUND
    );
    let mut reader = host.client_replica().await;
    let id = reader.open("a.md").await;
    // Permission denial must apply even to a valid assigned-peer packet.
    let seed = reader.core.snapshot(&id).unwrap();
    let mut buffer = celestite_buffer::Buffer::from_snapshot_with_peer_id(
        &seed,
        reader.core.peer_id(&id).unwrap(),
    )
    .unwrap();
    let update = buffer.edit([(0..0, "forbidden")]).unwrap();
    assert_eq!(
        reader
            .request(
                "updates",
                json!({"id":id,"packet":update.operation,"version":update.after,"operation":1})
            )
            .await["error"]["code"],
        "PermissionDenied"
    );
    assert_eq!(
        host.client
            .get(&host.url)
            .header("Origin", "http://evil")
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::FORBIDDEN
    );
    reader.close().await;
    host.stop().await;
}

#[tokio::test]
async fn restart_discards_unsaved_history_and_invalidates_old_sessions() {
    let root = fixture();
    let host = Host::start(root.path(), false).await;
    let identity = host.identity().await;
    let mut old = host.client_replica().await;
    let id = old.open("a.md").await;
    let version = old.edit(&id, 0, 0, "unsaved").await.snapshot.version;
    assert_eq!(
        std::fs::read_to_string(root.path().join("a.md")).unwrap(),
        "ab🦀cd\nsecond\n"
    );
    let packet = old.core.snapshot(&id).unwrap();
    let saved_id = old.open("unopened.md").await;
    let saved = old.replace(&saved_id, "saved text").await;
    old.ok(
        "save",
        json!({"id":saved_id,"version":saved.snapshot.version}),
    )
    .await;
    let session = old.session.clone();
    let peer_id = old.core.peer_id(&id).unwrap();
    old.close().await;
    host.stop().await;
    let host = Host::start(root.path(), false).await;
    let fresh = host.identity().await;
    assert_eq!(fresh["id"], identity["id"]);
    assert_ne!(fresh["historyId"], identity["historyId"]);
    assert_eq!(host.json("GET", "/documents", Value::Null).await, json!([]));
    assert_eq!(
        host.request("GET", &format!("/documents/{id}"), Value::Null)
            .await
            .status(),
        reqwest::StatusCode::NOT_FOUND
    );
    let mut new = host.client_replica().await;
    let next_id = new.open("a.md").await;
    assert_ne!(next_id, id);
    assert_ne!(new.session, session);
    assert_ne!(new.core.peer_id(&next_id).unwrap(), peer_id);
    assert_eq!(
        new.core.read(&next_id).unwrap().snapshot.text.as_ref(),
        "ab🦀cd\nsecond\n"
    );
    assert!(!new
        .request(
            "updates",
            json!({"id":next_id,"packet":packet,"version":version,"operation":1})
        )
        .await["error"]
        .is_null());
    let restored = new.open("unopened.md").await;
    assert_eq!(
        new.core.read(&restored).unwrap().snapshot.text.as_ref(),
        "saved text"
    );
    assert_eq!(
        host.json("GET", "", Value::Null).await["capabilities"]["persistentHistory"],
        false
    );
    assert_eq!(
        new.ok("probe", json!({"id":next_id,"version":version}))
            .await["committed"],
        false
    );
    send(
        &mut new.socket,
        json!({"method":"ping","sessionId":session,"requestId":999}),
    )
    .await;
    loop {
        let frame = next(&mut new.socket).await;
        if frame["kind"] == "reply" && frame["requestId"] == 999 {
            assert_eq!(frame["error"]["code"], "Closed");
            break;
        }
    }
    new.close().await;
    host.stop().await;
}
