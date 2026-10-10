use celestite_buffer::{
    Buffer,
    types::{BufferError, DocumentIdentity, TextSnapshot},
};

fn identity() -> DocumentIdentity {
    DocumentIdentity {
        document_id: "doc".into(),
        history_id: "history".into(),
    }
}

#[test]
fn snapshot_outputs_state_revision_and_accepts_legacy_revision() {
    let mut buffer = Buffer::with_peer_id(identity(), 1, "hello").unwrap();
    let initial = buffer.snapshot();
    let _ = buffer.edit([(0..0, "!")]).unwrap();
    let snapshot = buffer.snapshot();
    assert!(snapshot.state_revision > initial.state_revision);
    let mut json = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(json["stateRevision"], snapshot.state_revision);
    assert!(json.get("revision").is_none());
    assert!(json.get("state_revision").is_none());
    assert_eq!(
        serde_json::from_value::<TextSnapshot>(json.clone()).unwrap(),
        snapshot
    );
    let revision = json
        .as_object_mut()
        .unwrap()
        .remove("stateRevision")
        .unwrap();
    json.as_object_mut()
        .unwrap()
        .insert("revision".into(), revision);
    assert_eq!(
        serde_json::from_value::<TextSnapshot>(json).unwrap(),
        snapshot
    );

    // Clearing personal undo changes local state without changing causal history.
    let _ = buffer.clear_undo().unwrap();
    let cleared = buffer.snapshot();
    assert_eq!(cleared.version, snapshot.version);
    assert!(cleared.state_revision > snapshot.state_revision);
}

#[test]
fn history_packet_keeps_the_existing_envelope_and_kind_values() {
    let buffer = Buffer::with_peer_id(identity(), 1, "hello").unwrap();
    for (packet, kind) in [
        (buffer.export_snapshot().unwrap(), "snapshot"),
        (
            buffer.export_updates_since(&buffer.version()).unwrap(),
            "updates",
        ),
    ] {
        assert_eq!(
            serde_json::to_value(&packet).unwrap(),
            serde_json::json!({
                "identity": identity(),
                "kind": kind,
                "data": packet.data.as_ref(),
            })
        );
    }
}

#[test]
fn peer_errors_preserve_legacy_codes_and_precise_peer_strings() {
    for peer_id in [9_007_199_254_740_993, u64::MAX - 1] {
        let buffer = Buffer::with_peer_id(identity(), peer_id, "hello").unwrap();
        let error =
            match Buffer::from_snapshot_with_peer_id(&buffer.export_snapshot().unwrap(), peer_id) {
                Ok(_) => panic!("a peer with existing operations must be rejected"),
                Err(error) => error,
            };
        assert!(matches!(error, BufferError::PeerIdAlreadyUsed { peer_id: id } if id == peer_id));
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({"code": "writer_already_used", "peer": peer_id.to_string()})
        );
        assert!(error.to_string().contains(&format!("peer {peer_id}")));
    }
    assert_eq!(
        serde_json::to_value(BufferError::PeerIdCollision).unwrap(),
        serde_json::json!({"code": "writer_collision"})
    );
}
