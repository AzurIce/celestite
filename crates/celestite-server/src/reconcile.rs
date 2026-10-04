//! Filesystem notifications are hints. A bounded wakeup coalesces bursts, and a
//! periodic full observation repairs missed events without running IO in notify's callback.
use crate::{vault::fs::ChangeHint, HostedVault};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Weak,
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
                if let Err(error) = observe(&vault) {
                    tracing::error!(vault_id = %vault.id, code = %error.code, message = %error.message, "Background file reconciliation failed");
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

fn observe(vault: &HostedVault) -> crate::vault::fs::Result<()> {
    // Match every HTTP document/file operation's lock order.
    let _files = vault
        .files
        .lock()
        .map_err(|_| crate::vault::fs::VaultError::new("IO", "Vault lock failed", ""))?;
    let mut documents = vault
        .documents
        .lock()
        .map_err(|_| crate::vault::fs::VaultError::new("IO", "Document lock failed", ""))?;
    let result = documents.reconcile();
    // Also publish failures: a previously usable document can now require recovery.
    if documents.publish_changes()? {
        let _ = vault.events.send(ChangeHint::all());
        tracing::debug!(vault_id = %vault.id, "Background document states changed");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{documents::Documents, fs::FsVault};
    use std::sync::Mutex;
    use tokio::sync::broadcast;

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
        let vault = Arc::new(HostedVault {
            id: "notes".into(),
            name: "Notes".into(),
            read_only: false,
            files: Mutex::new(FsVault::open(root.path()).unwrap()),
            documents: Mutex::new(documents),
            events: broadcast::channel(128).0,
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
        let event = tokio::time::timeout(Duration::from_secs(5), subscription.receiver.recv())
            .await
            .unwrap()
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
