//! One online session per VaultInstance. Requests, snapshots and invalidations
//! all serialize through the host core. A receipt acknowledges committed CRDT
//! history; saving the ordinary file is a separate command.
use crate::{
    editor_api::{run_documents, run_documents_with_tree},
    get_vault,
    vault::{
        changes::Subscription, documents::DocumentState, fs::VaultError, store::VaultIdentity,
    },
    Access, ApiError, HostedVault, ServerState,
};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    response::Response,
    routing::get,
    Extension, Router,
};
use celestite_core::{SyncPacket, Version};
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
    Router::new().route("/api/v1/vaults/{id}/sync", get(upgrade))
}
async fn upgrade(
    State(state): State<Arc<ServerState>>,
    Path(id): Path<String>,
    Extension(access): Extension<Access>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let vault = get_vault(&state, &id)?;
    let shutdown = state.shutdown.subscribe();
    Ok(ws
        .max_message_size(80 * 1024 * 1024)
        .max_frame_size(80 * 1024 * 1024)
        .on_upgrade(move |socket| serve(socket, vault, access, shutdown)))
}
pub(crate) fn contains(current: &Version, checkpoint: &Version) -> bool {
    current.identity == checkpoint.identity
        && checkpoint.clocks.iter().all(|(peer, clock)| {
            *clock >= 0 && current.clocks.get(peer).copied().unwrap_or(0) >= *clock
        })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Hello {
    protocol_version: u32,
    token: Option<String>,
    vault_identity: VaultIdentity,
}
#[derive(Clone, Deserialize)]
#[serde(
    tag = "method",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Command {
    Open {
        path: String,
    },
    Updates {
        id: String,
        packet: SyncPacket,
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
struct SessionState {
    id: String,
    writers: HashMap<String, String>,
    sent: HashMap<String, Version>,
    next_operation: u64,
    sequence: u64,
    saved: HashMap<String, String>,
    receipts: VecDeque<(u64, blake3::Hash, Value)>,
    alive: Arc<AtomicBool>,
}
impl SessionState {
    fn new() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            writers: HashMap::new(),
            sent: HashMap::new(),
            next_operation: 1,
            sequence: 0,
            saved: HashMap::new(),
            receipts: VecDeque::new(),
            alive: Arc::new(AtomicBool::new(true)),
        }
    }
    fn receipt(
        &mut self,
        docs: &mut crate::vault::documents::Documents,
        state: DocumentState,
    ) -> crate::vault::fs::Result<Value> {
        let id = &state.id;
        let packet = match self.sent.get(id) {
            Some(version) => docs.updates(id, version)?,
            None => docs.snapshot(id)?,
        };
        let writer = match self.writers.get(id) {
            Some(writer) => writer.clone(),
            None => {
                let writer = docs.allocate_writer(id)?;
                self.writers.insert(id.clone(), writer.clone());
                writer
            }
        };
        self.sent.insert(id.clone(), state.snapshot.version.clone());
        self.sequence += 1;
        let previous = self
            .saved
            .insert(id.clone(), state.backend_revision.clone());
        let mut metadata = serde_json::to_value(&state).expect("state serializes");
        metadata["snapshot"].as_object_mut().unwrap().remove("text");
        if previous.as_ref() == Some(&state.backend_revision) {
            metadata.as_object_mut().unwrap().remove("savedContent");
        }
        Ok(
            json!({"kind":"document","sequence":self.sequence,"document":metadata,"packet":packet,"writerId":writer}),
        )
    }
}
async fn collect(
    vault: Arc<HostedVault>,
    session: Session,
) -> Result<(Vec<Value>, Subscription), ApiError> {
    run_documents(vault, false, move |_, docs| {
        let mut session = session
            .lock()
            .map_err(|_| VaultError::new("IO", "Session lock failed", ""))?;
        let states = docs.resident()?;
        let frames = states
            .into_iter()
            .map(|state| session.receipt(docs, state))
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
) -> Result<Value, ApiError> {
    let mutation = matches!(
        request.command,
        Command::Updates { .. } | Command::Save { .. }
    );
    let notify_tree = matches!(request.command, Command::Open { .. } | Command::Save { .. });
    run_documents_with_tree(vault,mutation,notify_tree,move |files,docs| {
        let mut session = session.lock().map_err(|_|VaultError::new("IO","Session lock failed",""))?;
        if !session.alive.load(Ordering::Acquire) || request.session_id != session.id {
            return Err(VaultError::new("Closed","Session expired", ""));
        }
        let value = match request.command {
            Command::Ping => json!({"pong":true}),
            Command::Open{path} => { let id=docs.open_file(files,&path)?; session.sent.remove(&id); session.saved.remove(&id); session.receipt(docs,docs.state(files,&id)?)? }
            Command::Probe{id,version} => { let state=docs.state(files,&id)?; docs.snapshot(&id)?; json!({"committed":contains(&state.snapshot.version,&version),"version":state.snapshot.version}) }
            Command::Save{id,version} => {
                docs.refresh(files,&id)?;
                docs.save(files,&id,version)?;
                session.sent.remove(&id);
                session.saved.remove(&id);
                session.receipt(docs,docs.state(files,&id)?)?
            }
            Command::Updates{id,packet,version,operation} => {
                let digest=blake3::hash(&serde_json::to_vec(&json!([id,packet,version])).expect("packet serializes"));
                if operation < session.next_operation {
                    let old=session.receipts.iter().find(|(number,_,_)| *number==operation).ok_or_else(||VaultError::new("InvalidEdit","Receipt expired; probe the causal checkpoint",&id))?;
                    if digest != old.1 { return Err(VaultError::new("InvalidEdit","Operation replay payload differs",&id)); }
                    old.2.clone()
                } else {
                    if operation != session.next_operation {return Err(VaultError::new("InvalidEdit","Operation sequence is discontinuous",&id));}
                    let writer=session.writers.get(&id).ok_or_else(||VaultError::new("InvalidEdit","Document not subscribed in this session",&id))?;
                    docs.import_session(&id,packet,writer,&version)?;
                    let state=docs.state(files,&id)?;
                    let ack=json!({"operation":operation,"version":state.snapshot.version});
                    tracing::debug!(document_id=%id, session_id=%session.id, writer_id=%writer, operation, "Committed session CRDT update");
                    session.next_operation+=1;
                    session.receipts.push_back((operation,digest,ack.clone()));
                    if session.receipts.len()>256 { session.receipts.pop_front(); }
                    ack
                }
            }
        };
        Ok(value)
    }).await
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
    access: Access,
    mut shutdown: watch::Receiver<bool>,
) {
    let hello = tokio::time::timeout(Duration::from_secs(5), socket.recv()).await;
    let parsed = match hello {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<Hello>(&text).ok(),
        _ => None,
    };
    let Some(hello) = parsed else { return };
    if hello.protocol_version != 1
        || access
            .token
            .as_ref()
            .is_some_and(|token| hello.token.as_ref() != Some(token))
    {
        let _=socket.send(Message::Text(json!({"kind":"fatal","code":"PermissionDenied","message":"Invalid handshake or authentication"}).to_string().into())).await;
        return;
    }
    let identity =
        match run_documents(vault.clone(), false, |_, docs| Ok(docs.identity.clone())).await {
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
    let outcome=async {
        send(&mut sink,json!({"kind":"hello","sessionId":session_id,"vaultIdentity":identity})).await?;
        let initial = run_documents(vault.clone(), false, |_, docs| docs.subscribe()).await.map_err(|_|())?;
        for notice in initial.initial.documents {
            let shared = session.clone();
            let frame = run_documents(vault.clone(), false, move |files, docs| {
                let mut session = shared.lock().map_err(|_|VaultError::new("IO","Session lock failed",""))?;
                session.receipt(docs, docs.state(files, &notice.id)?)
            }).await.map_err(|_|())?;
            // Never build an entire Vault's initial JSON snapshots in memory.
            send(&mut sink, frame).await?;
        }
        // Re-establish the barrier after sending the potentially large initial
        // snapshot. Changes during that transfer are exported as deltas.
        let (frames,subscription)=collect(vault.clone(),session.clone()).await.map_err(|_|())?;
        for frame in frames {send(&mut sink,frame).await?;}
        let mut feed=subscription.receiver;
        send(&mut sink,json!({"kind":"ready","sessionId":session_id})).await?;
        let mut heartbeat=tokio::time::interval(Duration::from_secs(10));
        loop {
            if !alive.load(Ordering::Acquire) || *shutdown.borrow(){break;}
            tokio::select! {
                _=shutdown.changed()=>break,
                _=heartbeat.tick()=>{send(&mut sink,json!({"kind":"heartbeat"})).await?;},
                request=rx.recv()=>{
                    let Some(request)=request else {break};
                    let request_id=request.request_id;
                    match command(vault.clone(),session.clone(),request).await {
                        Ok(value)=>{send(&mut sink,json!({"kind":"reply","requestId":request_id,"result":value})).await?;},
                        Err(error)=>{send(&mut sink,json!({"kind":"reply","requestId":request_id,"error":error.0})).await?;}
                    }
                }
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
                            let result=run_documents(vault.clone(),false,move |files,docs|{
                                let mut next=next.lock().map_err(|_|VaultError::new("IO","Session lock failed",""))?;
                                let mut frames=vec![];
                                for id in ids {frames.push(next.receipt(docs,docs.state(files,&id)?)?);}
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
        Ok::<(),()>(())
    }.await;
    alive.store(false, Ordering::Release);
    reader.abort();
    let _ = sink.close().await;
    tracing::debug!(vault_id=%vault.id,session_id=%session_id,success=outcome.is_ok(),"WebSocket session ended");
}
