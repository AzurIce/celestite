//! Filesystem notifications are hints. A bounded wakeup coalesces bursts, and a
//! periodic full observation repairs missed events without running IO in notify's callback.
use crate::{HostedVault, vault::fs::ChangeHint};
use std::{
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

const COALESCE: Duration = Duration::from_millis(40);
const FULL_SCAN_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub(crate) struct Trigger {
    sender: SyncSender<()>,
    stopped: Arc<AtomicBool>,
}
impl Trigger {
    pub fn request(&self) {
        let _ = self.sender.try_send(());
    }
}
pub(crate) fn channel() -> (Trigger, Receiver<()>) {
    let (sender, receiver) = mpsc::sync_channel(1);
    (
        Trigger {
            sender,
            stopped: Arc::new(AtomicBool::new(false)),
        },
        receiver,
    )
}
pub(crate) struct Reconciler {
    trigger: Trigger,
    thread: Option<JoinHandle<()>>,
}
impl Reconciler {
    pub fn start(
        vault: Weak<HostedVault>,
        trigger: Trigger,
        receiver: Receiver<()>,
    ) -> std::io::Result<Self> {
        let worker = Self::start_with_interval(vault, trigger, receiver, FULL_SCAN_INTERVAL)?;
        worker.trigger.request();
        Ok(worker)
    }
    fn start_with_interval(
        vault: Weak<HostedVault>,
        trigger: Trigger,
        receiver: Receiver<()>,
        interval: Duration,
    ) -> std::io::Result<Self> {
        let stopping = trigger.stopped.clone();
        let thread = thread::Builder::new()
            .name("vault-reconcile".into())
            .spawn(move || loop {
                match receiver.recv_timeout(interval) {
                    Ok(()) => {
                        // Bounded delay, even under a continuous stream of events.
                        thread::sleep(COALESCE);
                        // Capacity is one: discard at most one extra hint, so a
                        // continuously busy producer cannot starve observation.
                        let _ = receiver.try_recv();
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
                if stopping.load(Ordering::Acquire) {
                    break;
                }
                let Some(vault) = vault.upgrade() else { break };
                if let Err(error) = observe(&vault, &stopping) {
                    tracing::error!(vault_identity = %vault.id, code = %error.code, message = %error.message, "Background file reconciliation failed");
                }
            })?;
        Ok(Self {
            trigger,
            thread: Some(thread),
        })
    }
    pub fn stop(&mut self) {
        self.trigger.stopped.store(true, Ordering::Release);
        self.trigger.request();
        if let Some(thread) = self.thread.take() {
            // A final temporary upgrade can make HostedVault drop on this worker.
            if thread.thread().id() != thread::current().id() {
                let _ = thread.join();
            }
        }
    }
}
impl Drop for Reconciler {
    fn drop(&mut self) {
        self.stop();
    }
}

fn with_documents<T>(
    vault: &HostedVault,
    action: impl FnOnce(&mut crate::vault::documents::Documents) -> crate::vault::fs::Result<T>,
) -> crate::vault::fs::Result<T> {
    // Match every HTTP document/file operation's lock order.
    let _files = vault
        .files
        .lock()
        .map_err(|_| crate::vault::fs::VaultError::new("IO", "Vault lock failed", ""))?;
    let mut documents = vault
        .documents
        .lock()
        .map_err(|_| crate::vault::fs::VaultError::new("IO", "Document lock failed", ""))?;
    let result = action(&mut documents);
    // Also publish failures: a previously usable document can now require recovery.
    if documents.publish_changes()? {
        let _ = vault.events.send(ChangeHint::all());
        tracing::debug!(vault_identity = %vault.id, "Background document states changed");
    }
    result
}

fn observe(vault: &HostedVault, stopping: &AtomicBool) -> crate::vault::fs::Result<()> {
    observe_with(vault, stopping, |task| task.compute())
}

fn observe_with(
    vault: &HostedVault,
    stopping: &AtomicBool,
    mut execute: impl FnMut(
        celestite_core::FileObservationTask,
    ) -> celestite_core::FileObservationResult,
) -> crate::vault::fs::Result<()> {
    with_documents(vault, |docs| docs.reconcile())?;
    let count = with_documents(vault, |docs| docs.resident().map(|states| states.len()))?;
    for _ in 0..count {
        if stopping.load(Ordering::Acquire) {
            break;
        }
        let task = match with_documents(vault, |docs| docs.take_file_observation()) {
            Ok(Some(task)) => task,
            Ok(None) => break,
            Err(error) => {
                tracing::warn!(vault_identity = %vault.id, path = %error.path, code = %error.code, message = %error.message, "File observation preparation failed; continuing other files");
                continue;
            }
        };
        let path = task.path().to_string();
        let started = std::time::Instant::now();
        // Both Vault locks were dropped. HTTP and collaboration edits can advance
        // live history throughout this isolated, bounded calculation.
        let result = execute(task);
        let accepted = with_documents(vault, |docs| docs.complete_file_observation(result));
        match accepted {
            Ok(accepted) => {
                tracing::debug!(vault_identity = %vault.id, %path, accepted, elapsed_ms = started.elapsed().as_millis(), "Filesystem diff completed")
            }
            Err(error) => {
                tracing::warn!(vault_identity = %vault.id, path = %error.path, code = %error.code, message = %error.message, "File observation failed; preserving history and continuing other files")
            }
        }
    }
    with_documents(vault, |docs| {
        if docs.has_file_observations() {
            vault.reconcile_trigger.request();
        }
        Ok(())
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{documents::Documents, fs::FsVault};
    use celestite_core::{Edit, TextInput, UndoContext};
    use std::sync::Mutex;
    use tokio::sync::broadcast;

    fn fixture() -> (tempfile::TempDir, tempfile::TempDir, Arc<HostedVault>) {
        let root = tempfile::tempdir().unwrap();
        let history = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.md"), "A middle B").unwrap();
        std::fs::write(root.path().join("b.md"), "other").unwrap();
        let mut documents = Documents::open(
            Some(&history.path().join("history.redb")),
            root.path(),
            crate::HistoryMode::Initialize,
        )
        .unwrap();
        documents.reconcile().unwrap();
        let (trigger, _) = channel();
        let (events, _) = broadcast::channel(128);
        let watcher = notify::recommended_watcher(|_: notify::Result<notify::Event>| {}).unwrap();
        let vault = Arc::new(HostedVault {
            id: documents.identity.id.clone(),
            name: "Notes".into(),
            read_only: false,
            files: Mutex::new(FsVault::open(root.path()).unwrap()),
            documents: Mutex::new(documents),
            packages: crate::package_resources::PackageResources::new(
                root.path().into(),
                events.clone(),
            )
            .unwrap(),
            events,
            _watcher: Mutex::new(watcher),
            reconcile_trigger: trigger,
            reconciler: Mutex::new(None),
        });
        (root, history, vault)
    }

    #[test]
    fn diff_releases_both_vault_locks_and_merges_edits_accepted_while_running() {
        let (root, _history, vault) = fixture();
        let (ready, prepared) = mpsc::sync_channel(1);
        let (resume, released) = mpsc::sync_channel(1);
        std::fs::write(root.path().join("a.md"), "A1 middle B1").unwrap();
        let worker_vault = vault.clone();
        let worker = thread::spawn(move || {
            observe_with(&worker_vault, &AtomicBool::new(false), |task| {
                ready.send(()).unwrap();
                released.recv_timeout(Duration::from_secs(5)).unwrap();
                task.compute()
            })
            .unwrap()
        });
        prepared.recv_timeout(Duration::from_secs(5)).unwrap();
        {
            let files = vault
                .files
                .try_lock()
                .expect("diff must not hold the file lock");
            let mut docs = vault
                .documents
                .try_lock()
                .expect("diff must not hold the document lock");
            let states = docs.resident().unwrap();
            let a = states.iter().find(|s| s.path == "a.md").unwrap();
            docs.apply(
                &a.id,
                celestite_core::BufferCommand::Edit(Edit {
                    base: a.snapshot.version.clone(),
                    input: TextInput::Edits {
                        edits: vec![celestite_core::TextEdit {
                            from: 2,
                            to: 8,
                            insert: "MIDDLE".into(),
                        }],
                    },
                    origin: "local".into(),
                    group: None,
                    undo: UndoContext {
                        metadata: None,
                        positions: vec![],
                    },
                }),
            )
            .unwrap();
            let b = states.iter().find(|s| s.path == "b.md").unwrap();
            docs.apply(
                &b.id,
                celestite_core::BufferCommand::Edit(Edit {
                    base: b.snapshot.version.clone(),
                    input: TextInput::Edits {
                        edits: vec![celestite_core::TextEdit {
                            from: 5,
                            to: 5,
                            insert: " saved".into(),
                        }],
                    },
                    origin: "local".into(),
                    group: None,
                    undo: UndoContext {
                        metadata: None,
                        positions: vec![],
                    },
                }),
            )
            .unwrap();
            let version = docs.state(&files, &b.id).unwrap().snapshot.version;
            docs.save(&files, &b.id, version).unwrap();
        }
        resume.send(()).unwrap();
        worker.join().unwrap();
        let states = vault.documents.lock().unwrap().resident().unwrap();
        assert_eq!(
            states
                .iter()
                .find(|s| s.path == "a.md")
                .unwrap()
                .snapshot
                .text,
            "A1 MIDDLE B1"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("b.md")).unwrap(),
            "other saved"
        );
    }

    #[test]
    fn failure_is_published_without_losing_readable_history_and_manual_retry_commits() {
        let (root, _history, vault) = fixture();
        let mut subscription = vault.documents.lock().unwrap().subscribe().unwrap();
        std::fs::write(root.path().join("a.md"), "A1 middle B1").unwrap();
        observe_with(&vault, &AtomicBool::new(false), |task| {
            task.compute_with_budget(Duration::ZERO)
        })
        .unwrap();
        let mut events = vec![];
        while let Ok(event) = subscription.receiver.try_recv() {
            events.push(serde_json::to_value(event).unwrap());
        }
        let failed = events.last().unwrap()["documents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["path"] == "a.md")
            .unwrap();
        assert_eq!(failed["externalChange"]["phase"], "failed");
        assert_eq!(failed["externalChange"]["code"], "FilesystemDiffTimeout");
        assert_eq!(failed["available"], true);
        let id = failed["id"].as_str().unwrap();
        let mut docs = vault.documents.lock().unwrap();
        assert_eq!(
            docs.resident()
                .unwrap()
                .iter()
                .find(|s| s.id == id)
                .unwrap()
                .snapshot
                .text,
            "A middle B"
        );
        docs.reconcile().unwrap();
        assert!(!docs.has_file_observations());
        docs.retry_file_observation(id).unwrap();
        drop(docs);
        observe(&vault, &AtomicBool::new(false)).unwrap();
        let state = vault
            .documents
            .lock()
            .unwrap()
            .resident()
            .unwrap()
            .into_iter()
            .find(|s| s.id == id)
            .unwrap();
        assert_eq!(state.snapshot.text, "A1 middle B1");
        assert!(state.external_change.is_none());
    }

    #[test]
    fn rename_during_diff_discards_the_old_path_result_then_reconciles_the_new_path() {
        let (root, _history, vault) = fixture();
        std::fs::write(root.path().join("a.md"), "A1 middle B1").unwrap();
        let task = with_documents(&vault, |docs| {
            docs.reconcile()?;
            docs.take_file_observation()
        })
        .unwrap()
        .unwrap();
        let old = vault
            .documents
            .lock()
            .unwrap()
            .resident()
            .unwrap()
            .into_iter()
            .find(|s| s.path == "a.md")
            .unwrap();
        {
            let files = vault.files.lock().unwrap();
            vault
                .documents
                .lock()
                .unwrap()
                .rename(&files, "a.md", "renamed.md")
                .unwrap();
        }
        assert!(
            !with_documents(&vault, |docs| docs
                .complete_file_observation(task.compute()))
            .unwrap()
        );
        let interim = vault
            .documents
            .lock()
            .unwrap()
            .resident()
            .unwrap()
            .into_iter()
            .find(|s| s.id == old.id)
            .unwrap();
        assert_eq!(interim.snapshot, old.snapshot);
        assert_eq!(interim.path, "renamed.md");
        observe(&vault, &AtomicBool::new(false)).unwrap();
        let state = vault
            .documents
            .lock()
            .unwrap()
            .resident()
            .unwrap()
            .into_iter()
            .find(|s| s.id == old.id)
            .unwrap();
        assert_eq!(state.snapshot.text, "A1 middle B1");
    }

    #[tokio::test]
    async fn periodic_scan_repairs_missing_notifications_and_stop_joins_before_reopening_history() {
        let root = tempfile::tempdir().unwrap();
        let history = tempfile::tempdir().unwrap();
        let db = history.path().join("history.redb");
        std::fs::write(root.path().join("a.md"), "base").unwrap();
        let mut documents =
            Documents::open(Some(&db), root.path(), crate::HistoryMode::Initialize).unwrap();
        documents.reconcile().unwrap();
        let mut subscription = documents.subscribe().unwrap();
        let (trigger, receiver) = channel();
        // Intentionally never register this watcher: no notification can wake the worker.
        let watcher = notify::recommended_watcher(|_: notify::Result<notify::Event>| {}).unwrap();
        let events = broadcast::channel(128).0;
        let vault = Arc::new(HostedVault {
            id: documents.identity.id.clone(),
            name: "Notes".into(),
            read_only: false,
            packages: crate::package_resources::PackageResources::new(
                root.path().to_owned(),
                events.clone(),
            )
            .unwrap(),
            files: Mutex::new(FsVault::open(root.path()).unwrap()),
            documents: Mutex::new(documents),
            events,
            _watcher: Mutex::new(watcher),
            reconcile_trigger: trigger.clone(),
            reconciler: Mutex::new(None),
        });
        let mut worker = Reconciler::start_with_interval(
            Arc::downgrade(&vault),
            trigger,
            receiver,
            Duration::from_millis(60),
        )
        .unwrap();
        std::fs::write(root.path().join("a.md"), "missed notification").unwrap();
        let event = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let event = subscription.receiver.recv().await.unwrap();
                let json = serde_json::to_value(&event).unwrap();
                if json["documents"][0]["externalChange"].is_null() {
                    break event;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(event.kind, "changed");
        let state = vault
            .documents
            .lock()
            .unwrap()
            .resident()
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(state.snapshot.text, "missed notification");
        worker.stop();
        drop(vault);
        // No background commit or redb owner survives stop/drop.
        let mut recovered =
            Documents::open(Some(&db), root.path(), crate::HistoryMode::Recover).unwrap();
        recovered.reconcile().unwrap();
        assert_eq!(recovered.resident().unwrap()[0].snapshot, state.snapshot);
    }
}
