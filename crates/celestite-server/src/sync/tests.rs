use super::{command, DocumentSession, Session, SessionState};
use crate::{
    collaboration::CollaborationState,
    shares::{Grant, Permission},
    vault::documents::Documents,
    ApiError, HostedVault,
};
use celestite_buffer::{
    types::{Affinity, Anchor, HistoryPacket},
    Buffer,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

fn vault(root: &std::path::Path) -> Arc<HostedVault> {
    let documents = Documents::open(root, &[0; 32]).unwrap();
    let (events, _) = tokio::sync::broadcast::channel(128);
    let (trigger, _) = crate::reconcile::channel();
    Arc::new(HostedVault {
        id: documents.identity.id.clone(),
        name: "Notes".into(),
        read_only: false,
        files: Mutex::new(documents.files.clone()),
        documents: Mutex::new(documents),
        collaboration: CollaborationState::new(),
        packages: crate::package_resources::PackageResources::new(root.into(), events.clone())
            .unwrap(),
        events,
        _watcher: Mutex::new(
            notify::recommended_watcher(|_: notify::Result<notify::Event>| {}).unwrap(),
        ),
        reconcile_trigger: trigger,
        reconciler: Mutex::new(None),
    })
}
async fn request(
    vault: &Arc<HostedVault>,
    session: &Session,
    grant: &Arc<Grant>,
    payload: Value,
) -> Result<Value, ApiError> {
    let id = session.lock().unwrap().id.clone();
    let mut payload = payload;
    payload["sessionId"] = json!(id);
    payload["requestId"] = json!(1);
    command(
        vault.clone(),
        session.clone(),
        serde_json::from_value(payload).unwrap(),
        grant.clone(),
    )
    .await
}

#[test]
fn v3_document_receipt_keeps_peer_precision_and_host_metadata() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "A😀B").unwrap();
    let mut documents = Documents::open(root.path(), &[0; 32]).unwrap();
    let id = documents.open_file("a.md").unwrap();
    let mut session = SessionState::new();
    session.documents.insert(
        id.clone(),
        DocumentSession {
            peer_id: u64::MAX - 1,
            subscribed: true,
            sent: None,
            saved: None,
        },
    );
    let expected_packet = documents.snapshot(&id).unwrap();
    let expected_host = documents.host_document(&id, None).unwrap();
    let receipt = session.receipt(&mut documents, &id).unwrap();
    assert_eq!(receipt["writerId"], "18446744073709551614");
    assert!(receipt.get("peerId").is_none());
    assert_eq!(receipt["packet"], json!(expected_packet));
    assert_eq!(
        receipt["document"],
        crate::wire::host_document(&expected_host)
    );
    let metadata = &receipt["document"];
    assert!(metadata.get("durableVersion").is_some());
    assert!(metadata.get("backendRevision").is_some());
    for key in ["peerId", "persistedVersion", "fileRevision"] {
        assert!(metadata.get(key).is_none());
    }
    assert_eq!(metadata["savedContent"], "A😀B");
    let next = session.receipt(&mut documents, &id).unwrap();
    assert!(next["document"].get("savedContent").is_none());
    assert_eq!(next["writerId"], receipt["writerId"]);
    assert_eq!(session.documents[&id].peer_id, u64::MAX - 1);
}

#[tokio::test]
async fn presence_uses_real_anchors_and_causal_admission_without_editing_or_saving() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "A😀BC").unwrap();
    let host = vault(root.path());
    let session = Arc::new(Mutex::new(SessionState::new()));
    let session_id = session.lock().unwrap().id.clone();
    host.collaboration.join(&session_id, true);
    let readonly = Arc::new(Grant {
        id: "reader".into(),
        permission: Permission::Readonly,
        vault: host.clone(),
    });
    let edit = Arc::new(Grant {
        id: "editor".into(),
        permission: Permission::Edit,
        vault: host.clone(),
    });
    let receipt = request(
        &host,
        &session,
        &readonly,
        json!({"method":"open", "path":"a.md"}),
    )
    .await
    .unwrap();
    let packet: HistoryPacket = serde_json::from_value(receipt["packet"].clone()).unwrap();
    let id = receipt["document"]["id"].as_str().unwrap();
    let mut replica = Buffer::from_snapshot_with_peer_id(
        &packet,
        receipt["writerId"].as_str().unwrap().parse().unwrap(),
    )
    .unwrap();
    let selection = json!({"version": replica.version(), "mainIndex": 0, "ranges": [{"anchor": replica.anchor_at(1, Affinity::After).unwrap(), "head": replica.anchor_at(6, Affinity::Before).unwrap()}]});
    let view = json!({"method":"set_view", "viewId":"one", "documentId":id, "focused":true, "selection":selection});
    let before = host.documents.lock().unwrap().state(id).unwrap();
    request(&host, &session, &readonly, view.clone())
        .await
        .unwrap();
    let members = host.collaboration.subscribe();
    let snapshot = serde_json::to_value(members.borrow().clone()).unwrap();
    assert_eq!(snapshot["members"][0]["views"][0]["selection"], selection);
    assert_eq!(snapshot["members"][0]["readOnly"], true);
    assert!(snapshot["members"][0]["name"]
        .as_str()
        .unwrap()
        .starts_with("访客 "));
    let sequence = snapshot["sequence"].clone();
    request(&host, &session, &readonly, view.clone())
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(members.borrow().clone()).unwrap()["sequence"],
        sequence
    );
    let after = host.documents.lock().unwrap().state(id).unwrap();
    assert_eq!(before.snapshot, after.snapshot);
    assert_eq!(before.undo, after.undo);
    assert_eq!(
        std::fs::read_to_string(root.path().join("a.md")).unwrap(),
        "A😀BC"
    );

    let mut invalid = view.clone();
    invalid["selection"]["mainIndex"] = json!(1);
    let mut future = view.clone();
    future["selection"]["version"]["clocks"][replica.peer_id().to_string()] = json!(100);
    let mut foreign = view.clone();
    foreign["selection"]["ranges"][0]["anchor"]["identity"]["history_id"] = json!("other");
    assert!(request(&host, &session, &readonly, foreign).await.is_err());
    let mut oversized = view.clone();
    oversized["selection"]["ranges"] = json!(vec![selection["ranges"][0].clone(); 17]);
    for (label, payload, code) in [
        ("main index", invalid, "InvalidEdit"),
        ("future version", future, "StaleVersion"),
        ("range limit", oversized, "InvalidEdit"),
    ] {
        assert_eq!(
            request(&host, &session, &readonly, payload)
                .await
                .unwrap_err()
                .0
                .code,
            code,
            "{label}"
        );
    }

    let update = replica.edit([(0..0, "前")]).unwrap();
    assert_eq!(request(&host, &session, &readonly, json!({"method":"updates","id":id,"packet":update.operation,"version":update.after,"operation":1})).await.unwrap_err().0.code, "PermissionDenied");
    request(&host, &session, &edit, json!({"method":"updates","id":id,"packet":update.operation,"version":update.after,"operation":1})).await.unwrap();
    // A stored selection survives concurrent insertion through CRDT identity.
    let anchor: Anchor = serde_json::from_value(selection["ranges"][0]["anchor"].clone()).unwrap();
    assert_eq!(anchor.to_offset(&replica).unwrap(), 4);
    request(&host, &session, &readonly, view).await.unwrap();
    request(
        &host,
        &session,
        &readonly,
        json!({"method":"set_view","viewId":"two","documentId":id,"focused":true}),
    )
    .await
    .unwrap();
    let current = serde_json::to_value(members.borrow().clone()).unwrap();
    assert_eq!(
        current["members"][0]["views"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|view| view["focused"] == true)
            .count(),
        1
    );
    request(
        &host,
        &session,
        &readonly,
        json!({"method":"unsubscribe","id":id}),
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(members.borrow().clone()).unwrap()["members"][0]["views"],
        json!([])
    );
    assert_eq!(
        host.documents
            .lock()
            .unwrap()
            .state(id)
            .unwrap()
            .snapshot
            .text
            .as_ref(),
        "前A😀BC"
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("a.md")).unwrap(),
        "A😀BC"
    );
    host.collaboration.leave(&session_id);
    assert_eq!(
        serde_json::to_value(members.borrow().clone()).unwrap()["members"],
        json!([])
    );
}
