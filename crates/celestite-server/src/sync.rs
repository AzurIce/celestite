//! One online session per connection. Opening a buffer subscribes that session
//! to its history. A receipt acknowledges in-memory CRDT acceptance; saving the
//! ordinary file is a separate command.
#[cfg(test)]
mod tests;
use crate::{
    vault::runtime::{execute, execute_with_tree},
    vault::{changes::Subscription, fs::VaultError, VaultIdentity},
    ApiError, HostedVault, RemoteAccess, ServerState,
};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
    routing::get,
    Extension, Router,
};
use celestite_buffer::types::{HistoryPacket, Version};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::{mpsc, watch};

pub(crate) fn routes() -> Router<Arc<ServerState>> {
    Router::new().route("/{id}/api/v1/sync", get(upgrade))
}
async fn upgrade(
    State(state): State<Arc<ServerState>>,
    Extension(access): Extension<RemoteAccess>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let vault = access.grant.vault.clone();
    let shutdown = state.shutdown.subscribe();
    Ok(ws
        .max_message_size(80 * 1024 * 1024)
        .max_frame_size(80 * 1024 * 1024)
        .on_upgrade(move |socket| serve(socket, vault, access, shutdown)))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Hello {
    protocol_version: u32,
    vault_identity: VaultIdentity,
}
#[derive(Clone, Deserialize)]
#[serde(
    tag = "method",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Command {
    Unsubscribe {
        id: String,
    },
    SetView {
        view_id: String,
        document_id: Option<String>,
        focused: bool,
        selection: Option<crate::collaboration::PresenceSelection>,
    },
    Open {
        path: Option<String>,
        id: Option<String>,
    },
    Updates {
        id: String,
        packet: HistoryPacket,
        version: Version,
        operation: u64,
    },
    Save {
        id: String,
        version: Version,
    },
    Probe {
        id: String,
        version: Version,
    },
    RetryObservation {
        id: String,
    },
    Ping,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    session_id: String,
    request_id: u64,
    #[serde(flatten)]
    command: Command,
}
type Session = Arc<Mutex<SessionState>>;
struct DocumentSession {
    peer_id: u64,
    subscribed: bool,
    sent: Option<Version>,
    saved: Option<String>,
}
struct SessionState {
    id: String,
    documents: HashMap<String, DocumentSession>,
    next_operation: u64,
    sequence: u64,
    receipts: VecDeque<(u64, blake3::Hash, Value)>,
    alive: Arc<AtomicBool>,
}
impl SessionState {
    fn new() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            documents: HashMap::new(),
            next_operation: 1,
            sequence: 0,
            receipts: VecDeque::new(),
            alive: Arc::new(AtomicBool::new(true)),
        }
    }
    fn subscriptions(&self) -> Vec<String> {
        let mut ids: Vec<_> = self
            .documents
            .iter()
            .filter(|(_, state)| state.subscribed)
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }
    fn subscribed(&self, id: &str) -> bool {
        self.documents.get(id).is_some_and(|state| state.subscribed)
    }
    fn receipt(
        &mut self,
        docs: &mut crate::vault::documents::Documents,
        id: &str,
    ) -> crate::vault::fs::Result<Value> {
        if !self.documents.contains_key(id) {
            self.documents.insert(
                id.into(),
                DocumentSession {
                    peer_id: docs.allocate_peer_id(id)?,
                    subscribed: true,
                    sent: None,
                    saved: None,
                },
            );
        }
        let document = self.documents.get_mut(id).unwrap();
        let packet = match &document.sent {
            Some(version) => docs.updates(id, version)?,
            None => docs.snapshot(id)?,
        };
        let state = docs.host_document(id, document.saved.as_deref())?;
        document.subscribed = true;
        document.sent = Some(state.status.version.clone());
        document.saved = Some(state.status.file_revision.clone());
        self.sequence += 1;
        Ok(
            json!({"kind":"document","sequence":self.sequence,"document":crate::wire::host_document(&state),"packet":packet,"writerId":document.peer_id.to_string()}),
        )
    }
    fn reset_receipt(&mut self, id: &str) {
        if let Some(document) = self.documents.get_mut(id) {
            document.sent = None;
            document.saved = None;
        }
    }
}
struct Membership {
    vault: Arc<HostedVault>,
    id: String,
}
impl Drop for Membership {
    fn drop(&mut self) {
        self.vault.collaboration.leave(&self.id);
    }
}

async fn collect(
    vault: Arc<HostedVault>,
    session: Session,
) -> Result<(Vec<Value>, Subscription), ApiError> {
    execute(vault, false, move |_, docs| {
        let mut session = session
            .lock()
            .map_err(|_| VaultError::new("IO", "Session lock failed", ""))?;
        let ids = session.subscriptions();
        let frames = ids
            .into_iter()
            .map(|id| session.receipt(docs, &id))
            .collect::<crate::vault::fs::Result<Vec<_>>>()?;
        // Subscription and all snapshot versions are established in the same
        // serial boundary. New changes queue while frames are transmitted.
        let subscription = docs.subscribe()?;
        Ok((frames, subscription))
    })
    .await
}
async fn command(
    vault: Arc<HostedVault>,
    session: Session,
    request: Request,
    grant: Arc<crate::shares::Grant>,
) -> Result<Value, ApiError> {
    use crate::shares::Operation;
    let operation = match &request.command {
        Command::Updates { .. } | Command::Save { .. } | Command::RetryObservation { .. } => {
            Operation::Edit
        }
        Command::Open { .. }
        | Command::Probe { .. }
        | Command::Ping
        | Command::Unsubscribe { .. }
        | Command::SetView { .. } => Operation::Read,
    };
    grant.check(operation)?;
    if let Command::SetView {
        document_id,
        selection: Some(selection),
        ..
    } = &request.command
    {
        let id = document_id
            .as_ref()
            .ok_or_else(|| VaultError::new("InvalidEdit", "Selection requires a document", ""))?;
        {
            let state = session
                .lock()
                .map_err(|_| VaultError::new("IO", "Session lock failed", ""))?;
            if request.session_id != state.id
                || !state.alive.load(Ordering::Acquire)
                || !state.subscribed(id)
            {
                return Err(VaultError::new(
                    "InvalidEdit",
                    "Selection requires a live document subscription",
                    id,
                )
                .into());
            }
        }
        if selection.ranges.is_empty()
            || selection.ranges.len() > 16
            || selection.main_index >= selection.ranges.len()
            || serde_json::to_vec(selection).map_or(true, |data| data.len() > 32 * 1024)
        {
            return Err(
                VaultError::new("InvalidEdit", "Selection exceeds presence limits", id).into(),
            );
        }
        let id = id.clone();
        let selection = selection.clone();
        execute_with_tree(vault.clone(), false, false, move |_, docs| {
            let anchors: Vec<_> = selection
                .ranges
                .into_iter()
                .flat_map(|r| [r.anchor, r.head])
                .collect();
            docs.validate_presence(&id, &selection.version, &anchors)
        })
        .await?;
    }
    // Membership and heartbeat never acquire the text/IO execution boundary.
    if matches!(
        request.command,
        Command::Ping | Command::Unsubscribe { .. } | Command::SetView { .. }
    ) {
        let mut state = session
            .lock()
            .map_err(|_| VaultError::new("IO", "Session lock failed", ""))?;
        if !state.alive.load(Ordering::Acquire) || request.session_id != state.id {
            return Err(VaultError::new("Closed", "Session expired", "").into());
        }
        match request.command {
            Command::Ping => return Ok(json!({"pong":true})),
            Command::Unsubscribe { id } => {
                if let Some(document) = state.documents.get_mut(&id) {
                    document.subscribed = false;
                    document.sent = None;
                    document.saved = None;
                }
                vault
                    .collaboration
                    .documents(&state.id, state.subscriptions());
                return Ok(json!({"unsubscribed":true}));
            }
            Command::SetView {
                view_id,
                document_id,
                focused,
                selection,
            } => {
                if view_id.is_empty()
                    || view_id.len() > 128
                    || document_id.as_ref().is_some_and(|id| !state.subscribed(id))
                {
                    return Err(VaultError::new(
                        "InvalidEdit",
                        "View requires a subscribed document and a bounded view ID",
                        "",
                    )
                    .into());
                }
                let view = document_id.map(|document_id| crate::collaboration::MemberView {
                    view_id: view_id.clone(),
                    document_id,
                    focused,
                    selection,
                });
                if !vault.collaboration.view(&state.id, &view_id, view) {
                    return Err(VaultError::new("InvalidEdit", "Too many member views", "").into());
                }
                return Ok(json!({"updated":true}));
            }
            _ => unreachable!(),
        }
    }
    let registry_vault = vault.clone();
    let registry_session = session.clone();
    let notify_tree = matches!(request.command, Command::Open { .. } | Command::Save { .. });
    let result = execute_with_tree(
        vault,
        operation == Operation::Edit,
        notify_tree,
        move |_files, docs| {
            let mut session = session.lock()
                .map_err(|_| VaultError::new("IO", "Session lock failed", ""))?;
            if !session.alive.load(Ordering::Acquire) || request.session_id != session.id {
                return Err(VaultError::new("Closed", "Session expired", ""));
            }
            match &request.command {
                Command::Updates { id, .. } | Command::Save { id, .. }
                | Command::Probe { id, .. } | Command::RetryObservation { id } => {
                    if !session.subscribed(id) {
                        return Err(VaultError::new("InvalidEdit", "Buffer is not open in this session", id));
                    }
                }
                _ => {}
            }
            match request.command {
                Command::Ping | Command::Unsubscribe { .. } | Command::SetView { .. } => unreachable!(),
                Command::Open { path, id } => {
                    let id = match (path, id) {
                        (Some(path), None) => docs.open_file(&path)?,
                        (None, Some(id)) => {
                            docs.refresh(&id)?;
                            id
                        }
                        _ => return Err(VaultError::new("InvalidEdit", "Open requires a path or a buffer ID", "")),
                    };
                    session.reset_receipt(&id);
                    session.receipt(docs, &id)
                }
                Command::Probe { id, version } => {
                    let current = docs.committed_version(&id)?;
                    Ok(json!({"committed": current.contains(&version), "version": current}))
                }
                Command::RetryObservation { id } => {
                    docs.retry_file_observation(&id)?;
                    session.receipt(docs, &id)
                }
                Command::Save { id, version } => {
                    docs.refresh(&id)?;
                    docs.save(&id, version)?;
                    session.receipt(docs, &id)
                }
                Command::Updates { id, packet, version, operation } => {
                    let digest = blake3::hash(
                        &serde_json::to_vec(&json!([id, packet, version])).expect("packet serializes"),
                    );
                    if operation < session.next_operation {
                        let old = session.receipts.iter()
                            .find(|(number, _, _)| *number == operation)
                            .ok_or_else(|| VaultError::new("InvalidEdit", "Receipt expired; probe the causal checkpoint", &id))?;
                        if digest != old.1 {
                            return Err(VaultError::new("InvalidEdit", "Operation replay payload differs", &id));
                        }
                        return Ok(old.2.clone());
                    }
                    if operation != session.next_operation {
                        return Err(VaultError::new("InvalidEdit", "Operation sequence is discontinuous", &id));
                    }
                    let peer_id = session.documents.get(&id)
                        .ok_or_else(|| VaultError::new("InvalidEdit", "Document not subscribed in this session", &id))?.peer_id;
                    docs.import_session(&id, packet, peer_id, &version)?;
                    let version = docs.committed_version(&id)?;
                    let ack = json!({"operation": operation, "version": version});
                    tracing::debug!(document_id=%id, session_id=%session.id, peer_id=%peer_id, operation, "Committed session CRDT update");
                    session.next_operation += 1;
                    session.receipts.push_back((operation, digest, ack.clone()));
                    if session.receipts.len() > 256 {
                        session.receipts.pop_front();
                    }
                    Ok(ack)
                }
            }
        },
    ).await;
    if result.is_ok() {
        let state = registry_session
            .lock()
            .map_err(|_| VaultError::new("IO", "Session lock failed", ""))?;
        registry_vault
            .collaboration
            .documents(&state.id, state.subscriptions());
    }
    result
}
async fn send(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    value: Value,
) -> Result<(), ()> {
    tokio::time::timeout(
        Duration::from_secs(15),
        sink.send(Message::Text(value.to_string().into())),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}
async fn serve(
    mut socket: WebSocket,
    vault: Arc<HostedVault>,
    access: RemoteAccess,
    mut shutdown: watch::Receiver<bool>,
) {
    let hello = tokio::time::timeout(Duration::from_secs(5), socket.recv()).await;
    let parsed = match hello {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<Hello>(&text).ok(),
        _ => None,
    };
    let Some(hello) = parsed else { return };
    if hello.protocol_version != 3 {
        let _=socket.send(Message::Text(json!({"kind":"fatal","code":"PermissionDenied","message":"Invalid handshake or authentication"}).to_string().into())).await;
        return;
    }
    let identity = match execute(vault.clone(), false, |_, docs| Ok(docs.identity.clone())).await {
        Ok(identity) => identity,
        Err(_) => return,
    };
    if hello.vault_identity.id != identity.id
        || hello.vault_identity.history_id != identity.history_id
    {
        let _ = socket
            .send(Message::Text(
                json!({"kind":"fatal","code":"Conflict","message":"Vault history changed"})
                    .to_string()
                    .into(),
            ))
            .await;
        return;
    }
    let mut tree = vault.events.subscribe();
    let (mut sink, mut source) = socket.split();
    let session = Arc::new(Mutex::new(SessionState::new()));
    let (alive, session_id) = {
        let state = session.lock().unwrap();
        (state.alive.clone(), state.id.clone())
    };
    vault
        .collaboration
        .join(&session_id, access.grant.read_only());
    let _membership = Membership {
        vault: vault.clone(),
        id: session_id.clone(),
    };
    let mut members = vault.collaboration.subscribe();
    let (tx, mut rx) = mpsc::channel::<Request>(4);
    let reader_alive = alive.clone();
    let reader = tokio::spawn(async move {
        loop {
            match tokio::time::timeout(Duration::from_secs(45), source.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => {
                    let Ok(request) = serde_json::from_str(&text) else {
                        break;
                    };
                    if tx.try_send(request).is_err() {
                        break;
                    }
                }
                Ok(Some(Ok(Message::Pong(_)))) => {}
                _ => break,
            }
        }
        reader_alive.store(false, Ordering::Release);
    });
    let mut stopping = shutdown.clone();
    let outcome = async {
        send(
            &mut sink,
            json!({"kind":"hello","sessionId":session_id,"vaultIdentity":identity}),
        )
        .await?;
        let subscription = execute(vault.clone(), false, |_, docs| docs.subscribe())
            .await
            .map_err(|_| ())?;
        let mut feed = subscription.receiver;
        send(&mut sink, json!({"kind":"ready","sessionId":session_id})).await?;
        let initial_members = members.borrow_and_update().clone();
        send(&mut sink, json!({"kind":"members","state":initial_members})).await?;
        let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
        loop {
            if !alive.load(Ordering::Acquire) || *shutdown.borrow() {
                break;
            }
            tokio::select! {
                _=shutdown.changed()=>break,
                _=heartbeat.tick()=>{send(&mut sink,json!({"kind":"heartbeat"})).await?;},
                request=rx.recv()=>{
                    let Some(request)=request else {break};
                    let request_id=request.request_id;
                    match command(vault.clone(),session.clone(),request,access.grant.clone()).await {
                        Ok(value)=>{send(&mut sink,json!({"kind":"reply","requestId":request_id,"result":value})).await?;},
                        Err(error)=>{send(&mut sink,json!({"kind":"reply","requestId":request_id,"error":error.0})).await?;}
                    }
                }
                changed=members.changed()=>{
                    if changed.is_err() { break; }
                    let state = members.borrow_and_update().clone();
                    send(&mut sink,json!({"kind":"members","state":state})).await?;
                },
                event=tree.recv()=>{
                    if matches!(event, Err(tokio::sync::broadcast::error::RecvError::Closed)){break;}
                    send(&mut sink,json!({"kind":"tree"})).await?;
                },
                event=feed.recv()=>{
                    // Notices are invalidations; read the latest committed
                    // state, rather than trying to pair an old notice with a
                    // later snapshot. On lag, rebuild the subscription barrier.
                    match event {
                        Ok(event)=>{
                            let ids:Vec<_>=event.documents.into_iter().map(|notice|notice.id).collect();
                            let next=session.clone();
                            let result=execute(vault.clone(),false,move |_,docs|{
                                let mut next=next.lock().map_err(|_|VaultError::new("IO","Session lock failed",""))?;
                                let mut frames=vec![];
                                for id in ids {
                                    if next.subscribed(&id) {
                                        frames.push(next.receipt(docs, &id)?);
                                    }
                                }
                                Ok(frames)
                            }).await.map_err(|_|())?;
                            for frame in result {send(&mut sink,frame).await?;}
                        },
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>{
                            let (frames,subscription)=collect(vault.clone(),session.clone()).await.map_err(|_|())?;
                            feed=subscription.receiver;
                            for frame in frames {send(&mut sink,frame).await?;}
                        },
                        Err(_)=>break,
                    }
                }
            }
        }
        Ok::<(), ()>(())
    };
    let outcome = tokio::select! { result = outcome => result, _ = stopping.changed() => Err(()) };
    alive.store(false, Ordering::Release);
    reader.abort();
    let _ = sink.close().await;
    tracing::debug!(vault_identity=%vault.id,session_id=%session_id,success=outcome.is_ok(),"WebSocket session ended");
}
