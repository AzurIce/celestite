//! Directory watches follow actual IO, never an enumeration of the Vault tree.
//!
//! Only this worker touches notify. Foreground registrations take priority over
//! restoration work, and neither the worker nor its callbacks borrow an editor.
use celestite_core::error::{EditorError, EditorResult, ErrorCode};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const RETRY_INTERVAL: Duration = Duration::from_secs(1);
const MAX_INVALIDATIONS: usize = 256;

#[derive(Default)]
struct Invalidations {
    all: bool,
    recreate_backend: bool,
    paths: BTreeSet<PathBuf>,
}

#[derive(Default)]
struct Shared {
    dirty: AtomicBool,
    stopped: AtomicBool,
    interests: Mutex<BTreeSet<PathBuf>>,
    invalidations: Mutex<Invalidations>,
    error: Mutex<Option<String>>,
}

impl Shared {
    fn error(&self, error: &EditorError) {
        self.dirty.store(true, Ordering::Release);
        *self.error.lock().unwrap_or_else(|error| error.into_inner()) =
            Some(format!("{}: {}", error.path, error.message));
    }

    fn event(&self, result: notify::Result<Event>, wake: &SyncSender<()>, root: &Path) {
        if self.stopped.load(Ordering::Acquire) {
            return;
        }
        let event = match result {
            Ok(event) if event.kind.is_access() => return,
            Ok(event) => event,
            Err(error) => {
                self.error(&watch_error(error, root));
                let mut invalidations = self
                    .invalidations
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                invalidations.all = true;
                invalidations.recreate_backend = true;
                let _ = wake.try_send(());
                return;
            }
        };
        let relevant = event.need_rescan()
            || event.paths.is_empty()
            || self
                .interests
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .iter()
                .any(|interest| {
                    event
                        .paths
                        .iter()
                        .any(|path| path.starts_with(interest) || interest.starts_with(path))
                });
        if !relevant {
            // The root's parent is an anchor, not a subscription to siblings.
            return;
        }
        self.dirty.store(true, Ordering::Release);
        if event.need_rescan()
            || matches!(
                event.kind,
                EventKind::Any
                    | EventKind::Other
                    | EventKind::Create(_)
                    | EventKind::Remove(_)
                    | EventKind::Modify(notify::event::ModifyKind::Name(_))
            )
        {
            let mut invalidations = self
                .invalidations
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if event.need_rescan() || event.paths.is_empty() {
                invalidations.all = true;
            } else {
                invalidations.paths.extend(event.paths);
                if invalidations.paths.len() > MAX_INVALIDATIONS {
                    invalidations.all = true;
                    invalidations.paths.clear();
                }
            }
            let _ = wake.try_send(());
        }
    }
}

struct Foreground {
    path: PathBuf,
    reply: mpsc::Sender<EditorResult<()>>,
}

/// Paths are absolute and already authorized by the caller. Directory creation
/// is observed through its nearest existing ancestor; a missing target is not an
/// error and the projection operation retains its own NotFound semantics.
pub(crate) struct WatchService {
    shared: Arc<Shared>,
    foreground: mpsc::Sender<Foreground>,
    background: mpsc::Sender<PathBuf>,
    wake: SyncSender<()>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl WatchService {
    pub(crate) fn new(root: PathBuf) -> EditorResult<Self> {
        validate_path(&root)?;
        let shared = Arc::new(Shared::default());
        shared
            .interests
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(root.clone());
        let (foreground, foreground_rx) = mpsc::channel();
        let (background, background_rx) = mpsc::channel();
        let (wake, wake_rx) = mpsc::sync_channel(1);
        let worker_shared = shared.clone();
        let worker_wake = wake.clone();
        let worker_root = root.clone();
        let thread = thread::Builder::new()
            .name("celestite-watch".into())
            .spawn(move || {
                Worker::new(worker_root, worker_shared, worker_wake).run(
                    foreground_rx,
                    background_rx,
                    wake_rx,
                );
            })
            .map_err(|error| io_error(error, &root))?;
        Ok(Self {
            shared,
            foreground,
            background,
            wake,
            thread: Mutex::new(Some(thread)),
        })
    }

    pub(crate) fn enqueue_directory(&self, path: &Path) -> EditorResult<()> {
        self.interest(path)?;
        self.background
            .send(path.to_owned())
            .map_err(|_| closed_error())?;
        let _ = self.wake.try_send(());
        Ok(())
    }

    pub(crate) fn enqueue_path(&self, path: &Path) -> EditorResult<()> {
        validate_path(path)?;
        let parent = path.parent().filter(|_| path.file_name().is_some());
        self.enqueue_directory(parent.ok_or_else(|| {
            EditorError::new(
                ErrorCode::InvalidPath,
                "Expected a file path",
                &path.display().to_string(),
            )
        })?)
    }

    pub(crate) fn ensure_directory(&self, path: &Path) -> EditorResult<()> {
        self.interest(path)?;
        let (reply, result) = mpsc::channel();
        self.foreground
            .send(Foreground {
                path: path.to_owned(),
                reply,
            })
            .map_err(|_| closed_error())?;
        let _ = self.wake.try_send(());
        result.recv().map_err(|_| closed_error())?
    }

    pub(crate) fn take_changes(&self) -> EditorResult<bool> {
        if self.shared.stopped.load(Ordering::Acquire) {
            return Err(closed_error());
        }
        // Recoverable watcher errors remain change hints. Killing the editor
        // session would prevent the user from saving while observation retries.
        Ok(self.shared.dirty.swap(false, Ordering::AcqRel))
    }

    pub(crate) fn stop(&self) {
        self.shared.stopped.store(true, Ordering::Release);
        let _ = self.wake.try_send(());
        // Keep the lock through join so concurrent stop calls also wait for
        // teardown. The worker never acquires this mutex.
        let mut thread = self
            .thread
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(thread) = thread.take()
            && thread.join().is_err()
        {
            eprintln!("Celestite file watcher worker stopped unexpectedly");
        }
    }

    fn interest(&self, path: &Path) -> EditorResult<()> {
        validate_path(path)?;
        if self.shared.stopped.load(Ordering::Acquire) {
            return Err(closed_error());
        }
        let inserted = self
            .shared
            .interests
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(path.to_owned());
        if inserted {
            // A new resource may reuse an existing ancestor OS registration.
            // Its earlier discovery reads still need one reconciliation hint.
            self.shared.dirty.store(true, Ordering::Release);
        }
        Ok(())
    }
}

impl Drop for WatchService {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(unix)]
#[derive(PartialEq, Eq)]
struct DirectoryIdentity {
    device: u64,
    inode: u64,
}

#[cfg(not(unix))]
type DirectoryIdentity = same_file::Handle;

fn directory_identity(path: &Path, metadata: &fs::Metadata) -> EditorResult<DirectoryIdentity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = path;
        Ok(DirectoryIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        same_file::Handle::from_path(path).map_err(|error| io_error(error, path))
    }
}

struct Worker {
    root: PathBuf,
    shared: Arc<Shared>,
    wake: SyncSender<()>,
    watcher: Option<RecommendedWatcher>,
    requested: BTreeSet<PathBuf>,
    watched: BTreeMap<PathBuf, DirectoryIdentity>,
    retry: BTreeSet<PathBuf>,
    last_error: Option<String>,
}

impl Worker {
    fn new(root: PathBuf, shared: Arc<Shared>, wake: SyncSender<()>) -> Self {
        Self {
            requested: BTreeSet::from([root.clone()]),
            retry: BTreeSet::from([root.clone()]),
            root,
            shared,
            wake,
            watcher: None,
            watched: BTreeMap::new(),
            last_error: None,
        }
    }

    fn run(
        mut self,
        foreground: Receiver<Foreground>,
        background: Receiver<PathBuf>,
        wake: Receiver<()>,
    ) {
        let mut next_retry = Instant::now();
        let mut pending = BTreeSet::new();
        let mut retry_round = VecDeque::new();
        while !self.shared.stopped.load(Ordering::Acquire) {
            if self.invalidate() {
                next_retry = Instant::now();
            }
            while let Ok(request) = foreground.try_recv() {
                if self.shared.stopped.load(Ordering::Acquire) {
                    let _ = request.reply.send(Err(closed_error()));
                    break;
                }
                let result = self.register(request.path);
                let _ = request.reply.send(result);
            }
            if self.shared.stopped.load(Ordering::Acquire) {
                break;
            }
            pending.extend(background.try_iter());
            // One restoration request per iteration lets interactive requests
            // pass a large resident-document restoration queue.
            if let Some(path) = pending.pop_first() {
                let _ = self.register(path);
            } else {
                if retry_round.is_empty() && Instant::now() >= next_retry {
                    retry_round.extend(self.retry.iter().cloned());
                    next_retry = Instant::now() + RETRY_INTERVAL;
                }
                if let Some(path) = retry_round.pop_front() {
                    let _ = self.register(path);
                }
            }
            self.log_error();
            if !pending.is_empty() || !retry_round.is_empty() {
                continue;
            }
            let timeout = next_retry.saturating_duration_since(Instant::now());
            let _ = wake.recv_timeout(timeout);
            if Instant::now() >= next_retry && self.retry.is_empty() {
                next_retry = Instant::now() + RETRY_INTERVAL;
            }
        }
        for request in foreground.try_iter() {
            let _ = request.reply.send(Err(closed_error()));
        }
        self.clear_watches();
        self.watcher = None;
    }

    fn register(&mut self, path: PathBuf) -> EditorResult<()> {
        self.requested.insert(path.clone());
        let result = self.register_inner(&path);
        self.finish_registration(path, result)
    }

    fn finish_registration(
        &mut self,
        path: PathBuf,
        result: EditorResult<bool>,
    ) -> EditorResult<()> {
        match &result {
            Ok(true) => {
                self.retry.remove(&path);
            }
            Ok(false) => {
                self.retry.insert(path.clone());
            }
            Err(error) => {
                self.retry.insert(path.clone());
                self.shared.error(error);
            }
        }
        match result {
            // Registration exhaustion/backend failures do not revoke file IO
            // permission. Retry and keep producing reconciliation hints; disk
            // reads and conditional saves remain available in the meantime.
            Err(error) if error.code == ErrorCode::Io => Ok(()),
            other => other.map(|_| ()),
        }
    }

    fn register_inner(&mut self, path: &Path) -> EditorResult<bool> {
        if self.watcher.is_none() {
            let shared = self.shared.clone();
            let wake = self.wake.clone();
            let root = self.root.clone();
            self.watcher = Some(
                RecommendedWatcher::new(
                    move |event| shared.event(event, &wake, &root),
                    Config::default().with_follow_symlinks(false),
                )
                .map_err(|error| watch_error(error, path))?,
            );
        }
        let existing = existing_directories(path)?;
        let target_exists = existing
            .last()
            .is_some_and(|(directory, _)| directory == path);
        let start = if path.starts_with(&self.root) {
            existing
                .iter()
                .position(|(directory, _)| directory == &self.root)
                .map(|index| index.saturating_sub(1))
                .unwrap_or_else(|| existing.len().saturating_sub(2))
        } else {
            // Explicit external package paths need ancestor anchors too. This
            // inspects only the path's components, never any sibling or child.
            0
        };
        let mut registered = false;
        for (directory, identity) in existing.into_iter().skip(start) {
            if self.watched.get(&directory) == Some(&identity) {
                continue;
            }
            self.unwatch(&directory);
            self.watcher
                .as_mut()
                .expect("watcher initialized")
                .watch(&directory, RecursiveMode::NonRecursive)
                .map_err(|error| watch_error(error, &directory))?;
            self.watched.insert(directory, identity);
            registered = true;
        }
        if registered {
            // Also closes the initialization/re-registration event window.
            self.shared.dirty.store(true, Ordering::Release);
        }
        Ok(target_exists)
    }

    fn invalidate(&mut self) -> bool {
        let invalidations = {
            let mut invalidations = self
                .shared
                .invalidations
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            std::mem::take(&mut *invalidations)
        };
        if !invalidations.all && invalidations.paths.is_empty() {
            return false;
        }
        let paths: Vec<_> = self
            .watched
            .keys()
            .filter(|path| {
                invalidations.all
                    || invalidations
                        .paths
                        .iter()
                        .any(|invalidated| path.starts_with(invalidated))
            })
            .cloned()
            .collect();
        for path in paths {
            self.unwatch(&path);
        }
        if invalidations.recreate_backend {
            self.watcher = None;
        }
        let retry: Vec<_> = self
            .requested
            .iter()
            .filter(|requested| {
                invalidations.all
                    || invalidations
                        .paths
                        .iter()
                        .any(|invalidated| requested.starts_with(invalidated))
            })
            .cloned()
            .collect();
        let needs_retry = !retry.is_empty();
        self.retry.extend(retry);
        needs_retry
    }

    fn unwatch(&mut self, path: &Path) {
        if self.watched.remove(path).is_none() {
            return;
        }
        if let Some(watcher) = &mut self.watcher
            && let Err(error) = watcher.unwatch(path)
            && !matches!(
                error.kind,
                notify::ErrorKind::WatchNotFound | notify::ErrorKind::PathNotFound
            )
        {
            self.shared.error(&watch_error(error, path));
        }
    }

    fn clear_watches(&mut self) {
        let paths: Vec<_> = self.watched.keys().cloned().collect();
        for path in paths {
            self.unwatch(&path);
        }
    }

    fn log_error(&mut self) {
        let error = self
            .shared
            .error
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(error) = error
            && self.last_error.as_ref() != Some(&error)
        {
            eprintln!("Celestite file watcher will retry: {error}");
            self.last_error = Some(error);
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.shared.stopped.store(true, Ordering::Release);
        self.shared.dirty.store(true, Ordering::Release);
    }
}

/// Validate every existing component without resolving links. notify's
/// follow_symlinks flag alone does not protect an explicitly supplied symlink.
fn existing_directories(path: &Path) -> EditorResult<Vec<(PathBuf, DirectoryIdentity)>> {
    let mut existing = Vec::new();
    let mut directory = PathBuf::new();
    for component in path.components() {
        directory.push(component);
        if !directory.is_absolute() {
            continue;
        }
        let metadata = match fs::symlink_metadata(&directory) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(io_error(error, &directory)),
        };
        if metadata.is_symlink() {
            return Err(EditorError::new(
                ErrorCode::Unsupported,
                "Following symbolic links is disabled",
                &directory.display().to_string(),
            ));
        }
        if !metadata.is_dir() {
            return Err(EditorError::new(
                ErrorCode::NotDirectory,
                "Expected a directory to watch",
                &directory.display().to_string(),
            ));
        }
        existing.push((
            directory.clone(),
            directory_identity(&directory, &metadata)?,
        ));
    }
    Ok(existing)
}

fn validate_path(path: &Path) -> EditorResult<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| component == Component::ParentDir)
    {
        return Err(EditorError::new(
            ErrorCode::InvalidPath,
            "Expected an absolute directory path without parent traversal",
            &path.display().to_string(),
        ));
    }
    Ok(())
}

fn closed_error() -> EditorError {
    EditorError::new(ErrorCode::Closed, "File watcher is stopped", "")
}

fn io_error(error: std::io::Error, path: &Path) -> EditorError {
    EditorError::new(
        match error.kind() {
            std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
            _ => ErrorCode::Io,
        },
        error.to_string(),
        &path.display().to_string(),
    )
}

fn watch_error(error: notify::Error, path: &Path) -> EditorError {
    EditorError::new(
        ErrorCode::Io,
        error.to_string(),
        &path.display().to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(directory: &tempfile::TempDir) -> PathBuf {
        directory.path().canonicalize().unwrap()
    }

    fn wait_for_change(service: &WatchService) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if service.take_changes().unwrap() {
                return;
            }
            assert!(Instant::now() < deadline, "expected a filesystem change");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn settle(service: &WatchService) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut quiet_since = Instant::now();
        loop {
            if service.take_changes().unwrap() {
                quiet_since = Instant::now();
            }
            if quiet_since.elapsed() >= Duration::from_millis(150) {
                return;
            }
            assert!(Instant::now() < deadline, "watcher did not become quiet");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn registration_only_visits_requested_ancestors_and_is_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let root = root(&directory);
        fs::create_dir_all(root.join("visited/nested")).unwrap();
        fs::create_dir_all(root.join("unvisited/deep/tree")).unwrap();
        let shared = Arc::new(Shared::default());
        let (wake, _receiver) = mpsc::sync_channel(1);
        let mut worker = Worker::new(root.clone(), shared.clone(), wake);
        worker.register(root.clone()).unwrap();
        assert_eq!(
            worker.watched.keys().cloned().collect::<BTreeSet<_>>(),
            BTreeSet::from([root.parent().unwrap().to_owned(), root.clone()])
        );
        worker.register(root.join("visited/nested")).unwrap();
        assert_eq!(worker.watched.len(), 4);
        assert!(worker.watched.contains_key(&root.join("visited")));
        assert!(worker.watched.contains_key(&root.join("visited/nested")));
        assert!(!worker.watched.contains_key(&root.join("unvisited")));
        assert!(shared.dirty.swap(false, Ordering::AcqRel));
        worker.register(root.join("visited/nested")).unwrap();
        assert!(!shared.dirty.load(Ordering::Acquire));
        worker.clear_watches();
    }

    #[test]
    fn a_new_interest_reconciles_discovery_even_when_its_os_anchor_already_exists() {
        let directory = tempfile::tempdir().unwrap();
        let parent = root(&directory);
        let child = parent.join("vault");
        fs::create_dir(&child).unwrap();
        let service = WatchService::new(child.clone()).unwrap();
        service.ensure_directory(&child).unwrap();
        settle(&service);
        // The parent is already an OS anchor, but its other entries were not
        // previously an observed resource. Their prior discovery needs a hint.
        service.ensure_directory(&parent).unwrap();
        assert!(service.take_changes().unwrap());
        service.ensure_directory(&parent).unwrap();
        assert!(!service.take_changes().unwrap());
    }

    #[test]
    fn a_backend_watch_failure_retries_without_revoking_file_access() {
        let directory = tempfile::tempdir().unwrap();
        let root = root(&directory);
        let shared = Arc::new(Shared::default());
        let (wake, _receiver) = mpsc::sync_channel(1);
        let mut worker = Worker::new(root.clone(), shared.clone(), wake);
        let failure = watch_error(
            notify::Error::generic("injected watch quota exhaustion"),
            &root,
        );
        worker
            .finish_registration(root.clone(), Err(failure))
            .unwrap();
        assert!(worker.retry.contains(&root));
        assert!(shared.dirty.load(Ordering::Acquire));
        // Authorization and filesystem path errors still fail the barrier.
        let failure = EditorError::new(ErrorCode::Unsupported, "symbolic link", "link");
        assert_eq!(
            worker
                .finish_registration(root, Err(failure))
                .unwrap_err()
                .code,
            ErrorCode::Unsupported
        );
    }

    #[test]
    fn missing_directory_recovers_without_foreground_registration() {
        let directory = tempfile::tempdir().unwrap();
        let root = root(&directory);
        let service = WatchService::new(root.clone()).unwrap();
        service.ensure_directory(&root.join("new/nested")).unwrap();
        wait_for_change(&service);
        fs::create_dir_all(root.join("new/nested")).unwrap();
        // Registration retries are independent of another UI read or event.
        thread::sleep(RETRY_INTERVAL + Duration::from_millis(200));
        settle(&service);
        fs::write(root.join("new/nested/file"), b"created after registration").unwrap();
        wait_for_change(&service);
    }

    #[test]
    fn directory_replacement_is_rebound_before_the_next_read() {
        let directory = tempfile::tempdir().unwrap();
        let root = root(&directory);
        fs::create_dir_all(root.join("a/b")).unwrap();
        let service = WatchService::new(root.clone()).unwrap();
        service.ensure_directory(&root.join("a/b")).unwrap();
        settle(&service);
        fs::rename(root.join("a"), root.join("old-a")).unwrap();
        fs::create_dir_all(root.join("a/b")).unwrap();
        service.ensure_directory(&root.join("a/b")).unwrap();
        settle(&service);
        fs::write(root.join("a/b/file"), b"new inode").unwrap();
        wait_for_change(&service);
        settle(&service);
        fs::write(root.join("old-a/b/file"), b"old inode").unwrap();
        thread::sleep(Duration::from_millis(150));
        assert!(!service.take_changes().unwrap());
    }

    #[test]
    fn root_parent_is_an_anchor_without_sibling_notifications() {
        let directory = tempfile::tempdir().unwrap();
        let parent = root(&directory);
        let root = parent.join("vault");
        fs::create_dir(&root).unwrap();
        let service = WatchService::new(root.clone()).unwrap();
        service.ensure_directory(&root).unwrap();
        settle(&service);
        fs::write(parent.join("sibling"), b"not in this Vault").unwrap();
        thread::sleep(Duration::from_millis(150));
        assert!(!service.take_changes().unwrap());
        fs::rename(&root, parent.join("old-vault")).unwrap();
        fs::create_dir(&root).unwrap();
        wait_for_change(&service);
        service.ensure_directory(&root).unwrap();
        settle(&service);
        fs::write(root.join("new-file"), b"replacement").unwrap();
        wait_for_change(&service);
    }

    #[cfg(unix)]
    #[test]
    fn explicit_and_ancestor_symlinks_are_rejected_without_scanning_targets() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let root = root(&directory);
        fs::create_dir_all(external.path().join("nested")).unwrap();
        symlink(external.path(), root.join("link")).unwrap();
        let service = WatchService::new(root.clone()).unwrap();
        service.ensure_directory(&root).unwrap();
        for path in [root.join("link"), root.join("link/nested")] {
            assert_eq!(
                service.ensure_directory(&path).unwrap_err().code,
                ErrorCode::Unsupported
            );
        }
    }

    #[test]
    fn background_failure_is_a_change_hint_and_foreground_failure_is_visible() {
        let directory = tempfile::tempdir().unwrap();
        let root = root(&directory);
        fs::write(root.join("file"), b"not a directory").unwrap();
        let service = WatchService::new(root.clone()).unwrap();
        service.enqueue_directory(&root.join("file")).unwrap();
        wait_for_change(&service);
        assert_eq!(
            service
                .ensure_directory(&root.join("file"))
                .unwrap_err()
                .code,
            ErrorCode::NotDirectory
        );
        // The change endpoint remains usable after a recoverable watch error.
        assert!(service.take_changes().is_ok());
    }

    #[test]
    fn stop_is_idempotent_and_foreground_waiters_finish() {
        let directory = tempfile::tempdir().unwrap();
        let root = root(&directory);
        let service = Arc::new(WatchService::new(root.clone()).unwrap());
        let readers: Vec<_> = (0..8)
            .map(|_| {
                let service = service.clone();
                let root = root.clone();
                thread::spawn(move || service.ensure_directory(&root))
            })
            .collect();
        service.stop();
        service.stop();
        for reader in readers {
            if let Err(error) = reader.join().unwrap() {
                assert_eq!(error.code, ErrorCode::Closed);
            }
        }
        assert!(service.thread.lock().unwrap().is_none());
        assert_eq!(
            service.ensure_directory(&root).unwrap_err().code,
            ErrorCode::Closed
        );
    }
}
