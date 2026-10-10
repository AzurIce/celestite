#![allow(dead_code)]
use celestite_buffer::types::{HistoryPacket, Version};
use celestite_core::{
    backend::memory::MemoryBackend,
    editor::{
        replica::ReplicaDocument,
        types::{EditorDocument, EditorMutation, ReplicaHostState},
        EditorCore,
    },
    instance::{InstanceIdentity, Vault},
};
use celestite_server::{build_server, Config, Permission, ServerConfig, VaultConfig};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path, time::Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

pub struct Host {
    pub url: String,
    pub readonly_url: String,
    pub client: reqwest::Client,
    stopping: tokio::sync::watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl Host {
    pub async fn start(root: &Path, read_only: bool) -> Self {
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
                    path: root.into(),
                    read_only,
                    share_key: Some("test-only stable secret 12345678901234567890".into()),
                    ..Default::default()
                },
            },
            root,
        )
        .unwrap();
        let url = format!(
            "http://{address}/{}/api/v1",
            server.links.key(Permission::Edit)
        );
        let readonly_url = format!(
            "http://{address}/{}/api/v1",
            server.links.key(Permission::Readonly)
        );
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
        Self {
            url,
            readonly_url,
            client: reqwest::Client::new(),
            stopping,
            task: Some(task),
        }
    }
    pub async fn request(&self, method: &str, path: &str, body: Value) -> reqwest::Response {
        self.client
            .request(method.parse().unwrap(), format!("{}{path}", self.url))
            .json(&body)
            .send()
            .await
            .unwrap()
    }
    pub async fn json(&self, method: &str, path: &str, body: Value) -> Value {
        let response = self.request(method, path, body).await;
        let status = response.status();
        let bytes = response.bytes().await.unwrap();
        assert!(
            status.is_success(),
            "{status}: {}",
            String::from_utf8_lossy(&bytes)
        );
        if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        }
    }
    pub async fn client_replica(&self) -> ClientReplica {
        ClientReplica::connect(&self.url).await
    }
    pub async fn identity(&self) -> Value {
        self.json("GET", "", Value::Null).await["vaultIdentity"].clone()
    }
    pub async fn socket(&self) -> Socket {
        connect_async(self.url.replace("http:", "ws:") + "/sync")
            .await
            .unwrap()
            .0
    }
    pub async fn stop(mut self) {
        self.stopping.send_replace(true);
        tokio::time::timeout(Duration::from_secs(5), self.task.take().unwrap())
            .await
            .unwrap()
            .unwrap();
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        self.stopping.send_replace(true);
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// The headless client runs the production EditorCore and session protocol.
/// It does not call privileged HTTP edit/import/save endpoints.
pub struct ClientReplica {
    pub core: EditorCore<MemoryBackend>,
    pub session: String,
    pub members: Value,
    pub socket: Socket,
    sequence: HashMap<String, u64>,
    saved: HashMap<String, String>,
    request: u64,
    operation: u64,
    read_only: bool,
}
impl ClientReplica {
    pub async fn connect(url: &str) -> Self {
        let descriptor = reqwest::get(url)
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        let identity = descriptor["vaultIdentity"].clone();
        let mut socket = connect_async(url.replace("http:", "ws:") + "/sync")
            .await
            .unwrap()
            .0;
        socket
            .send(Message::Text(
                json!({"protocolVersion":3,"vaultIdentity":identity})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let hello = next(&mut socket).await;
        assert_eq!(hello["kind"], "hello");
        loop {
            let frame = next(&mut socket).await;
            assert_ne!(frame["kind"], "document", "handshake must not load buffers");
            if frame["kind"] == "ready" {
                break;
            }
        }
        let core = EditorCore::open(MemoryBackend::new(
            InstanceIdentity {
                instance_id: uuid::Uuid::new_v4().to_string(),
                vault: Vault {
                    vault_id: identity["id"].as_str().unwrap().into(),
                    history_id: identity["historyId"].as_str().unwrap().into(),
                },
            },
            || 0,
        ))
        .await
        .unwrap();
        Self {
            core,
            session: hello["sessionId"].as_str().unwrap().into(),
            members: Value::Null,
            socket,
            sequence: HashMap::new(),
            saved: HashMap::new(),
            request: 0,
            operation: 0,
            read_only: descriptor["readOnly"].as_bool().unwrap(),
        }
    }
    pub async fn request(&mut self, method: &str, params: Value) -> Value {
        self.request += 1;
        let mut value = params;
        value["method"] = json!(method);
        value["requestId"] = json!(self.request);
        value["sessionId"] = json!(self.session);
        self.socket
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
        loop {
            let frame = next(&mut self.socket).await;
            if frame["kind"] == "reply" && frame["requestId"] == self.request {
                return frame;
            }
            self.accept(frame).await;
        }
    }
    pub async fn ok(&mut self, method: &str, params: Value) -> Value {
        let reply = self.request(method, params).await;
        assert!(reply["error"].is_null(), "{reply}");
        reply["result"].clone()
    }
    pub async fn open(&mut self, path: &str) -> String {
        let receipt = self.ok("open", json!({"path":path})).await;
        let id = receipt["document"]["id"].as_str().unwrap().to_string();
        self.accept(receipt).await;
        id
    }
    pub async fn sync(&mut self, id: &str) {
        let receipt = self.ok("open", json!({"id":id})).await;
        self.accept(receipt).await;
    }
    pub async fn accept(&mut self, frame: Value) {
        if frame["kind"] == "members" {
            self.members = frame["state"].clone();
            return;
        }
        if frame["kind"] != "document" {
            return;
        }
        let host = &frame["document"];
        let id = host["id"].as_str().unwrap().to_string();
        let sequence = frame["sequence"].as_u64().unwrap();
        if sequence <= self.sequence.get(&id).copied().unwrap_or(0) {
            return;
        }
        let packet: HistoryPacket = serde_json::from_value(frame["packet"].clone()).unwrap();
        if let Some(saved) = host["savedContent"].as_str() {
            self.saved.insert(id.clone(), saved.into());
        }
        let state = ReplicaHostState {
            path: host["path"].as_str().unwrap().into(),
            version: serde_json::from_value(host["version"].clone()).unwrap(),
            saved_content: self.saved.get(&id).expect("initial saved content").clone(),
            file_revision: host["backendRevision"].as_str().unwrap().into(),
            bom: host["bom"].as_bool().unwrap(),
            line_ending: host["lineEnding"].as_str().unwrap().into(),
            deleted: host["deleted"].as_bool().unwrap(),
            conflict: host["conflict"].as_bool().unwrap(),
            error: host["error"].as_str().map(str::to_owned),
            external_change: serde_json::from_value(host["externalChange"].clone()).unwrap(),
            read_only: self.read_only,
        };
        if self.core.read(&id).is_ok() {
            assert_eq!(
                self.core.peer_id(&id).unwrap(),
                frame["writerId"].as_str().unwrap().parse::<u64>().unwrap()
            );
            self.core.import(&id, packet).await.unwrap();
            self.core.apply_host_state(&id, state).await.unwrap();
        } else {
            self.core
                .join_replica_document(ReplicaDocument {
                    packets: vec![packet],
                    peer_id: Some(frame["writerId"].as_str().unwrap().parse().unwrap()),
                    state,
                })
                .await
                .unwrap();
        }
        self.core.take_mutations();
        self.sequence.insert(id, sequence);
    }
    pub async fn publish(
        &mut self,
        id: &str,
        mutation: std::sync::Arc<EditorMutation>,
    ) -> EditorDocument {
        mutation.require_committed().unwrap();
        if let Some(packet) = &mutation.update.operation {
            self.operation += 1;
            let receipt = self.ok("updates", json!({"id":id,"packet":packet,"version":mutation.update.after,"operation":self.operation})).await;
            let version: Version = serde_json::from_value(receipt["version"].clone()).unwrap();
            assert!(version.contains(&mutation.update.after));
        }
        self.core.take_mutations();
        self.core.read(id).unwrap()
    }
    pub async fn edit(&mut self, id: &str, from: usize, to: usize, insert: &str) -> EditorDocument {
        let mutation = self.core.edit(id, [(from..to, insert)]).await.unwrap();
        self.publish(id, mutation).await
    }
    pub async fn replace(&mut self, id: &str, text: &str) -> EditorDocument {
        let mutation = self.core.replace_text(id, text).await.unwrap();
        self.publish(id, mutation).await
    }
    pub async fn undo(&mut self, id: &str, redo: bool) -> EditorDocument {
        let mutation = if redo {
            self.core.redo(id).await.unwrap()
        } else {
            self.core.undo(id).await.unwrap()
        };
        self.publish(id, mutation).await
    }
    pub async fn next_members(&mut self, predicate: impl Fn(&Value) -> bool) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let frame = next(&mut self.socket).await;
                self.accept(frame).await;
                if predicate(&self.members) {
                    return self.members.clone();
                }
            }
        })
        .await
        .unwrap()
    }
    pub async fn close(mut self) {
        self.socket.close(None).await.unwrap();
    }
}
pub async fn send(socket: &mut Socket, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}
pub async fn next(socket: &mut Socket) -> Value {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if let Message::Text(text) = socket.next().await.expect("live socket").unwrap() {
                return serde_json::from_str(&text).unwrap();
            }
        }
    })
    .await
    .unwrap()
}
