use celestite_core::{
    Buffer, BufferCommand, Edit, Import, SyncPacket, TextEdit, TextInput, UndoContext,
};
use celestite_server::{Config, HistoryMode, ServerConfig, VaultConfig, build_server};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
struct Host {
    root: tempfile::TempDir,
    _state: tempfile::TempDir,
    url: String,
    identity: Value,
    stopping: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}
impl Host {
    async fn new(read_only: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.md"), "ab🦀cd\nsecond\n").unwrap();
        std::fs::write(root.path().join("unopened.md"), "untouched").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = build_server(
            Config {
                server: ServerConfig {
                    listen: address,
                    allowed_origins: vec!["http://allowed".into()],
                    ..Default::default()
                },
                vault: VaultConfig {
                    name: "Notes".into(),
                    path: root.path().into(),
                    state_dir: Some(state.path().into()),
                    history_mode: HistoryMode::Initialize,
                    read_only,
                    ..Default::default()
                },
            },
            root.path(),
        )
        .unwrap();
        let key = server
            .links
            .key(celestite_server::Permission::Edit)
            .to_owned();
        let stopping = server.shutdown;
        let mut signal = stopping.subscribe();
        let task = tokio::spawn(async move {
            axum::serve(listener, server.router)
                .with_graceful_shutdown(async move {
                    while !*signal.borrow() {
                        if signal.changed().await.is_err() {
                            break;
                        }
                    }
                })
                .await
                .unwrap();
        });
        let url = format!("http://{address}/{key}/api/v1");
        let identity = reqwest::Client::new()
            .get(&url)
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()["vaultIdentity"]
            .clone();
        Self {
            root,
            _state: state,
            url,
            identity,
            stopping,
            task,
        }
    }
    async fn restart(&mut self) {
        self.stopping.send_replace(true);
        tokio::time::timeout(Duration::from_secs(5), &mut self.task)
            .await
            .unwrap()
            .unwrap();
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
                    path: self.root.path().into(),
                    state_dir: Some(self._state.path().into()),
                    history_mode: HistoryMode::Recover,
                    ..Default::default()
                },
            },
            self.root.path(),
        )
        .unwrap();
        let key = self.url.split('/').nth(3).unwrap().to_string();
        self.stopping = server.shutdown;
        let mut signal = self.stopping.subscribe();
        self.task = tokio::spawn(async move {
            axum::serve(listener, server.router)
                .with_graceful_shutdown(async move {
                    while !*signal.borrow() {
                        if signal.changed().await.is_err() {
                            break;
                        }
                    }
                })
                .await
                .unwrap();
        });
        self.url = format!("http://{address}/{key}/api/v1");
    }
    async fn socket(&self) -> Socket {
        connect_async(self.url.replace("http:", "ws:") + "/sync")
            .await
            .unwrap()
            .0
    }
    async fn client(&self) -> Replica {
        let mut socket = self.socket().await;
        send(
            &mut socket,
            json!({"protocolVersion":1,"vaultIdentity":self.identity}),
        )
        .await;
        let hello = next(&mut socket).await;
        assert_eq!(hello["kind"], "hello");
        let mut doc = None;
        let mut writer = String::new();
        loop {
            let frame = next(&mut socket).await;
            if frame["kind"] == "ready" {
                break;
            }
            if frame["kind"] == "document" && frame["document"]["path"] == "a.md" {
                let packet: SyncPacket = serde_json::from_value(frame["packet"].clone()).unwrap();
                if let Some(doc) = doc.as_mut() {
                    let _ =
                        Buffer::apply(doc, BufferCommand::Import(Import::new(packet, "initial")))
                            .unwrap();
                } else {
                    writer = frame["writerId"].as_str().unwrap().into();
                    doc = Some(
                        Buffer::from_snapshot(&packet, Some(writer.parse().unwrap())).unwrap(),
                    );
                }
            }
        }
        Replica {
            socket,
            session: hello["sessionId"].as_str().unwrap().into(),
            document: doc.unwrap(),
            writer,
            next_request: 0,
            next_operation: 0,
        }
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        self.stopping.send_replace(true);
        self.task.abort();
    }
}
async fn send(socket: &mut Socket, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}
async fn next(socket: &mut Socket) -> Value {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let message = socket.next().await.unwrap().unwrap();
            if let Message::Text(text) = message {
                return serde_json::from_str(&text).unwrap();
            }
        }
    })
    .await
    .unwrap()
}
struct Replica {
    socket: Socket,
    session: String,
    document: Buffer,
    writer: String,
    next_request: u64,
    next_operation: u64,
}
impl Replica {
    fn edit(&mut self, from: usize, to: usize, insert: &str) -> Value {
        let before = self.document.version();
        let _ = self
            .document
            .apply(BufferCommand::Edit(Edit {
                base: before.clone(),
                input: TextInput::Edits {
                    edits: vec![TextEdit {
                        from,
                        to,
                        insert: insert.into(),
                    }],
                },
                origin: "test".into(),
                group: None,
                undo: UndoContext {
                    metadata: None,
                    positions: vec![],
                },
            }))
            .unwrap();
        self.next_operation += 1;
        json!({"method":"updates","id":self.document.identity().document_id,"packet":self.document.export_updates_since(&before).unwrap(),"version":self.document.version(),"operation":self.next_operation})
    }
    async fn request(&mut self, mut value: Value) -> Value {
        self.next_request += 1;
        value["requestId"] = json!(self.next_request);
        value["sessionId"] = json!(self.session);
        send(&mut self.socket, value).await;
        loop {
            let frame = next(&mut self.socket).await;
            if frame["kind"] == "reply" && frame["requestId"] == self.next_request {
                return frame;
            }
            self.accept(frame);
        }
    }
    fn accept(&mut self, frame: Value) {
        if frame["kind"] == "document"
            && frame["document"]["id"] == self.document.identity().document_id
        {
            let packet: SyncPacket = serde_json::from_value(frame["packet"].clone()).unwrap();
            let _ = self
                .document
                .apply(BufferCommand::Import(Import::new((packet).clone(), "host")))
                .unwrap();
        }
    }
    async fn until_text(&mut self, expected: &str) {
        while self.document.snapshot().text != expected {
            let frame = next(&mut self.socket).await;
            self.accept(frame);
        }
    }
}
#[tokio::test]
async fn independent_writers_converge_without_saving_and_acknowledge_durable_history() {
    let host = Host::new(false).await;
    let mut a = host.client().await;
    let mut b = host.client().await;
    assert_ne!(a.writer, b.writer);
    let first = a.edit(0, 0, "A");
    let second = b.edit(6, 6, "B");
    let ack = a.request(first).await;
    assert!(ack["error"].is_null(), "{ack}");
    let ack = b.request(second).await;
    assert!(ack["error"].is_null(), "{ack}");
    a.until_text("Aab🦀cdB\nsecond\n").await;
    b.until_text("Aab🦀cdB\nsecond\n").await;
    assert_eq!(
        std::fs::read_to_string(host.root.path().join("a.md")).unwrap(),
        "ab🦀cd\nsecond\n"
    );
    let saved=a.request(json!({"method":"save","id":a.document.identity().document_id,"version":a.document.version()})).await;
    assert!(saved["error"].is_null(), "{saved}");
    assert_eq!(
        saved["result"]["document"]["durableVersion"],
        saved["result"]["document"]["snapshot"]["version"]
    );
    assert_eq!(
        std::fs::read_to_string(host.root.path().join("a.md")).unwrap(),
        a.document.snapshot().text
    );
}
#[tokio::test]
async fn operation_replay_is_idempotent_and_new_sessions_reject_old_writers() {
    let host = Host::new(false).await;
    let mut old = host.client().await;
    let update = old.edit(0, 0, "confirmed");
    let ack = old.request(update.clone()).await;
    assert!(ack["error"].is_null(), "{ack}");
    let replay = old.request(update.clone()).await;
    assert_eq!(ack["result"], replay["result"]);
    let mut altered = update.clone();
    altered["version"]["clocks"][old.writer.clone()] = json!(999);
    assert_eq!(old.request(altered).await["error"]["code"], "InvalidEdit");
    let orphan = old.edit(0, 0, "unsent");
    old.socket.close(None).await.unwrap();
    let mut new = host.client().await;
    assert_ne!(old.writer, new.writer);
    let mut smuggled = orphan;
    smuggled["operation"] = json!(1);
    assert_eq!(new.request(smuggled).await["error"]["code"], "InvalidEdit");
    let proof=new.request(json!({"method":"probe","id":new.document.identity().document_id,"version":ack["result"]["version"]})).await;
    assert_eq!(proof["result"]["committed"], true);
    let proof=new.request(json!({"method":"probe","id":new.document.identity().document_id,"version":old.document.version()})).await;
    assert_eq!(proof["result"]["committed"], false);
}
#[tokio::test]
async fn external_changes_are_pushed_for_unopened_documents_and_survive_initial_snapshot() {
    let host = Host::new(false).await;
    let mut a = host.client().await;
    std::fs::write(host.root.path().join("a.md"), "external🦀").unwrap();
    a.until_text("external🦀").await;
    std::fs::write(
        host.root.path().join("unopened.md"),
        "observed without opening",
    )
    .unwrap();
    loop {
        let frame = next(&mut a.socket).await;
        if frame["kind"] == "document" && frame["document"]["path"] == "unopened.md" {
            if frame["document"]["externalChange"]["phase"] == "pending" {
                // Metadata can announce queued work before its history commits.
                continue;
            }
            assert_eq!(
                frame["document"]["savedContent"],
                "observed without opening"
            );
            break;
        }
    }
    let b = host.client().await;
    assert_eq!(b.document.snapshot().text, "external🦀");
}
#[tokio::test]
async fn handshake_auth_history_and_read_only_are_enforced() {
    let host = Host::new(true).await;
    let mut wrong = host.socket().await;
    send(
        &mut wrong,
        json!({"protocolVersion":0,"vaultIdentity":host.identity}),
    )
    .await;
    assert_eq!(next(&mut wrong).await["code"], "PermissionDenied");
    let mut wrong = host.socket().await;
    send(
        &mut wrong,
        json!({"protocolVersion":1,"vaultIdentity":{"id":"wrong","historyId":"wrong"}}),
    )
    .await;
    assert_eq!(next(&mut wrong).await["code"], "Conflict");
    let mut request = (host.url.replace("http:", "ws:") + "/sync")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", "http://evil".parse().unwrap());
    let rejected = connect_async(request).await.unwrap_err();
    assert!(
        matches!(rejected, tokio_tungstenite::tungstenite::Error::Http(response) if response.status()==403)
    );
    let bypass = reqwest::Client::new()
        .get(format!("{}/documents/sync", host.url))
        .header("Upgrade", "websocket")
        .send()
        .await
        .unwrap();
    assert_eq!(bypass.status(), reqwest::StatusCode::NOT_FOUND);
    let mut readonly = host.client().await;
    let update = readonly.edit(0, 0, "forbidden");
    assert_eq!(
        readonly.request(update).await["error"]["code"],
        "PermissionDenied"
    );
    let response = reqwest::Client::new()
        .get(&host.url)
        .header("Origin", "http://evil")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_lost_receipt_can_be_proven_after_restart_without_replaying_the_old_session() {
    let mut host = Host::new(false).await;
    let mut old = host.client().await;
    let update = old.edit(0, 0, "durable");
    old.next_request += 1;
    let mut wire = update;
    wire["requestId"] = json!(old.next_request);
    wire["sessionId"] = json!(old.session);
    send(&mut old.socket, wire).await;
    // Deliberately do not read the acknowledgement. Verify durable host state
    // through an independent observer, then sever the old session.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let states = reqwest::Client::new()
                .get(format!("{}/documents", host.url))
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap();
            if states.as_array().unwrap().iter().any(|state| {
                state["path"] == "a.md"
                    && state["snapshot"]["version"]
                        == serde_json::to_value(old.document.version()).unwrap()
            }) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    old.socket.close(None).await.unwrap();
    host.restart().await;
    let mut new = host.client().await;
    assert_eq!(new.document.snapshot().text, old.document.snapshot().text);
    assert_ne!(new.session, old.session);
    assert_ne!(new.writer, old.writer);
    let proof=new.request(json!({"method":"probe","id":new.document.identity().document_id,"version":old.document.version()})).await;
    assert_eq!(proof["result"]["committed"], true);
    let mut stale = json!({"method":"ping","sessionId":old.session,"requestId":999});
    stale["sessionId"] = json!(old.session);
    send(&mut new.socket, stale).await;
    loop {
        let frame = next(&mut new.socket).await;
        if frame["kind"] == "reply" && frame["requestId"] == 999 {
            assert_eq!(frame["error"]["code"], "Closed");
            break;
        }
    }
    assert_eq!(
        std::fs::read_to_string(host.root.path().join("a.md")).unwrap(),
        "ab🦀cd\nsecond\n"
    );
}
