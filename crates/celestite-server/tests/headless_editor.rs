//! Real HTTP clients and a listening server. No browser or editor view involved.
use celestite_core::*;
use celestite_server::{build_server, Config, ServerConfig, VaultConfig};
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
    async fn start(root: &Path, read_only: bool) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = build_server(
            Config {
                server: ServerConfig {
                    listen: address,
                    ..Default::default()
                },
                vault: VaultConfig {
                    name: "Notes".into(),
                    path: root.into(),
                    read_only,
                    ..Default::default()
                },
            },
            root,
        )
        .unwrap();
        let key = server
            .links
            .key(celestite_server::Permission::Edit)
            .to_owned();
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
fn transaction(doc: &Buffer, from: usize, to: usize, insert: &str) -> BufferCommand {
    BufferCommand::Edit(Edit {
        base: doc.version(),
        input: TextInput::Edits {
            edits: vec![TextEdit {
                from,
                to,
                insert: insert.into(),
            }],
        },
        origin: "headless-client".into(),
        group: None,
        undo: UndoContext {
            metadata: None,
            positions: vec![],
        },
    })
}
fn route(id: &str, action: &str) -> String {
    format!("/documents/{id}{action}")
}

#[tokio::test]
async fn replica_commit_checks_file_revision_before_import_and_returns_saved_history() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "A😀B").unwrap();
    let server = Server::start(root.path(), false).await;
    let initial = server.open("a.md").await;
    let id = initial["id"].as_str().unwrap();
    let seed: SyncPacket =
        serde_json::from_value(server.ok("GET", &route(id, "/snapshot"), Value::Null).await)
            .unwrap();
    let mut client = Buffer::from_snapshot(&seed, None).unwrap();
    let _ = client.apply(transaction(&client, 3, 3, "中文")).unwrap();
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
    assert!(!Buffer::from_snapshot(&retained, None)
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
    let _ = client
        .apply(BufferCommand::Import(Import::new(
            (committed).clone(),
            "receipt",
        )))
        .unwrap();
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
    let mut other_client = Buffer::from_snapshot(&seed, None).unwrap();
    let _ = other_client
        .apply(transaction(&other_client, 0, 0, "other draft "))
        .unwrap();
    server
        .ok("POST", &route(id, "/apply"), json!({"kind":"import","packet":serde_json::to_value(other_client.export_snapshot().unwrap()).unwrap()}))
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
    let server = Server::start(root.path(), false).await;
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
            .request(
                "POST",
                &route(id, "/apply"),
                json!({"kind":"import","packet":other_seed})
            )
            .await
            .0,
        StatusCode::CONFLICT
    );

    let seed: SyncPacket =
        serde_json::from_value(server.ok("GET", &route(id, "/snapshot"), Value::Null).await)
            .unwrap();
    let mut peer = Buffer::from_snapshot(&seed, Some(77)).unwrap();
    let _ = peer.apply(transaction(&peer, 0, 0, "\r")).unwrap();
    let invalid = peer
        .export_updates_since(&snapshot(&initial).version)
        .unwrap();
    assert_eq!(
        server
            .request(
                "POST",
                &route(id, "/apply"),
                json!({"kind":"import","packet":serde_json::to_value(invalid).unwrap()})
            )
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let mut corrupt = seed;
    corrupt.data = vec![0, 1, 2].into();
    assert_eq!(
        server
            .request(
                "POST",
                &route(id, "/apply"),
                json!({"kind":"import","packet":serde_json::to_value(corrupt).unwrap()})
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
async fn two_independent_replicas_merge_and_undo_through_real_server() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "A😀B").unwrap();
    std::fs::write(root.path().join("closed.md"), "not opened in a view").unwrap();
    std::fs::write(root.path().join("image.bin"), [0, 255]).unwrap();
    let server = Server::start(root.path(), false).await;
    let all = server.ok("GET", "/documents", Value::Null).await;
    assert!(all.as_array().unwrap().is_empty());
    let opened = server.open("a.md").await;
    let id = opened["id"].as_str().unwrap();
    let seed: SyncPacket =
        serde_json::from_value(server.ok("GET", &route(id, "/snapshot"), Value::Null).await)
            .unwrap();
    let base = snapshot(&opened).version;
    let mut a = Buffer::from_snapshot(&seed, Some(101)).unwrap();
    let mut b = Buffer::from_snapshot(&seed, Some(202)).unwrap();
    let _ = a.apply(transaction(&a, 0, 0, "甲")).unwrap();
    let _ = b.apply(transaction(&b, 4, 4, "乙")).unwrap();
    let a_packet = a.export_updates_since(&base).unwrap();
    server
        .ok(
            "POST",
            &route(id, "/apply"),
            json!({"kind":"import","packet":serde_json::to_value(&a_packet).unwrap()}),
        )
        .await;
    server
        .ok("POST", &route(id, "/apply"), json!({"kind":"import","packet":serde_json::to_value(b.export_updates_since(&base).unwrap()).unwrap()}))
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
        let _ = replica
            .apply(BufferCommand::Import(Import::new(
                (updates).clone(),
                "server",
            )))
            .unwrap();
        assert_eq!(replica.snapshot().text, "甲A😀B乙");
    }
    let duplicate = server
        .ok(
            "POST",
            &route(id, "/apply"),
            json!({"kind":"import","packet":serde_json::to_value(&a_packet).unwrap()}),
        )
        .await;
    assert_eq!(duplicate["update"]["changed"], false);
    assert!(duplicate["update"]["operation"].is_null());
    assert!(duplicate["document"]["durableVersion"].is_null());
    let merged = a.version();
    let _ = a
        .apply(BufferCommand::Undo {
            base: a.version(),
            context: UndoContext::default(),
        })
        .unwrap();
    server
        .ok("POST", &route(id, "/apply"), json!({"kind":"import","packet":serde_json::to_value(a.export_updates_since(&merged).unwrap()).unwrap()}))
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
    let server = Server::start(root.path(), false).await;
    let initial = server.open("a.md").await;
    let id = initial["id"].as_str().unwrap();
    let base = snapshot(&initial).version;
    let invalid = json!({"kind":"edit","base":base,"origin":"test","input":{"kind":"edits","edits":[{"from": 2, "to": 3, "insert": "bad"}]},"undo":{"metadata":null,"positions":[]}});
    assert_eq!(
        server
            .request("POST", &route(id, "/apply"), invalid)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let edit = json!({"kind":"edit","base":base,"origin":"test","input":{"kind":"edits","edits":[{"from": 0, "to": 1, "insert": "中"}]},"undo":{"metadata":null,"positions":[]}});
    let changed = server.ok("POST", &route(id, "/apply"), edit.clone()).await;
    assert_eq!(changed["document"]["snapshot"]["text"], "中😀B");
    assert_eq!(
        server.request("POST", &route(id, "/apply"), edit).await.0,
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
    let undone = server
        .ok(
            "POST",
            &route(id, "/apply"),
            json!({"kind":"undo","base":changed["document"]["snapshot"]["version"]}),
        )
        .await;
    assert_eq!(undone["document"]["snapshot"]["text"], "A😀B");
    let redone = server
        .ok(
            "POST",
            &route(id, "/apply"),
            json!({"kind":"redo","base":undone["document"]["snapshot"]["version"]}),
        )
        .await;
    assert_eq!(redone["document"]["snapshot"]["text"], "中😀B");
    server.stop().await;
}

#[tokio::test]
async fn pending_packets_complete_in_memory_and_unsaved_history_expires_on_restart() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "base").unwrap();
    let server = Server::start(root.path(), false).await;
    let initial = server.open("a.md").await;
    let id = initial["id"].as_str().unwrap().to_string();
    let seed: SyncPacket = serde_json::from_value(
        server
            .ok("GET", &route(&id, "/snapshot"), Value::Null)
            .await,
    )
    .unwrap();
    let mut peer = Buffer::from_snapshot(&seed, Some(42)).unwrap();
    let base = peer.version();
    let _ = peer.apply(transaction(&peer, 0, 0, "one ")).unwrap();
    let first = peer.export_updates_since(&base).unwrap();
    let middle = peer.version();
    let _ = peer.apply(transaction(&peer, 8, 8, " two")).unwrap();
    let last = peer.export_updates_since(&middle).unwrap();
    let waiting = server
        .ok(
            "POST",
            &route(&id, "/apply"),
            json!({"kind":"import","packet":serde_json::to_value(last).unwrap()}),
        )
        .await;
    assert_eq!(waiting["update"]["pending"], true);
    let completed = server
        .ok(
            "POST",
            &route(&id, "/apply"),
            json!({"kind":"import","packet":serde_json::to_value(first).unwrap()}),
        )
        .await;
    assert_eq!(completed["document"]["snapshot"]["text"], "one base two");
    assert_eq!(completed["document"]["dirty"], true);
    assert_eq!(
        std::fs::read_to_string(root.path().join("a.md")).unwrap(),
        "base"
    );
    assert!(completed["document"]["durableVersion"].is_null());
    server.stop().await;
    let server = Server::start(root.path(), false).await;
    let restored = server.open("a.md").await;
    assert_eq!(snapshot(&restored).text, "base");
    assert_ne!(restored["id"], id);
    assert!(restored["durableVersion"].is_null());
    server.stop().await;
}

#[tokio::test]
async fn external_changes_merge_with_dirty_buffers_and_saved_bytes_survive_restart() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "old").unwrap();
    let server = Server::start(root.path(), false).await;
    let initial = server.open("a.md").await;
    let id = initial["id"].as_str().unwrap().to_string();
    std::fs::write(root.path().join("a.md"), "external").unwrap();
    let clean = server.settled(&id).await;
    assert_eq!(snapshot(&clean).text, "external");
    assert_eq!(clean["undo"]["canUndo"], false);
    server.ok("POST", &route(&id, "/apply"), json!({"kind":"edit","base":snapshot(&clean).version,"origin":"test","input":{"kind":"edits","edits":[{"from": 8, "to": 8, "insert": " local"}]},"undo":{"metadata":null,"positions":[]}})).await;
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
    assert_eq!(
        std::fs::read_to_string(root.path().join("a.md")).unwrap(),
        "other editor"
    );
    server
        .ok(
            "POST",
            &route(&id, "/save"),
            serde_json::to_value(snapshot(&dirty).version).unwrap(),
        )
        .await;
    assert_eq!(
        std::fs::read_to_string(root.path().join("a.md")).unwrap(),
        "other editor local"
    );
    server.stop().await;
    let server = Server::start(root.path(), false).await;
    let reopened = server.open("a.md").await;
    assert_eq!(snapshot(&reopened).text, "other editor local");
    assert_ne!(reopened["id"], id);
    assert_eq!(reopened["dirty"], false);
    server.stop().await;
}

#[tokio::test]
async fn move_preserves_identity_and_delete_cannot_be_undone_by_late_save() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("folder")).unwrap();
    std::fs::write(root.path().join("folder/a.md"), "base").unwrap();
    let server = Server::start(root.path(), false).await;
    let initial = server.open("folder/a.md").await;
    let id = initial["id"].as_str().unwrap().to_string();
    server.ok("POST", &route(&id, "/apply"), json!({"kind":"edit","base":snapshot(&initial).version,"origin":"test","input":{"kind":"edits","edits":[{"from": 4, "to": 4, "insert": " edit"}]},"undo":{"metadata":null,"positions":[]}})).await;
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
    let server = Server::start(root.path(), false).await;
    assert_eq!(
        server.request("GET", &route(&id, ""), Value::Null).await.0,
        StatusCode::NOT_FOUND
    );
    assert!(!root.path().join("renamed").exists());
    server.stop().await;
}

#[tokio::test]
async fn bom_and_crlf_roundtrip_and_read_only_rejects_editor_mutations() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "\u{feff}a\r\nb\r\n").unwrap();
    let server = Server::start(root.path(), false).await;
    let initial = server.open("a.md").await;
    let id = initial["id"].as_str().unwrap();
    assert_eq!(snapshot(&initial).text, "a\nb\n");
    let changed = server.ok("POST", &route(id, "/apply"), json!({"kind":"edit","base":snapshot(&initial).version,"origin":"test","input":{"kind":"edits","edits":[{"from": 0, "to": 1, "insert": "中😀"}]},"undo":{"metadata":null,"positions":[]}})).await;
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
    let server = Server::start(root.path(), true).await;
    let initial = server.open("a.md").await;
    let id = initial["id"].as_str().unwrap();
    let packet = server.ok("GET", &route(id, "/snapshot"), Value::Null).await;
    for command in [
        json!({"kind":"edit","base":initial["snapshot"]["version"],"input":{"kind":"edits","edits":[]}}),
        json!({"kind":"undo","base":initial["snapshot"]["version"]}),
        json!({"kind":"redo","base":initial["snapshot"]["version"]}),
        json!({"kind":"import","packet":packet}),
        json!({"kind":"clear_undo"}),
    ] {
        assert_eq!(
            server
                .request("POST", &route(id, "/apply"), command)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        server
            .request(
                "POST",
                &route(id, "/save"),
                initial["snapshot"]["version"].clone()
            )
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    server.stop().await;
}
