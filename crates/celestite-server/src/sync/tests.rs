use super::*;
use crate::{
    collaboration::CollaborationState,
    shares::{Grant, Permission},
    vault::documents::Documents,
};
use celestite_core::{Affinity, Buffer, BufferCommand, Edit, SyncPacket, TextEdit};

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
    let packet: SyncPacket = serde_json::from_value(receipt["packet"].clone()).unwrap();
    let id = receipt["document"]["id"].as_str().unwrap();
    let mut replica = Buffer::from_snapshot(
        &packet,
        Some(receipt["writerId"].as_str().unwrap().parse().unwrap()),
    )
    .unwrap();
    let selection = json!({"version": replica.version(), "mainIndex": 0, "ranges": [{"anchor": replica.anchor_at(1, Affinity::After).unwrap(), "head": replica.anchor_at(4, Affinity::Before).unwrap()}]});
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
    assert_eq!(
        request(&host, &session, &readonly, invalid)
            .await
            .unwrap_err()
            .0
            .code,
        "InvalidEdit"
    );
    let mut future = view.clone();
    future["selection"]["version"]["clocks"][replica.writer_id()] = json!(100);
    assert_eq!(
        request(&host, &session, &readonly, future)
            .await
            .unwrap_err()
            .0
            .code,
        "StaleVersion"
    );
    let mut foreign = view.clone();
    foreign["selection"]["ranges"][0]["anchor"]["identity"]["history_id"] = json!("other");
    assert!(request(&host, &session, &readonly, foreign).await.is_err());
    let mut oversized = view.clone();
    oversized["selection"]["ranges"] = json!(vec![selection["ranges"][0].clone(); 17]);
    assert_eq!(
        request(&host, &session, &readonly, oversized)
            .await
            .unwrap_err()
            .0
            .code,
        "InvalidEdit"
    );

    let update = replica
        .apply(BufferCommand::Edit(Edit::new(
            replica.version(),
            vec![TextEdit {
                from: 0,
                to: 0,
                insert: "前".into(),
            }],
        )))
        .unwrap();
    assert_eq!(request(&host, &session, &readonly, json!({"method":"updates","id":id,"packet":update.operation,"version":update.after,"operation":1})).await.unwrap_err().0.code, "PermissionDenied");
    request(&host, &session, &edit, json!({"method":"updates","id":id,"packet":update.operation,"version":update.after,"operation":1})).await.unwrap();
    // A stored selection survives concurrent insertion through CRDT identity.
    let anchor = serde_json::from_value(selection["ranges"][0]["anchor"].clone()).unwrap();
    assert_eq!(replica.resolve_anchor(&anchor).unwrap().offset, 2);
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
            .text,
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
