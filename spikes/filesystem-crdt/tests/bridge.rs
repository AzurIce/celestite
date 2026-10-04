use celestite_filesystem_crdt_spike::{Bridge, Error, Fault, WritePhase};
use loro::{ExportMode, LoroDoc, UndoManager};
use std::{fs, path::Path, sync::mpsc, time::Duration};
use tempfile::TempDir;

fn fixture(initial: &str) -> (TempDir, Bridge) {
    let dir = tempfile::tempdir().unwrap();
    let bridge = Bridge::create(&dir.path().join("state.redb"), initial.as_bytes()).unwrap();
    (dir, bridge)
}
fn reopen(dir: &TempDir, bridge: Bridge) -> Bridge {
    drop(bridge);
    Bridge::reopen(&dir.path().join("state.redb")).unwrap()
}
fn clone_peer(bridge: &Bridge, writer: u64) -> LoroDoc {
    let doc = LoroDoc::from_snapshot(&bridge.core().export(ExportMode::Snapshot).unwrap()).unwrap();
    doc.set_peer_id(writer).unwrap();
    doc
}
fn content(doc: &LoroDoc) -> String {
    doc.get_text("source").to_string()
}
fn change(doc: &LoroDoc, target: &str) -> Vec<u8> {
    let before = doc.oplog_vv();
    doc.get_text("source")
        .update(target, Default::default())
        .unwrap();
    doc.commit();
    doc.export(ExportMode::updates(&before)).unwrap()
}
fn atomic_write(path: &Path, bytes: &[u8]) {
    let stage = path.with_extension("external-stage");
    fs::write(&stage, bytes).unwrap();
    fs::rename(stage, path).unwrap();
}

#[test]
fn consecutive_external_diffs_branch_from_disk_not_merged_core() {
    let (_dir, mut bridge) = fixture("base\n");
    bridge.edit("local\nbase\n").unwrap();
    bridge.observe(b"base\nexternal 1\n", Fault::None).unwrap();
    assert_eq!(bridge.state().cursor.text, "base\nexternal 1\n");
    assert_eq!(bridge.text(), "local\nbase\nexternal 1\n");
    bridge.observe(b"base\nexternal 12\n", Fault::None).unwrap();
    assert_eq!(bridge.state().cursor.text, "base\nexternal 12\n");
    assert_eq!(bridge.text(), "local\nbase\nexternal 12\n");
    bridge
        .observe(b"base\nexternal 123\n", Fault::None)
        .unwrap();
    assert_eq!(bridge.text(), "local\nbase\nexternal 123\n");
    bridge.validate().unwrap();
}

#[test]
fn saved_host_changes_enter_the_next_external_causal_base() {
    let (dir, mut bridge) = fixture("base\n");
    let path = dir.path().join("a.md");
    fs::write(&path, b"base\n").unwrap();
    bridge.edit("local\nbase\n").unwrap();
    assert!(bridge.save_file(&path, Fault::None).unwrap());
    // A stale external buffer overwrites a now-confirmed saved host edit. This
    // is deliberately interpreted as deleting it from the prior disk state.
    atomic_write(&path, b"base\nexternal\n");
    bridge
        .observe(&fs::read(&path).unwrap(), Fault::None)
        .unwrap();
    assert_eq!(bridge.text(), "base\nexternal\n");
    assert!(!bridge.save_file(&path, Fault::None).unwrap());
}

#[test]
fn duplicate_hints_and_replayed_packets_do_not_create_fresh_operations() {
    let (_dir, mut bridge) = fixture("base");
    let observation = bridge.observe(b"base!", Fault::None).unwrap().unwrap();
    let version = bridge.core().oplog_vv();
    for _ in 0..100 {
        assert!(bridge.observe(b"base!", Fault::None).unwrap().is_none());
        bridge.import(observation.packet.as_ref().unwrap()).unwrap();
        assert_eq!(bridge.core().oplog_vv(), version);
    }
    assert_eq!(bridge.state().imported_observations, 1);
}

#[test]
fn three_replicas_converge_with_reordered_and_duplicate_filesystem_updates() {
    let (_dir, mut bridge) = fixture("base\n");
    let a = clone_peer(&bridge, 3);
    let b = clone_peer(&bridge, 4);
    let a_packet = change(&a, "A\nbase\n");
    let b_packet = change(&b, "B\nbase\n");
    bridge.import(&a_packet).unwrap();
    let mut external = vec![];
    for target in ["base\n1", "base\n12", "base\n123"] {
        external.push(
            bridge
                .observe(target.as_bytes(), Fault::None)
                .unwrap()
                .unwrap()
                .packet
                .unwrap(),
        );
    }
    bridge.import(&b_packet).unwrap();
    for packet in external.iter().rev().chain(external.iter()) {
        a.import(packet).unwrap();
        b.import(packet).unwrap();
    }
    a.import(&b_packet).unwrap();
    b.import(&a_packet).unwrap();
    assert_eq!(content(&a), bridge.text());
    assert_eq!(content(&b), bridge.text());
    assert_eq!(a.oplog_vv(), bridge.core().oplog_vv());
    assert_eq!(b.oplog_vv(), bridge.core().oplog_vv());
}

#[test]
fn external_edits_are_excluded_from_personal_undo() {
    let (_dir, mut bridge) = fixture("base\n");
    let host = clone_peer(&bridge, 3);
    let mut undo = UndoManager::new(&host);
    undo.set_merge_interval(0);
    host.get_text("source").insert(0, "local\n").unwrap();
    host.commit();
    let external = bridge
        .observe(b"base\nexternal\n", Fault::None)
        .unwrap()
        .unwrap();
    host.import(external.packet.as_ref().unwrap()).unwrap();
    assert_eq!(content(&host), "local\nbase\nexternal\n");
    undo.undo().unwrap();
    assert_eq!(content(&host), "base\nexternal\n");
}

#[test]
fn observation_commit_and_lost_receipt_recovery_are_atomic() {
    for fault in [
        Fault::BeforeObservationCommit,
        Fault::AfterObservationCommit,
    ] {
        let (dir, mut bridge) = fixture("base");
        bridge.edit("local base").unwrap();
        assert!(matches!(
            bridge.observe(b"base external", fault),
            Err(Error::Crash(_))
        ));
        let mut bridge = reopen(&dir, bridge);
        let committed = fault == Fault::AfterObservationCommit;
        assert_eq!(bridge.state().imported_observations, u64::from(committed));
        let retry = bridge.observe(b"base external", Fault::None).unwrap();
        assert_eq!(retry.is_none(), committed);
        assert_eq!(bridge.state().imported_observations, 1);
        assert_eq!(bridge.text(), "local base external");
        bridge.validate().unwrap();
    }
}

#[test]
fn every_write_crash_boundary_recovers_or_explicitly_stops() {
    for fault in [
        Fault::BeforeIntentCommit,
        Fault::AfterIntentCommit,
        Fault::BeforeStartedCommit,
        Fault::AfterStartedCommit,
        Fault::AfterDiskWrite,
        Fault::BeforeReceiptCommit,
        Fault::AfterReceiptCommit,
    ] {
        let (dir, mut bridge) = fixture("base\n");
        let path = dir.path().join("a.md");
        fs::write(&path, b"base\n").unwrap();
        bridge.edit("local\nbase\n").unwrap();
        assert!(
            matches!(bridge.save_file(&path, fault), Err(Error::Crash(_))),
            "{fault:?}"
        );
        let mut bridge = reopen(&dir, bridge);
        let disk = fs::read(&path).unwrap();
        if fault == Fault::AfterStartedCommit {
            assert!(matches!(bridge.recover(&disk), Err(Error::UncertainWrite)));
            assert!(matches!(
                bridge.observe(&disk, Fault::None),
                Err(Error::PendingWrite)
            ));
            assert_eq!(bridge.text(), "local\nbase\n");
            continue;
        }
        bridge.recover(&disk).unwrap();
        bridge.save_file(&path, Fault::None).unwrap();
        let version = bridge.core().oplog_vv();
        for _ in 0..20 {
            assert!(
                bridge
                    .observe(&fs::read(&path).unwrap(), Fault::None)
                    .unwrap()
                    .is_none()
            );
            assert!(!bridge.save_file(&path, Fault::None).unwrap());
            assert_eq!(bridge.core().oplog_vv(), version);
        }
        assert_eq!(fs::read(&path).unwrap(), b"local\nbase\n");
        assert_eq!(bridge.state().imported_observations, 0);
    }
}

#[test]
fn uncertain_write_must_not_guess_even_if_disk_matches_old_bytes() {
    for disk_after_crash in [b"base".as_slice(), b"third party".as_slice()] {
        let (dir, mut bridge) = fixture("base");
        bridge.edit("target base").unwrap();
        bridge.prepare_write(Fault::None).unwrap();
        bridge.start_write(b"base", Fault::None).unwrap();
        let mut bridge = reopen(&dir, bridge);
        assert!(matches!(
            bridge.recover(disk_after_crash),
            Err(Error::UncertainWrite)
        ));
        assert_eq!(bridge.state().cursor.bytes, b"base");
        assert_eq!(
            bridge.state().intent.as_ref().unwrap().target.bytes,
            b"target base"
        );
        assert_eq!(bridge.text(), "target base");
    }
}

#[test]
fn prepared_write_detects_a_changed_baseline_without_touching_disk() {
    let (_dir, mut bridge) = fixture("base");
    bridge.edit("local base").unwrap();
    bridge.prepare_write(Fault::None).unwrap();
    assert_eq!(
        bridge.state().intent.as_ref().unwrap().phase,
        WritePhase::Prepared
    );
    assert!(matches!(
        bridge.start_write(b"base external", Fault::None),
        Err(Error::DiskChanged)
    ));
    assert!(bridge.state().intent.is_none());
    bridge.observe(b"base external", Fault::None).unwrap();
    assert_eq!(bridge.text(), "local base external");
}

#[test]
fn format_only_changes_advance_disk_cursor_without_crdt_edits() {
    let (dir, mut bridge) = fixture("a\nb\n");
    let version = bridge.core().oplog_vv();
    let changed = bridge
        .observe("\u{feff}a\r\nb\r\n".as_bytes(), Fault::None)
        .unwrap()
        .unwrap();
    assert!(changed.packet.is_none());
    assert_eq!(bridge.core().oplog_vv(), version);
    bridge.edit("a\nb!\n").unwrap();
    let path = dir.path().join("a.md");
    fs::write(&path, &bridge.state().cursor.bytes).unwrap();
    bridge.save_file(&path, Fault::None).unwrap();
    assert_eq!(fs::read(&path).unwrap(), "\u{feff}a\r\nb!\r\n".as_bytes());
    assert!(
        bridge
            .observe(&fs::read(path).unwrap(), Fault::None)
            .unwrap()
            .is_none()
    );
}

#[test]
fn invalid_snapshots_preserve_history_and_disk_cursor() {
    let (_dir, mut bridge) = fixture("base");
    let before = serde_json::to_vec(bridge.state()).unwrap();
    for bytes in [
        vec![0xff],
        b"a\0b".to_vec(),
        vec![b'a'; 5 * 1024 * 1024 + 1],
    ] {
        assert!(matches!(
            bridge.observe(&bytes, Fault::None),
            Err(Error::InvalidText)
        ));
        assert_eq!(serde_json::to_vec(bridge.state()).unwrap(), before);
    }
}

#[test]
fn unicode_and_empty_snapshots_roundtrip_through_continuous_branches() {
    let (_dir, mut bridge) = fixture("你好😀e\u{301}\n");
    let observer = clone_peer(&bridge, 3);
    for target in ["你好🦀e\u{301}\n", "你好🦀e\u{301}\n尾", "", "🇨🇳👩‍💻\n"] {
        let change = bridge
            .observe(target.as_bytes(), Fault::None)
            .unwrap()
            .unwrap();
        observer.import(change.packet.as_ref().unwrap()).unwrap();
        assert_eq!(bridge.text(), target);
        assert_eq!(content(&observer), target);
        bridge.validate().unwrap();
    }
}

// Deliberately reproduce the production display-delta algorithm, to test why
// one large replacement should not become the filesystem's edit algorithm.
fn coarse_update(doc: &LoroDoc, target: &str) {
    let old = content(doc);
    let before: Vec<char> = old.chars().collect();
    let after: Vec<char> = target.chars().collect();
    let prefix = before
        .iter()
        .zip(&after)
        .take_while(|(a, b)| a == b)
        .count();
    let suffix = before[prefix..]
        .iter()
        .rev()
        .zip(after[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let t = doc.get_text("source");
    if before.len() > prefix + suffix {
        t.delete(prefix, before.len() - prefix - suffix).unwrap();
    }
    let insert: String = after[prefix..after.len() - suffix].iter().collect();
    if !insert.is_empty() {
        t.insert(prefix, &insert).unwrap();
    }
    doc.commit();
}

#[test]
fn single_replacement_diff_reintroduces_unchanged_text_during_merge() {
    let (_dir, mut bridge) = fixture("A middle B");
    let remote = clone_peer(&bridge, 3);
    let packet = change(&remote, "A MIDDLE B");
    bridge.import(&packet).unwrap();
    let coarse = bridge
        .core()
        .fork_at(&loro::Frontiers::decode(&bridge.state().cursor.frontiers).unwrap())
        .unwrap();
    coarse.set_peer_id(90).unwrap();
    let base = coarse.oplog_vv();
    coarse_update(&coarse, "A1 middle B1");
    let coarse_packet = coarse.export(ExportMode::updates(&base)).unwrap();
    let coarse_host = clone_peer(&bridge, 4);
    coarse_host.import(&coarse_packet).unwrap();
    bridge.observe(b"A1 middle B1", Fault::None).unwrap();
    assert_eq!(bridge.text(), "A1 MIDDLE B1");
    assert_ne!(content(&coarse_host), bridge.text());
    println!(
        "coarse-diff counterexample: {:?}; refined: {:?}",
        content(&coarse_host),
        bridge.text()
    );
}

#[test]
fn event_coalescing_cannot_reconstruct_unobserved_aba_history() {
    let (_dir, mut observed) = fixture("ab");
    let (_dir2, mut skipped) = fixture("ab");
    observed.observe(b"a", Fault::None).unwrap();
    observed.observe(b"ab", Fault::None).unwrap();
    assert!(skipped.observe(b"ab", Fault::None).unwrap().is_none());
    assert_eq!(observed.text(), skipped.text());
    assert_ne!(observed.core().oplog_vv(), skipped.core().oplog_vv());
    assert_eq!(observed.state().imported_observations, 2);
    assert_eq!(skipped.state().imported_observations, 0);
}

#[test]
fn skipped_intermediate_snapshot_can_change_the_merged_text() {
    let (_dir, mut observed) = fixture("a");
    let (_dir2, mut skipped) = fixture("a");
    observed.edit("X").unwrap();
    skipped.edit("X").unwrap();
    observed.observe(b"", Fault::None).unwrap();
    observed.observe(b"a", Fault::None).unwrap();
    assert!(skipped.observe(b"a", Fault::None).unwrap().is_none());
    assert_eq!(skipped.text(), "X");
    assert!(observed.text().contains('X'));
    assert!(observed.text().contains('a'));
    println!(
        "missed-snapshot counterexample: observed={:?}; coalesced={:?}",
        observed.text(),
        skipped.text()
    );
}

#[test]
fn identical_observation_sequence_has_identical_operations_and_projection() {
    let (_dir, mut first) = fixture("a😀b");
    let (_dir2, mut second) = fixture("a😀b");
    for bridge in [&mut first, &mut second] {
        bridge.edit("local a😀b").unwrap();
        for disk in ["a🦀b", "a🦀b tail", "a🦀b", "a🦀b"] {
            bridge.observe(disk.as_bytes(), Fault::None).unwrap();
        }
    }
    assert_eq!(first.text(), second.text());
    assert_eq!(first.core().oplog_vv(), second.core().oplog_vv());
    assert_eq!(
        first.state().cursor.frontiers,
        second.state().cursor.frontiers
    );
}

#[cfg(target_os = "linux")]
#[test]
fn atomic_exchange_preserves_the_version_that_plain_rename_would_overwrite() {
    let (dir, mut bridge) = fixture("base");
    let path = dir.path().join("a.md");
    let stage = dir.path().join("private-stage");
    fs::write(&path, b"base").unwrap();
    bridge.edit("host base").unwrap();
    bridge.prepare_write(Fault::None).unwrap();
    bridge
        .start_write(&fs::read(&path).unwrap(), Fault::None)
        .unwrap();
    fs::write(
        &stage,
        &bridge.state().intent.as_ref().unwrap().target.bytes,
    )
    .unwrap();
    // Inject a complete external atomic save in the check/replace window.
    atomic_write(&path, b"base external");
    rustix::fs::renameat_with(
        rustix::fs::CWD,
        &stage,
        rustix::fs::CWD,
        &path,
        rustix::fs::RenameFlags::EXCHANGE,
    )
    .unwrap();
    let displaced = fs::read(&stage).unwrap();
    assert_eq!(displaced, b"base external");
    assert_eq!(fs::read(&path).unwrap(), b"host base");
    // Before accepting the write receipt, derive the displaced external update
    // from the OLD disk cursor. Captured bytes and packet must be durably kept.
    let branch = bridge
        .core()
        .fork_at(&loro::Frontiers::decode(&bridge.state().cursor.frontiers).unwrap())
        .unwrap();
    branch.set_peer_id(80).unwrap();
    let packet = change(&branch, std::str::from_utf8(&displaced).unwrap());
    bridge.complete_write(Fault::None).unwrap();
    bridge.import(&packet).unwrap();
    assert_eq!(bridge.text(), "host base external");
    assert_eq!(bridge.state().cursor.text, "host base");
}

#[cfg(target_os = "linux")]
#[test]
fn atomic_exchange_does_not_close_an_external_in_place_writer() {
    use std::io::{Seek, SeekFrom, Write};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.md");
    let stage = dir.path().join("private-stage");
    fs::write(&path, b"base").unwrap();
    let mut external_fd = fs::OpenOptions::new().write(true).open(&path).unwrap();
    fs::write(&stage, b"host").unwrap();
    rustix::fs::renameat_with(
        rustix::fs::CWD,
        &stage,
        rustix::fs::CWD,
        &path,
        rustix::fs::RenameFlags::EXCHANGE,
    )
    .unwrap();
    assert_eq!(fs::read(&stage).unwrap(), b"base");
    // An existing descriptor still refers to the displaced inode. A snapshot
    // read before this late write cannot represent its final contents.
    external_fd.seek(SeekFrom::Start(0)).unwrap();
    external_fd.write_all(b"late").unwrap();
    external_fd.sync_all().unwrap();
    assert_eq!(fs::read(&stage).unwrap(), b"late");
    assert_eq!(fs::read(&path).unwrap(), b"host");
}

#[test]
fn hash_check_and_atomic_rename_are_not_an_atomic_compare_and_swap() {
    let (dir, mut bridge) = fixture("base");
    let path = dir.path().join("a.md");
    fs::write(&path, b"base").unwrap();
    bridge.edit("host base").unwrap();
    bridge.prepare_write(Fault::None).unwrap();
    bridge
        .start_write(&fs::read(&path).unwrap(), Fault::None)
        .unwrap();
    // Deterministic barrier: external write completes AFTER the hash check and
    // BEFORE our replacement. Ordinary rename cannot reject this change.
    atomic_write(&path, b"external base");
    let stage = dir.path().join("host-stage");
    fs::write(
        &stage,
        &bridge.state().intent.as_ref().unwrap().target.bytes,
    )
    .unwrap();
    fs::rename(stage, &path).unwrap();
    bridge.complete_write(Fault::None).unwrap();
    assert_eq!(fs::read(path).unwrap(), b"host base");
    assert!(!bridge.text().contains("external"));
}

#[test]
fn two_equal_reads_do_not_prove_an_external_save_is_complete() {
    let (dir, mut bridge) = fixture("base");
    let path = dir.path().join("a.md");
    fs::write(&path, b"base").unwrap();
    // Model an in-place writer paused after truncation. Both reads are valid,
    // equal and stable for arbitrarily long, while a later write is pending.
    fs::write(&path, b"").unwrap();
    let first = fs::read(&path).unwrap();
    let second = fs::read(&path).unwrap();
    assert_eq!(first, second);
    bridge.observe(&second, Fault::None).unwrap();
    fs::write(&path, b"base new").unwrap();
    bridge
        .observe(&fs::read(path).unwrap(), Fault::None)
        .unwrap();
    assert_eq!(bridge.text(), "base new");
    assert_eq!(bridge.state().imported_observations, 2);
}

#[test]
fn actual_notify_and_atomic_saves_reach_a_feedback_free_fixed_point() {
    use notify::{RecursiveMode, Watcher};
    let (dir, mut bridge) = fixture("base\n");
    let vault = dir.path().join("vault");
    fs::create_dir(&vault).unwrap();
    let path = vault.join("a.md");
    fs::write(&path, b"base\n").unwrap();
    let (send, recv) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if !matches!(event, Ok(ref event) if event.kind.is_access()) {
            let _ = send.send(event);
        }
    })
    .unwrap();
    watcher.watch(&vault, RecursiveMode::Recursive).unwrap();
    bridge.edit("local\nbase\n").unwrap();
    for target in [
        b"base\n1".as_slice(),
        b"base\n12".as_slice(),
        b"base\n123".as_slice(),
    ] {
        atomic_write(&path, target);
        recv.recv_timeout(Duration::from_secs(3)).unwrap().unwrap();
        bridge
            .observe(&fs::read(&path).unwrap(), Fault::None)
            .unwrap();
        while recv.try_recv().is_ok() {}
    }
    assert_eq!(bridge.text(), "local\nbase\n123");
    bridge.save_file(&path, Fault::None).unwrap();
    recv.recv_timeout(Duration::from_secs(3)).unwrap().unwrap();
    let version = bridge.core().oplog_vv();
    for _ in 0..100 {
        assert!(
            bridge
                .observe(&fs::read(&path).unwrap(), Fault::None)
                .unwrap()
                .is_none()
        );
        assert!(!bridge.save_file(&path, Fault::None).unwrap());
    }
    assert_eq!(bridge.core().oplog_vv(), version);
    assert_eq!(bridge.state().imported_observations, 3);
}

struct Random(u64);
impl Random {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}
fn mutate(s: &str, r: &mut Random) -> String {
    let mut chars: Vec<char> = s.chars().collect();
    let at = r.next() as usize % (chars.len() + 1);
    if r.next().is_multiple_of(3) && at < chars.len() {
        chars.remove(at);
    } else {
        let alphabet = ['a', '中', '😀', '\n', 'b'];
        chars.insert(at, alphabet[r.next() as usize % alphabet.len()]);
    }
    chars.into_iter().collect()
}

#[test]
fn randomized_interleavings_preserve_cursor_and_replica_convergence() {
    const SEEDS: u64 = 24;
    const STEPS: usize = 100;
    for seed in 1..=SEEDS {
        let (_dir, mut bridge) = fixture("base\n");
        let peer = clone_peer(&bridge, 3);
        let mut random = Random(seed);
        let mut disk = b"base\n".to_vec();
        let mut packets = vec![];
        for _ in 0..STEPS {
            match random.next() % 7 {
                0 => disk = mutate(std::str::from_utf8(&disk).unwrap(), &mut random).into_bytes(),
                1 | 2 => {
                    if let Some(observation) = bridge.observe(&disk, Fault::None).unwrap()
                        && let Some(packet) = observation.packet
                    {
                        packets.push(packet);
                    }
                }
                3 => bridge.edit(&mutate(&bridge.text(), &mut random)).unwrap(),
                4 => {
                    let packet = change(&peer, &mutate(&content(&peer), &mut random));
                    bridge.import(&packet).unwrap();
                }
                5 => {
                    peer.import(&bridge.core().export(ExportMode::all_updates()).unwrap())
                        .unwrap();
                }
                _ => {
                    bridge.observe(&disk, Fault::None).unwrap();
                    if bridge.prepare_write(Fault::None).unwrap() {
                        bridge.start_write(&disk, Fault::None).unwrap();
                        disk = bridge.state().intent.as_ref().unwrap().target.bytes.clone();
                        bridge.complete_write(Fault::None).unwrap();
                    }
                }
            }
            bridge.validate().unwrap();
        }
        bridge.observe(&disk, Fault::None).unwrap();
        for packet in packets.iter().rev() {
            peer.import(packet).unwrap();
        }
        peer.import(&bridge.core().export(ExportMode::all_updates()).unwrap())
            .unwrap();
        assert_eq!(content(&peer), bridge.text(), "seed={seed}");
        assert_eq!(peer.oplog_vv(), bridge.core().oplog_vv(), "seed={seed}");
        if bridge.prepare_write(Fault::None).unwrap() {
            bridge.start_write(&disk, Fault::None).unwrap();
            disk = bridge.state().intent.as_ref().unwrap().target.bytes.clone();
            bridge.complete_write(Fault::None).unwrap();
        }
        let stable_version = bridge.core().oplog_vv();
        for _ in 0..10 {
            assert!(bridge.observe(&disk, Fault::None).unwrap().is_none());
            assert!(!bridge.prepare_write(Fault::None).unwrap());
            assert_eq!(bridge.core().oplog_vv(), stable_version);
        }
    }
    println!(
        "validated {SEEDS} deterministic seeds x {STEPS} interleavings = {} steps",
        SEEDS * STEPS as u64
    );
}

#[test]
fn exhaustive_small_unicode_histories_preserve_unrelated_insertions_and_converge() {
    let alphabet = ['a', 'b', '😀'];
    let mut corpus = vec![String::new()];
    for a in alphabet {
        corpus.push(a.to_string());
        for b in alphabet {
            corpus.push(format!("{a}{b}"));
        }
    }
    let mut cases = 0;
    for initial in &corpus {
        for first in &corpus {
            for second in &corpus {
                let core = LoroDoc::new();
                core.set_peer_id(1).unwrap();
                core.get_text("source").insert(0, initial).unwrap();
                core.commit();
                let observer =
                    LoroDoc::from_snapshot(&core.export(ExportMode::Snapshot).unwrap()).unwrap();
                observer.set_peer_id(4).unwrap();
                let mut cursor = core.state_frontiers();
                core.set_peer_id(2).unwrap();
                let before_local = core.oplog_vv();
                core.get_text("source").insert(0, "HOST|").unwrap();
                core.commit();
                let host_packet = core.export(ExportMode::updates(&before_local)).unwrap();
                let mut packets = vec![];
                for (writer, target) in [(100, first), (101, second)] {
                    let branch = core.fork_at(&cursor).unwrap();
                    branch.set_peer_id(writer).unwrap();
                    let packet = change(&branch, target);
                    assert_eq!(content(&branch), *target);
                    cursor = branch.state_frontiers();
                    core.import(&packet).unwrap();
                    packets.push(packet);
                }
                for packet in packets.iter().rev().chain(packets.iter()) {
                    observer.import(packet).unwrap();
                }
                observer.import(&host_packet).unwrap();
                assert_eq!(content(&observer), content(&core));
                assert_eq!(observer.oplog_vv(), core.oplog_vv());
                assert!(content(&core).contains("HOST|"));
                assert_eq!(content(&core).replace("HOST|", ""), *second);
                assert_eq!(content(&core.fork_at(&cursor).unwrap()), *second);
                cases += 1;
            }
        }
    }
    assert_eq!(cases, 2197);
    println!("exhaustively verified {cases} two-transition Unicode histories");
}

#[test]
fn pending_dependencies_survive_restart_and_repeated_packets_are_idempotent() {
    let (dir, mut bridge) = fixture("base");
    let peer = clone_peer(&bridge, 3);
    let first = change(&peer, "base one");
    let second = change(&peer, "base one two");
    bridge.import(&second).unwrap();
    assert_eq!(bridge.text(), "base");
    assert_eq!(bridge.state().pending_packets.len(), 1);
    let sequence = bridge.state().sequence;
    bridge.import(&second).unwrap();
    assert_eq!(bridge.state().sequence, sequence);
    let mut bridge = reopen(&dir, bridge);
    assert_eq!(bridge.state().pending_packets.len(), 1);
    bridge.import(&first).unwrap();
    assert!(bridge.state().pending_packets.is_empty());
    assert_eq!(bridge.text(), "base one two");
    assert_eq!(bridge.core().oplog_vv(), peer.oplog_vv());
    let sequence = bridge.state().sequence;
    for packet in [&first, &second] {
        bridge.import(packet).unwrap();
        assert_eq!(bridge.state().sequence, sequence);
    }
}
