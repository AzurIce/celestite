//! Real HTTP clients and a listening server. No browser or editor view involved.
use celestite_core::*;
use celestite_server::{build_server, Config, HistoryMode, ServerConfig, VaultConfig};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};
use tokio::{sync::oneshot, task::JoinHandle};

struct Server {
    client: Client,
    url: String,
    shutdown: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

impl Server {
    async fn start(root: &Path, state: Option<&Path>, read_only: bool) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = build_server(
            Config {
                server: ServerConfig {
                    listen: address,
                    ..Default::default()
                },
                vaults: vec![VaultConfig {
                    id: "notes".into(),
                    name: "Notes".into(),
                    path: root.into(),
                    read_only,
                    state_dir: state.map(Path::to_owned),
                    ephemeral: state.is_none(),
                    history_mode: if state.is_some_and(|dir| !dir.join("history.redb").exists()) {
                        HistoryMode::Initialize
                    } else {
                        HistoryMode::Recover
                    },
                    ..Default::default()
                }],
            },
            root,
        )
        .unwrap();
        let key = server
            .create_share("notes", celestite_server::Permission::Edit, "test".into())
            .unwrap()
            .key;
        let (shutdown, stopping) = oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, server.router)
                .with_graceful_shutdown(async {
                    let _ = stopping.await;
                })
                .await
                .unwrap();
        });
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap(),
            url: format!("http://{address}/{key}/api/v1"),
            shutdown,
            task,
        }
    }

    async fn request(&self, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
        let response = self
            .client
            .request(method.parse().unwrap(), format!("{}{path}", self.url))
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = response.status();
        assert_eq!(
            response
                .headers()
                .get("cache-control")
                .map(|s| s.to_str().unwrap()),
            Some("no-store")
        );
        let bytes = response.bytes().await.unwrap();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, value)
    }

    async fn ok(&self, method: &str, path: &str, body: Value) -> Value {
        let (status, value) = self.request(method, path, body).await;
        assert!(status.is_success(), "{status}: {value}");
        value
    }

    async fn open(&self, path: &str) -> Value {
        self.ok("POST", "/documents/open", json!({"path": path}))
            .await
    }

    async fn settled(&self, id: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let state = self.ok("GET", &route(id, ""), Value::Null).await;
                if state["externalChange"].is_null() {
                    return state;
                }
                assert_eq!(state["externalChange"]["phase"], "pending", "{state}");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("background observation committed")
    }

    async fn stop(self) {
        drop(self.client);
        let _ = self.shutdown.send(());
        tokio::time::timeout(Duration::from_secs(5), self.task)
            .await
            .unwrap()
            .unwrap();
    }
}

fn snapshot(state: &Value) -> TextSnapshot {
    serde_json::from_value(state["snapshot"].clone()).unwrap()
}
fn transaction(doc: &Document, from: usize, to: usize, insert: &str) -> Transaction {
    Transaction {
        expected_version: doc.version(),
        origin: "headless-client".into(),
        edits: vec![TextEdit {
            from,
            to,
            insert: insert.into(),
        }],
        undo_metadata: None,
        undo_positions: vec![],
    }
}
fn route(id: &str, action: &str) -> String {
    format!("/documents/{id}{action}")
}

#[tokio::test]
async fn replica_commit_checks_file_revision_before_import_and_returns_saved_history() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "A😀B").unwrap();
    let server = Server::start(root.path(), None, false).await;
    let initial = server.open("a.md").await;
    let id = initial["id"].as_str().unwrap();
    let seed: SyncPacket =
        serde_json::from_value(server.ok("GET", &route(id, "/snapshot"), Value::Null).await)
            .unwrap();
    let mut client = Document::from_snapshot(&seed, None).unwrap();
    client.transact(transaction(&client, 3, 3, "中文")).unwrap();
    std::fs::write(root.path().join("a.md"), "external").unwrap();
    let body = json!({"packet":client.export_snapshot().unwrap(),"expectedRevision":initial["backendRevision"],"action":"save"});
    assert_eq!(
        server
            .request("POST", &route(id, "/client-commit"), body.clone())
            .await
            .0,
        StatusCode::CONFLICT
    );
    // Rejected local changes never entered the host history.
    let retained: SyncPacket =
        serde_json::from_value(server.ok("GET", &route(id, "/snapshot"), Value::Null).await)
            .unwrap();
    assert!(!Document::from_snapshot(&retained, None)
        .unwrap()
        .snapshot()
        .text
        .contains("中文"));
    let mut overwrite = body;
    overwrite["action"] = json!("overwrite");
    server.settled(id).await;
    let receipt = server
        .ok("POST", &route(id, "/client-commit"), overwrite)
        .await;
    assert_eq!(
        std::fs::read_to_string(root.path().join("a.md")).unwrap(),
        "A😀中文B"
    );
    assert_eq!(receipt["document"]["savedContent"], "A😀中文B");
    let committed: SyncPacket = serde_json::from_value(receipt["packet"].clone()).unwrap();
    client.import(&committed, "receipt".into()).unwrap();
    assert_eq!(client.snapshot().text, "A😀中文B");
    std::fs::write(root.path().join("a.md"), "discard target").unwrap();
    let discarded = server
        .ok(
            "POST",
            &route(id, "/client-commit"),
            json!({"packet":null,"expectedRevision":"ignored","action":"discard"}),
        )
        .await;
    assert_eq!(discarded["document"]["savedContent"], "discard target");
    let seed: SyncPacket = serde_json::from_value(discarded["packet"].clone()).unwrap();
    let mut other_client = Document::from_snapshot(&seed, None).unwrap();
    other_client
        .transact(transaction(&other_client, 0, 0, "other draft "))
        .unwrap();
    server
        .ok(
            "POST",
            &route(id, "/import"),
            serde_json::to_value(other_client.export_snapshot().unwrap()).unwrap(),
        )
        .await;
    assert_eq!(
        server
            .request(
                "POST",
                &route(id, "/client-commit"),
                json!({"packet":null,"expectedRevision":"ignored","action":"discard"}),
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    let retained = server.ok("GET", &route(id, ""), Value::Null).await;
    assert_eq!(retained["snapshot"]["text"], "other draft discard target");
    server.stop().await;
}

#[tokio::test]
async fn rejected_imports_leave_the_document_and_history_unchanged() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "base").unwrap();
    std::fs::write(root.path().join("b.md"), "other history").unwrap();
    let server = Server::start(root.path(), None, false).await;
    let initial = server.open("a.md").await;
    let id = initial["id"].as_str().unwrap();
    let other = server.open("b.md").await;
    let other_seed = server
        .ok(
            "GET",
            &route(other["id"].as_str().unwrap(), "/snapshot"),
            Value::Null,
        )
        .await;
    assert_eq!(
        server
            .request("POST", &route(id, "/import"), other_seed)
            .await
            .0,
        StatusCode::CONFLICT
    );

    let seed: SyncPacket =
        serde_json::from_value(server.ok("GET", &route(id, "/snapshot"), Value::Null).await)
            .unwrap();
    let mut peer = Document::from_snapshot(&seed, Some(77)).unwrap();
    peer.transact(transaction(&peer, 0, 0, "\r")).unwrap();
    let invalid = peer
        .export_updates_since(&snapshot(&initial).version)
        .unwrap();
    assert_eq!(
        server
            .request(
                "POST",
                &route(id, "/import"),
                serde_json::to_value(invalid).unwrap()
            )
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let mut corrupt = seed;
    corrupt.data = vec![0, 1, 2];
    assert_eq!(
        server
            .request(
                "POST",
                &route(id, "/import"),
                serde_json::to_value(corrupt).unwrap()
            )
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let unchanged = server.ok("GET", &route(id, ""), Value::Null).await;
    assert_eq!(snapshot(&unchanged), snapshot(&initial));
    assert_eq!(unchanged["dirty"], false);
    assert_eq!(
        std::fs::read_to_string(root.path().join("a.md")).unwrap(),
        "base"
    );
    server.stop().await;
}

#[tokio::test]
async fn two_offline_replicas_merge_and_undo_through_real_server() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "A😀B").unwrap();
    std::fs::write(root.path().join("closed.md"), "not opened in a view").unwrap();
    std::fs::write(root.path().join("image.bin"), [0, 255]).unwrap();
    let server = Server::start(root.path(), None, false).await;
    // Discovery includes files that have never had a view or explicit open call.
    let all = server.ok("GET", "/documents", Value::Null).await;
    assert_eq!(all.as_array().unwrap().len(), 2);
    assert!(all
        .as_array()
        .unwrap()
        .iter()
        .any(|doc| doc["path"] == "closed.md"));
    let opened = server.open("a.md").await;
    let id = opened["id"].as_str().unwrap();
    let seed: SyncPacket =
        serde_json::from_value(server.ok("GET", &route(id, "/snapshot"), Value::Null).await)
            .unwrap();
    let base = snapshot(&opened).version;
    let mut a = Document::from_snapshot(&seed, Some(101)).unwrap();
    let mut b = Document::from_snapshot(&seed, Some(202)).unwrap();
    a.transact(transaction(&a, 0, 0, "甲")).unwrap();
    b.transact(transaction(&b, 4, 4, "乙")).unwrap();
    let a_packet = a.export_updates_since(&base).unwrap();
    server
        .ok(
            "POST",
            &route(id, "/import"),
            serde_json::to_value(&a_packet).unwrap(),
        )
        .await;
    server
        .ok(
            "POST",
            &route(id, "/import"),
            serde_json::to_value(b.export_updates_since(&base).unwrap()).unwrap(),
        )
        .await;
    for replica in [&mut a, &mut b] {
        let updates: SyncPacket = serde_json::from_value(
            server
                .ok(
                    "POST",
                    &route(id, "/updates"),
                    serde_json::to_value(replica.version()).unwrap(),
                )
                .await,
        )
        .unwrap();
        replica.import(&updates, "server".into()).unwrap();
        assert_eq!(replica.snapshot().text, "甲A😀B乙");
    }
    let duplicate = server
        .ok(
            "POST",
            &route(id, "/import"),
            serde_json::to_value(&a_packet).unwrap(),
        )
        .await;
    assert!(duplicate["result"]["event"].is_null());
    assert!(duplicate["document"]["durableVersion"].is_null());
    let merged = a.version();
    a.undo(None).unwrap();
    server
        .ok(
            "POST",
            &route(id, "/import"),
            serde_json::to_value(a.export_updates_since(&merged).unwrap()).unwrap(),
        )
        .await;
    let current = server.ok("GET", &route(id, ""), Value::Null).await;
    assert_eq!(snapshot(&current).text, "A😀B乙");
    assert_eq!(
        std::fs::read_to_string(root.path().join("a.md")).unwrap(),
        "A😀B"
    );
    let saved = server
        .ok(
            "POST",
            &route(id, "/save"),
            serde_json::to_value(snapshot(&current).version).unwrap(),
        )
        .await;
    assert_eq!(saved["dirty"], false);
    assert_eq!(
        std::fs::read_to_string(root.path().join("a.md")).unwrap(),
        "A😀B乙"
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("closed.md")).unwrap(),
        "not opened in a view"
    );
    server.stop().await;
}

#[tokio::test]
async fn transactions_versions_and_server_writer_history_are_validated() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "A😀B").unwrap();
    let server = Server::start(root.path(), None, false).await;
    let initial = server.open("a.md").await;
    let id = initial["id"].as_str().unwrap();
    let base = snapshot(&initial).version;
    let invalid = json!({"expected_version": base, "origin": "test", "edits": [{"from": 2, "to": 3, "insert": "bad"}]});
    assert_eq!(
        server
            .request("POST", &route(id, "/transact"), invalid)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let edit = json!({"expected_version": base, "origin": "test", "edits": [{"from": 0, "to": 1, "insert": "中"}]});
    let changed = server
        .ok("POST", &route(id, "/transact"), edit.clone())
        .await;
    assert_eq!(changed["document"]["snapshot"]["text"], "中😀B");
    assert_eq!(
        server
            .request("POST", &route(id, "/transact"), edit)
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        server
            .request(
                "POST",
                &route(id, "/save"),
                serde_json::to_value(&base).unwrap()
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    let undone = server.ok("POST", &route(id, "/undo"), json!({})).await;
    assert_eq!(undone["document"]["snapshot"]["text"], "A😀B");
    let redone = server.ok("POST", &route(id, "/redo"), json!({})).await;
    assert_eq!(redone["document"]["snapshot"]["text"], "中😀B");
    server.stop().await;
}

#[tokio::test]
async fn pending_packets_and_unsaved_history_survive_server_restart() {
    let root = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "base").unwrap();
    let server = Server::start(root.path(), Some(state.path()), false).await;
    let initial = server.open("a.md").await;
    let id = initial["id"].as_str().unwrap().to_string();
    let seed: SyncPacket = serde_json::from_value(
        server
            .ok("GET", &route(&id, "/snapshot"), Value::Null)
            .await,
    )
    .unwrap();
    let mut peer = Document::from_snapshot(&seed, Some(42)).unwrap();
    let base = peer.version();
    peer.transact(transaction(&peer, 0, 0, "one ")).unwrap();
    let first = peer.export_updates_since(&base).unwrap();
    let middle = peer.version();
    peer.transact(transaction(&peer, 8, 8, " two")).unwrap();
    let last = peer.export_updates_since(&middle).unwrap();
    let waiting = server
        .ok(
            "POST",
            &route(&id, "/import"),
            serde_json::to_value(last).unwrap(),
        )
        .await;
    assert_eq!(waiting["result"]["pending"], true);
    server.stop().await;
    let server = Server::start(root.path(), Some(state.path()), false).await;
    let restored = server.open("a.md").await;
    assert_eq!(restored["id"], id);
    assert_eq!(snapshot(&restored).text, "base");
    assert!(restored["durableVersion"].is_object());
    let completed = server
        .ok(
            "POST",
            &route(&id, "/import"),
            serde_json::to_value(first).unwrap(),
        )
        .await;
    assert_eq!(completed["document"]["snapshot"]["text"], "one base two");
    assert_eq!(completed["document"]["dirty"], true);
    assert_eq!(
        std::fs::read_to_string(root.path().join("a.md")).unwrap(),
        "base"
    );
    let durable = completed["document"]["durableVersion"].clone();
    assert_eq!(durable, completed["document"]["snapshot"]["version"]);
    server.stop().await;
    let server = Server::start(root.path(), Some(state.path()), false).await;
    let restored = server.open("a.md").await;
    assert_eq!(snapshot(&restored).text, "one base two");
    assert_eq!(
        serde_json::to_value(snapshot(&restored).version).unwrap(),
        durable
    );
    server.stop().await;
}

#[tokio::test]
async fn external_changes_merge_with_dirty_history_and_are_preserved_across_restart() {
    let root = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "old").unwrap();
    let server = Server::start(root.path(), Some(state.path()), false).await;
    let initial = server.open("a.md").await;
    let id = initial["id"].as_str().unwrap().to_string();
    std::fs::write(root.path().join("a.md"), "external").unwrap();
    let clean = server.settled(&id).await;
    assert_eq!(snapshot(&clean).text, "external");
    assert_eq!(clean["undo"]["can_undo"], false);
    server.ok("POST", &route(&id, "/transact"), json!({"expected_version": snapshot(&clean).version, "origin": "test", "edits": [{"from": 8, "to": 8, "insert": " local"}]})).await;
    std::fs::write(root.path().join("a.md"), "other editor").unwrap();
    let dirty = server.settled(&id).await;
    assert_eq!(snapshot(&dirty).text, "other editor local");
    assert_eq!(dirty["conflict"], false);
    assert_eq!(
        server
            .request(
                "POST",
                &route(&id, "/save"),
                serde_json::to_value(snapshot(&clean).version).unwrap()
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    let read = server
        .client
        .get(format!("{}/file?path=a.md", server.url))
        .send()
        .await
        .unwrap();
    let revision = read.headers()["etag"].to_str().unwrap().to_string();
    drop(read);
    let legacy = server
        .client
        .put(format!("{}/file?path=a.md&mode=replace", server.url))
        .header("if-match", revision)
        .body("bypass")
        .send()
        .await
        .unwrap();
    assert_eq!(legacy.status(), StatusCode::CONFLICT);
    drop(legacy);
    server.stop().await;
    let server = Server::start(root.path(), Some(state.path()), false).await;
    let recovered = server.open("a.md").await;
    assert_eq!(snapshot(&recovered).text, "other editor local");
    assert_eq!(recovered["conflict"], false);
    assert_eq!(
        std::fs::read_to_string(root.path().join("a.md")).unwrap(),
        "other editor"
    );
    server
        .ok(
            "POST",
            &route(&id, "/save"),
            serde_json::to_value(snapshot(&recovered).version).unwrap(),
        )
        .await;
    assert_eq!(
        std::fs::read_to_string(root.path().join("a.md")).unwrap(),
        "other editor local"
    );
    server.stop().await;
}

#[tokio::test]
async fn move_preserves_identity_and_delete_cannot_be_undone_by_late_save() {
    let root = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("folder")).unwrap();
    std::fs::write(root.path().join("folder/a.md"), "base").unwrap();
    let server = Server::start(root.path(), Some(state.path()), false).await;
    let initial = server.open("folder/a.md").await;
    let id = initial["id"].as_str().unwrap().to_string();
    server.ok("POST", &route(&id, "/transact"), json!({"expected_version": snapshot(&initial).version, "origin": "test", "edits": [{"from": 4, "to": 4, "insert": " edit"}]})).await;
    let response = server
        .client
        .post(format!("{}/rename", server.url))
        .json(&json!({"from": "folder", "to": "renamed"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    drop(response);
    let moved = server.open("renamed/a.md").await;
    assert_eq!(moved["id"], id);
    assert_eq!(snapshot(&moved).text, "base edit");
    server
        .ok(
            "POST",
            &route(&id, "/save"),
            serde_json::to_value(snapshot(&moved).version).unwrap(),
        )
        .await;
    assert!(!root.path().join("folder").exists());
    let response = server
        .client
        .delete(format!("{}/entry?path=renamed&recursive=true", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    drop(response);
    assert_eq!(
        server
            .request(
                "POST",
                &route(&id, "/save"),
                serde_json::to_value(snapshot(&moved).version).unwrap()
            )
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let removed = server.ok("GET", &route(&id, ""), Value::Null).await;
    assert_eq!(removed["deleted"], true);
    assert_eq!(snapshot(&removed).text, "base edit");
    server.stop().await;
    let server = Server::start(root.path(), Some(state.path()), false).await;
    let removed = server.ok("GET", &route(&id, ""), Value::Null).await;
    assert_eq!(removed["deleted"], true);
    assert!(!root.path().join("renamed").exists());
    server.stop().await;
}

#[tokio::test]
async fn bom_and_crlf_roundtrip_and_read_only_rejects_editor_mutations() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "\u{feff}a\r\nb\r\n").unwrap();
    let server = Server::start(root.path(), None, false).await;
    let initial = server.open("a.md").await;
    let id = initial["id"].as_str().unwrap();
    assert_eq!(snapshot(&initial).text, "a\nb\n");
    let changed = server.ok("POST", &route(id, "/transact"), json!({"expected_version": snapshot(&initial).version, "origin": "test", "edits": [{"from": 0, "to": 1, "insert": "中😀"}]})).await;
    server
        .ok(
            "POST",
            &route(id, "/save"),
            changed["document"]["snapshot"]["version"].clone(),
        )
        .await;
    assert_eq!(
        std::fs::read_to_string(root.path().join("a.md")).unwrap(),
        "\u{feff}中😀\r\nb\r\n"
    );
    server.stop().await;
    let server = Server::start(root.path(), None, true).await;
    let initial = server.open("a.md").await;
    let id = initial["id"].as_str().unwrap();
    for action in ["/transact", "/undo", "/redo", "/save", "/import"] {
        let body = match action {
            "/transact" => {
                json!({"expected_version": snapshot(&initial).version, "origin": "test", "edits": []})
            }
            "/save" => initial["snapshot"]["version"].clone(),
            "/import" => server.ok("GET", &route(id, "/snapshot"), Value::Null).await,
            _ => json!({}),
        };
        assert_eq!(
            server.request("POST", &route(id, action), body).await.0,
            StatusCode::FORBIDDEN
        );
    }
    server.stop().await;
}
