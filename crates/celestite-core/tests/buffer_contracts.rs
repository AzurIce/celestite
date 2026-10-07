use celestite_core::*;
use serde_json::json;

fn identity() -> DocumentIdentity {
    DocumentIdentity {
        document_id: "notes/draft".into(),
        history_id: "history".into(),
    }
}
fn buffer(writer: u64, text: &str) -> Buffer {
    Buffer::new(identity(), Some(writer), text).unwrap()
}
fn replica(source: &Buffer, writer: u64) -> Buffer {
    Buffer::from_snapshot(&source.export_snapshot().unwrap(), Some(writer)).unwrap()
}
fn span(from: usize, to: usize, insert: &str) -> TextEdit {
    TextEdit {
        from,
        to,
        insert: insert.into(),
    }
}
fn apply(buffer: &mut Buffer, command: BufferCommand) -> BufferUpdate {
    let before = buffer.snapshot();
    let update = buffer.apply(command).unwrap();
    assert_eq!(update.before, before.version);
    assert_eq!(update.after, buffer.version());
    assert_eq!(update.before_len, before.text.encode_utf16().count());
    assert_eq!(
        update.after_len,
        buffer.snapshot().text.encode_utf16().count()
    );
    let mut replay = before.text;
    for edit in update.edits.iter().rev() {
        let from = utf16_to_byte(&replay, edit.from).unwrap();
        let to = utf16_to_byte(&replay, edit.to).unwrap();
        replay.replace_range(from..to, &edit.insert);
    }
    assert_eq!(replay, buffer.snapshot().text);
    update
}
fn edit(buffer: &mut Buffer, edits: Vec<TextEdit>) -> BufferUpdate {
    apply(
        buffer,
        BufferCommand::Edit(Edit::new(buffer.version(), edits)),
    )
}
fn grouped(buffer: &mut Buffer, edits: Vec<TextEdit>, group: &str) -> BufferUpdate {
    let mut edit = Edit::new(buffer.version(), edits);
    edit.group = Some(group.into());
    apply(buffer, BufferCommand::Edit(edit))
}
fn import(buffer: &mut Buffer, packet: SyncPacket) -> BufferUpdate {
    apply(buffer, BufferCommand::Import(Import::new(packet, "peer")))
}
fn undo(buffer: &mut Buffer) -> BufferUpdate {
    apply(
        buffer,
        BufferCommand::Undo {
            base: buffer.version(),
            context: UndoContext::default(),
        },
    )
}
fn redo(buffer: &mut Buffer) -> BufferUpdate {
    apply(
        buffer,
        BufferCommand::Redo {
            base: buffer.version(),
            context: UndoContext::default(),
        },
    )
}
fn sync(from: &Buffer, to: &mut Buffer) -> BufferUpdate {
    import(to, from.export_updates_since(&to.version()).unwrap())
}

#[test]
fn a_mutation_returns_exact_operations_and_owned_effects_without_a_host_or_queue() {
    let mut local = buffer(u64::MAX - 1, "A😀B");
    let mut peer = replica(&local, 2);
    let first = edit(&mut local, vec![span(1, 1, "中")]);
    assert!(first.changed);
    assert!(matches!(first.cause, ChangeCause::Local { .. }));
    assert_eq!(first.undo, local.undo_state());
    let first_version = first.after.clone();
    let second = edit(&mut local, vec![span(0, 0, "second ")]);
    let _ = import(&mut peer, first.local_operation().unwrap().clone());
    assert_eq!(peer.snapshot().text, "A中😀B");
    assert_eq!(peer.version(), first_version);
    let received = import(&mut peer, second.local_operation().unwrap().clone());
    assert!(
        received.local_operation().is_none(),
        "imports must not echo as local edits"
    );
    assert_eq!(peer.snapshot().text, local.snapshot().text);
    let encoded = local.version().encode().unwrap();
    assert_eq!(
        Version::decode(identity(), &encoded).unwrap(),
        local.version()
    );
    let json = serde_json::to_value(&second).unwrap();
    assert!(
        json["after"]["clocks"]
            .get((u64::MAX - 1).to_string())
            .is_some()
    );
    assert!(json["undo"]["canUndo"].as_bool().unwrap());
}

#[test]
fn rejected_and_noop_edits_do_not_change_text_history_or_grouping() {
    let mut b = buffer(1, "😀");
    let _ = grouped(&mut b, vec![span(0, 0, "A")], "gesture");
    let before = b.snapshot();
    let history = b.undo_state();
    for edits in [
        vec![span(0, 0, "bad"), span(2, 2, "split surrogate")],
        vec![span(3, 1, "bad")],
        vec![span(0, 1, "x"), span(0, 0, "y")],
    ] {
        assert!(
            b.apply(BufferCommand::Edit(Edit::new(b.version(), edits)))
                .is_err()
        );
        assert_eq!(b.snapshot(), before);
        assert_eq!(b.undo_state(), history);
    }
    let stale = BufferCommand::Edit(Edit::new(buffer(10, "wrong").version(), vec![]));
    assert!(b.apply(stale).is_err());
    let noop = edit(&mut b, vec![span(0, 1, "A")]);
    assert!(!noop.changed);
    assert!(noop.operation.is_none());
    assert_eq!(b.snapshot(), before);
    let _ = grouped(&mut b, vec![span(3, 3, "B")], "gesture");
    let _ = undo(&mut b);
    assert_eq!(
        b.snapshot().text,
        "😀",
        "rejected/no-op input must not split an undo gesture"
    );
}

#[test]
fn snapshots_are_owned_and_sharing_does_not_replace_the_local_buffer_or_undo() {
    let mut local = buffer(1, "base");
    let original = local.snapshot();
    let _ = edit(&mut local, vec![span(0, 0, "local ")]);
    let writer = local.writer_id();
    let anchor = local.anchor_at(7, Affinity::After).unwrap();
    let mut guest = replica(&local, 2);
    assert!(!guest.undo_state().can_undo);
    let operation = edit(&mut guest, vec![span(10, 10, " peer")])
        .operation
        .unwrap();
    let _ = import(&mut local, operation);
    assert_eq!(local.snapshot().text, "local base peer");
    let _ = undo(&mut local);
    assert_eq!(local.snapshot().text, "base peer");
    assert_eq!(local.resolve_anchor(&anchor).unwrap().offset, 1);
    let _ = redo(&mut local);
    assert_eq!(local.snapshot().text, "local base peer");
    assert_eq!(local.writer_id(), writer);
    assert_eq!(original.text, "base");
}

#[test]
fn collaborative_undo_preserves_remote_text_and_restores_caller_context() {
    let mut a = buffer(1, "");
    let selections = json!({"view":"code","ranges":[[0,0],[0,0]],"main":1});
    let mut input = Edit::new(a.version(), vec![span(0, 0, "abc")]);
    input.undo.metadata = Some(selections.clone());
    let _ = apply(&mut a, BufferCommand::Edit(input));
    let mut b = replica(&a, 2);
    let _ = edit(&mut b, vec![span(1, 1, "中😀")]);
    let _ = sync(&b, &mut a);
    let base = a.version();
    let undone = apply(
        &mut a,
        BufferCommand::Undo {
            base,
            context: UndoContext {
                metadata: Some(json!({"view":"rich"})),
                positions: vec![],
            },
        },
    );
    assert_eq!(a.snapshot().text, "中😀");
    assert_eq!(undone.restored.unwrap().metadata, Some(selections));
    let redone = redo(&mut a);
    assert_eq!(a.snapshot().text, "a中😀bc");
    assert_eq!(
        redone.restored.unwrap().metadata,
        Some(json!({"view":"rich"}))
    );
    let _ = sync(&a, &mut b);
    assert_eq!(a.version(), b.version());
}

#[test]
fn undo_positions_transform_replaced_ranges_and_absolute_end_cursors() {
    let mut a = buffer(1, "Hello world.");
    let mut input = Edit::new(a.version(), vec![span(6, 11, "*world*")]);
    input.undo = UndoContext {
        metadata: Some(json!({"main":1})),
        positions: vec![6, 11, 0, 5],
    };
    let _ = apply(&mut a, BufferCommand::Edit(input));
    let mut b = replica(&a, 2);
    let _ = edit(&mut b, vec![span(0, 0, "远🧠")]);
    let _ = sync(&b, &mut a);
    let base = a.version();
    let update = apply(
        &mut a,
        BufferCommand::Undo {
            base,
            context: UndoContext {
                metadata: None,
                positions: vec![9, 16, 3, 8],
            },
        },
    );
    assert_eq!(a.snapshot().text, "远🧠Hello world.");
    assert_eq!(update.restored.unwrap().positions, vec![9, 14, 0, 8]);
    assert_eq!(redo(&mut a).restored.unwrap().positions, vec![9, 16, 3, 8]);
    let before = a.snapshot();
    let mut invalid = Edit::new(a.version(), vec![span(0, 0, "bad")]);
    invalid.undo.positions = vec![2];
    assert!(a.apply(BufferCommand::Edit(invalid)).is_err());
    assert_eq!(a.snapshot(), before);

    let mut end = buffer(10, "hello");
    let mut input = Edit::new(end.version(), vec![span(0, 1, "H")]);
    input.undo.positions = vec![5];
    let _ = apply(&mut end, BufferCommand::Edit(input));
    let mut remote = replica(&end, 11);
    let _ = edit(&mut remote, vec![span(5, 5, "🧠")]);
    let _ = sync(&remote, &mut end);
    assert_eq!(undo(&mut end).restored.unwrap().positions, vec![7]);
}

#[test]
fn metadata_only_undo_and_history_clear_are_explicit_updates() {
    let mut a = buffer(1, "");
    let _ = edit(&mut a, vec![span(0, 0, "local")]);
    let mut b = replica(&a, 2);
    let _ = edit(&mut b, vec![span(0, 5, "")]);
    let _ = sync(&b, &mut a);
    let update = undo(&mut a);
    assert!(update.changed);
    assert!(update.edits.is_empty());
    assert!(!update.undo.can_undo);
    let _ = edit(&mut a, vec![span(0, 0, "next")]);
    let cleared = apply(&mut a, BufferCommand::ClearUndo);
    assert!(cleared.changed);
    assert!(cleared.operation.is_none());
    assert!(matches!(cleared.cause, ChangeCause::HistoryCleared));
    assert!(!apply(&mut a, BufferCommand::ClearUndo).changed);
}

#[test]
fn group_ids_merge_only_consecutive_local_edits_and_imports_break_the_group() {
    let mut a = buffer(1, "");
    let _ = grouped(&mut a, vec![span(0, 0, "n")], "ime");
    let _ = grouped(&mut a, vec![span(0, 1, "你")], "ime");
    let _ = grouped(&mut a, vec![span(1, 1, "好")], "ime");
    let _ = undo(&mut a);
    assert_eq!(a.snapshot().text, "");
    let _ = redo(&mut a);
    let mut b = replica(&a, 2);
    let _ = grouped(&mut a, vec![span(2, 2, "A")], "next");
    let _ = edit(&mut b, vec![span(0, 0, "远")]);
    let _ = sync(&b, &mut a);
    let _ = grouped(&mut a, vec![span(4, 4, "B")], "next");
    let _ = undo(&mut a);
    assert_eq!(a.snapshot().text, "远你好A");
    let _ = undo(&mut a);
    assert_eq!(a.snapshot().text, "远你好");
}

#[test]
fn anchors_keep_affinity_through_deletion_and_checkpoint_transfer() {
    let mut a = buffer(1, "a😀b");
    let mut b = replica(&a, 2);
    let before = a.anchor_at(3, Affinity::Before).unwrap();
    let after = a.anchor_at(3, Affinity::After).unwrap();
    let start = a.anchor_at(0, Affinity::Before).unwrap();
    let end = a.anchor_at(4, Affinity::After).unwrap();
    assert!(a.anchor_at(2, Affinity::After).is_err());
    let _ = edit(&mut b, vec![span(3, 3, "中")]);
    let _ = sync(&b, &mut a);
    assert_eq!(a.resolve_anchor(&before).unwrap().offset, 3);
    assert_eq!(a.resolve_anchor(&after).unwrap().offset, 4);
    let _ = edit(&mut a, vec![span(0, 0, "前"), span(5, 5, "后")]);
    assert_eq!(a.resolve_anchor(&start).unwrap().offset, 0);
    assert_eq!(a.resolve_anchor(&end).unwrap().offset, 7);
    let _ = edit(&mut a, vec![span(2, 6, "")]);
    assert_eq!(a.snapshot().text, "前a后");
    assert_eq!(a.resolve_anchor(&before).unwrap().offset, 2);
    let recovered = replica(&a, 3);
    let encoded: Anchor = serde_json::from_str(&serde_json::to_string(&after).unwrap()).unwrap();
    let resolved = recovered.resolve_anchor(&encoded).unwrap();
    assert_eq!(resolved.offset, 2);
    assert_eq!(
        recovered
            .resolve_anchor(&resolved.refreshed)
            .unwrap()
            .offset,
        2
    );
    let mut empty = buffer(10, "");
    let left = empty.anchor_at(0, Affinity::Before).unwrap();
    let right = empty.anchor_at(0, Affinity::After).unwrap();
    let _ = edit(&mut empty, vec![span(0, 0, "🧠")]);
    assert_eq!(empty.resolve_anchor(&left).unwrap().offset, 0);
    assert_eq!(empty.resolve_anchor(&right).unwrap().offset, 2);
}

#[test]
fn pending_imports_are_journalable_and_duplicate_packets_are_noops() {
    let mut a = buffer(1, "");
    let mut b = replica(&a, 2);
    let first = edit(&mut a, vec![span(0, 0, "A")]).operation.unwrap();
    let second = edit(&mut a, vec![span(1, 1, "中😀")]).operation.unwrap();
    let pending = import(&mut b, second.clone());
    assert!(pending.pending && pending.changed);
    assert!(pending.edits.is_empty());
    assert!(pending.operation.is_some());
    assert!(pending.local_operation().is_none());
    let before = b.snapshot();
    assert!(!import(&mut b, second).changed);
    assert_eq!(b.snapshot(), before);
    let completed = import(&mut b, first.clone());
    assert!(!completed.pending);
    assert_eq!(b.snapshot().text, "A中😀");
    assert_eq!(b.version(), a.version());
    assert!(!import(&mut b, first).changed);
    assert!(!b.undo_state().can_undo);
}

#[test]
fn preparation_includes_pending_history_and_commit_preserves_the_original_replica() {
    let base = buffer(1, "base");
    let mut sender = replica(&base, 2);
    let mut receiver = replica(&base, 3);
    let _ = edit(&mut receiver, vec![span(0, 0, "local ")]);
    let first = edit(&mut sender, vec![span(4, 4, "1")]).operation.unwrap();
    let second = edit(&mut sender, vec![span(5, 5, "2")]).operation.unwrap();
    let _ = import(&mut receiver, second);
    let before = receiver.snapshot();
    let history = receiver.undo_state();
    let writer = receiver.writer_id();
    let prepared = receiver.prepare_import(Import::new(first, "peer")).unwrap();
    assert_eq!(prepared.preview().text, "local base12");
    assert!(!prepared.preview().pending);
    let expected = prepared.preview().version.clone();
    assert_eq!(receiver.snapshot(), before);
    assert_eq!(receiver.undo_state(), history);
    let update = receiver.commit_import(prepared).unwrap();
    assert_eq!(update.after, expected);
    assert_eq!(receiver.writer_id(), writer);
    let _ = undo(&mut receiver);
    assert_eq!(receiver.snapshot().text, "base12");
}

#[test]
fn preparations_are_bound_to_one_unchanged_buffer_even_when_versions_match() {
    let mut base = buffer(1, "base");
    let mut a = replica(&base, 2);
    let mut b = replica(&base, 3);
    let packet = edit(&mut base, vec![span(4, 4, "new")]).operation.unwrap();
    let foreign = a
        .prepare_import(Import::new(packet.clone(), "peer"))
        .unwrap();
    let before = b.snapshot();
    assert!(matches!(
        b.commit_import(foreign),
        Err(CoreError::StalePreparation)
    ));
    assert_eq!(b.snapshot(), before);
    let stale = a
        .prepare_import(Import::new(packet.clone(), "peer"))
        .unwrap();
    let _ = edit(&mut a, vec![span(0, 0, "local ")]);
    assert!(matches!(
        a.commit_import(stale),
        Err(CoreError::StalePreparation)
    ));
    let stale = a
        .prepare_import(Import::new(packet.clone(), "peer"))
        .unwrap();
    let _ = apply(&mut a, BufferCommand::ClearUndo); // text/version unchanged, personal state changed
    assert!(matches!(
        a.commit_import(stale),
        Err(CoreError::StalePreparation)
    ));
    let stable = a.prepare_import(Import::new(packet, "peer")).unwrap();
    let _ = edit(&mut a, vec![]); // a genuine no-op does not invalidate admission
    let _ = a.commit_import(stable).unwrap();
}

#[test]
fn a_new_pending_import_invalidates_preparation_without_advancing_the_text_version() {
    let base = buffer(1, "");
    let mut sender = replica(&base, 2);
    let mut receiver = replica(&base, 3);
    let first = edit(&mut sender, vec![span(0, 0, "1")]).operation.unwrap();
    let second = edit(&mut sender, vec![span(1, 1, "2")]).operation.unwrap();
    let prepared = receiver
        .prepare_import(Import::new(first.clone(), "peer"))
        .unwrap();
    let before = receiver.version();
    let _ = import(&mut receiver, second);
    assert_eq!(receiver.version(), before);
    assert!(matches!(
        receiver.commit_import(prepared),
        Err(CoreError::StalePreparation)
    ));
    let prepared = receiver.prepare_import(Import::new(first, "peer")).unwrap();
    assert_eq!(prepared.preview().text, "12");
    assert!(!receiver.commit_import(prepared).unwrap().pending);
}

#[test]
fn explicit_import_reset_clears_undo_without_changing_writer_or_reseeding_history() {
    let mut local = buffer(1, "base");
    let mut peer = replica(&local, 2);
    let _ = edit(&mut local, vec![span(0, 0, "draft ")]);
    let packet = edit(&mut peer, vec![span(4, 4, " disk")])
        .operation
        .unwrap();
    let writer = local.writer_id();
    let update = apply(
        &mut local,
        BufferCommand::Import(Import {
            packet,
            origin: "filesystem".into(),
            reset_undo: true,
        }),
    );
    assert_eq!(local.snapshot().text, "draft base disk");
    assert_eq!(local.writer_id(), writer);
    assert!(!update.undo.can_undo);
    assert!(update.local_operation().is_none());
}

#[test]
fn identities_writer_collisions_corruption_and_packet_modes_are_rejected_atomically() {
    let a = buffer(1, "base");
    let mut peer = replica(&a, 2);
    let packet = edit(&mut peer, vec![span(0, 0, "peer ")])
        .operation
        .unwrap();
    let before = a.snapshot();
    for packet in [
        SyncPacket {
            identity: DocumentIdentity {
                document_id: "other".into(),
                history_id: "history".into(),
            },
            ..packet.clone()
        },
        SyncPacket {
            kind: PacketKind::Snapshot,
            ..packet.clone()
        },
        SyncPacket {
            data: vec![1, 2, 3].into(),
            ..packet.clone()
        },
    ] {
        assert!(a.prepare_import(Import::new(packet, "bad")).is_err());
        assert_eq!(a.snapshot(), before);
    }
    assert!(matches!(
        Buffer::from_snapshot(&a.export_snapshot().unwrap(), Some(1)),
        Err(CoreError::WriterAlreadyUsed { .. })
    ));
    let foreign = loro::LoroDoc::from_snapshot(&a.export_snapshot().unwrap().data).unwrap();
    foreign.set_peer_id(1).unwrap();
    let start = foreign.oplog_vv();
    foreign.get_text("source").insert(0, "forged").unwrap();
    foreign.commit();
    let forged = SyncPacket::from_binary(
        identity(),
        foreign.export(loro::ExportMode::updates(&start)).unwrap(),
    )
    .unwrap();
    assert!(matches!(
        a.prepare_import(Import::new(forged, "bad")),
        Err(CoreError::WriterCollision)
    ));
    assert_eq!(a.snapshot(), before);
    let external = loro::LoroDoc::new();
    external.get_text("source").insert(0, "text").unwrap();
    external.commit();
    let shallow = SyncPacket {
        identity: identity(),
        kind: PacketKind::Snapshot,
        data: external
            .export(loro::ExportMode::shallow_snapshot(
                &external.state_frontiers(),
            ))
            .unwrap()
            .into(),
    };
    assert!(matches!(
        Buffer::from_snapshot(&shallow, None),
        Err(CoreError::UnsupportedHistory)
    ));
    external.get_map("view").insert("cursor", 1).unwrap();
    external.commit();
    let invalid = SyncPacket::from_binary(
        identity(),
        external.export(loro::ExportMode::Snapshot).unwrap(),
    )
    .unwrap();
    assert!(Buffer::from_snapshot(&invalid, None).is_err());
}

#[test]
fn pending_imports_cannot_bypass_text_only_schema_validation() {
    let base = buffer(1, "base");
    let mut receiver = replica(&base, 2);
    let foreign = loro::LoroDoc::from_snapshot(&base.export_snapshot().unwrap().data).unwrap();
    foreign.set_peer_id(3).unwrap();
    let start = foreign.oplog_vv();
    foreign.get_text("source").insert(0, "prefix ").unwrap();
    foreign.commit();
    let first = SyncPacket::from_binary(
        identity(),
        foreign.export(loro::ExportMode::updates(&start)).unwrap(),
    )
    .unwrap();
    let middle = foreign.oplog_vv();
    foreign.get_map("view").insert("cursor", 42).unwrap();
    foreign.commit();
    let last = SyncPacket::from_binary(
        identity(),
        foreign.export(loro::ExportMode::updates(&middle)).unwrap(),
    )
    .unwrap();
    let before = receiver.snapshot();
    match receiver.apply(BufferCommand::Import(Import::new(last, "late"))) {
        Err(CoreError::InvalidPacket) => {}
        Ok(update) => {
            assert!(update.pending);
            assert!(matches!(
                receiver.prepare_import(Import::new(first, "dependency")),
                Err(CoreError::InvalidPacket)
            ));
        }
        Err(error) => panic!("unexpected error: {error}"),
    }
    assert_eq!(receiver.snapshot().text, before.text);
    assert_eq!(receiver.version(), before.version);
}

#[test]
fn shuffled_offline_replicas_converge_and_restore_unicode_history() {
    for seed in 1..=16u64 {
        let base = buffer(99, "= 文档\nA😀B\né\n");
        let mut replicas = [replica(&base, 1), replica(&base, 2), replica(&base, 3)];
        let mut packets = Vec::new();
        let mut random = seed;
        let mut rand = |n: usize| {
            random = random.wrapping_mul(1664525).wrapping_add(1013904223);
            (random as usize) % n
        };
        for replica in &mut replicas {
            let mut oracle = replica.snapshot().text;
            for _ in 0..25 {
                let boundaries: Vec<_> = std::iter::once(0)
                    .chain(oracle.chars().scan(0, |n, c| {
                        *n += c.len_utf16();
                        Some(*n)
                    }))
                    .collect();
                let deletion = rand(3) == 0 && boundaries.len() > 1;
                let i = rand(boundaries.len() - usize::from(deletion));
                let from = boundaries[i];
                let to = if deletion { boundaries[i + 1] } else { from };
                let insert = if deletion {
                    ""
                } else {
                    ["中", "😀", "é", "\n", "abc", "👩‍💻"][rand(6)]
                };
                let from_byte = utf16_to_byte(&oracle, from).unwrap();
                let to_byte = utf16_to_byte(&oracle, to).unwrap();
                oracle.replace_range(from_byte..to_byte, insert);
                let update = edit(replica, vec![span(from, to, insert)]);
                assert_eq!(replica.snapshot().text, oracle);
                packets.push(update.operation.unwrap());
            }
        }
        for i in (1..packets.len()).rev() {
            let j = rand(i + 1);
            packets.swap(i, j);
        }
        for (i, replica) in replicas.iter_mut().enumerate() {
            let iter: Box<dyn Iterator<Item = &SyncPacket>> = if i % 2 == 0 {
                Box::new(packets.iter())
            } else {
                Box::new(packets.iter().rev())
            };
            for packet in iter {
                let _ = import(replica, packet.clone());
                assert!(!import(replica, packet.clone()).changed);
            }
        }
        for replica in &replicas[1..] {
            assert_eq!(
                replica.snapshot().text,
                replicas[0].snapshot().text,
                "seed {seed}"
            );
            assert_eq!(replica.version(), replicas[0].version());
        }
        let mut recovered = replica(&base, 4);
        for packet in packets.iter().rev() {
            let _ = import(&mut recovered, packet.clone());
        }
        assert_eq!(recovered.version(), replicas[0].version());
        assert_eq!(
            replica(&recovered, 5).snapshot().text,
            replicas[0].snapshot().text
        );
    }
}
