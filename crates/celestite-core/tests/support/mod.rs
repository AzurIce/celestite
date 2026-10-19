#![allow(dead_code)]

use celestite_core::{
    error::{EditorError, EditorResult, ErrorCode},
    fs::{EntryKind, FileEntry, FileSnapshot, FileSystem, WriteMode},
    instance::{InstanceIdentity, Vault},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    hash::{Hash, Hasher},
    sync::{Arc, Mutex},
};

pub fn identity() -> InstanceIdentity {
    InstanceIdentity {
        instance_id: "test-instance".into(),
        vault: Vault {
            vault_id: "vault".into(),
            history_id: "session".into(),
        },
    }
}

fn error(code: ErrorCode, message: &str, path: &str) -> EditorError {
    EditorError::new(code, message, path)
}
pub fn revision(bytes: &[u8]) -> String {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hash);
    format!("{:016x}", hash.finish())
}

#[derive(Clone, Copy, Default)]
pub enum WriteFault {
    #[default]
    None,
    Before,
    Untouched,
    After,
    Reverted,
}

#[derive(Default)]
pub struct State {
    pub files: BTreeMap<String, Vec<u8>>,
    pub directories: BTreeSet<String>,
    pub writes: usize,
    pub write_paths: Vec<String>,
    pub fail_writes: bool,
    pub fail_write_number: Option<usize>,
    pub write_fault: WriteFault,
}

/// A real scoped file map; projection and recovery use independent instances.
#[derive(Clone, Default)]
pub struct TestFs {
    pub state: Arc<Mutex<State>>,
}
impl TestFs {
    pub fn with_file(path: &str, bytes: impl AsRef<[u8]>) -> Self {
        let files = Self::default();
        files.put(path, bytes);
        files
    }
    pub fn put(&self, path: &str, bytes: impl AsRef<[u8]>) {
        let mut state = self.state.lock().unwrap();
        let mut parent = path;
        while let Some((directory, _)) = parent.rsplit_once('/') {
            state.directories.insert(directory.into());
            parent = directory;
        }
        state.files.insert(path.into(), bytes.as_ref().into());
    }
    pub fn bytes(&self, path: &str) -> Vec<u8> {
        self.state.lock().unwrap().files[path].clone()
    }
    pub fn json(&self, path: &str) -> serde_json::Value {
        serde_json::from_slice(&self.bytes(path)).unwrap()
    }
    pub fn writes(&self) -> usize {
        self.state.lock().unwrap().writes
    }
    pub fn fail_writes(&self, fail: bool) {
        self.state.lock().unwrap().fail_writes = fail;
    }
    pub fn files(&self) -> BTreeMap<String, Vec<u8>> {
        self.state.lock().unwrap().files.clone()
    }
    pub fn fault(&self, fault: WriteFault) {
        self.state.lock().unwrap().write_fault = fault;
    }
}

fn stat(state: &State, path: &str) -> Option<FileEntry> {
    let kind = if state.files.contains_key(path) {
        EntryKind::File
    } else if path.is_empty() || state.directories.contains(path) {
        EntryKind::Directory
    } else {
        return None;
    };
    Some(FileEntry {
        path: path.into(),
        kind,
        size: state.files.get(path).map(|bytes| bytes.len() as u64),
        modified_at: None,
    })
}
impl FileSystem for TestFs {
    async fn stat(&self, path: &str) -> EditorResult<Option<FileEntry>> {
        Ok(stat(&self.state.lock().unwrap(), path))
    }
    async fn read_dir(&self, path: &str) -> EditorResult<Vec<FileEntry>> {
        let state = self.state.lock().unwrap();
        match stat(&state, path) {
            Some(entry) if entry.kind == EntryKind::Directory => {}
            Some(_) => return Err(error(ErrorCode::NotDirectory, "not a directory", path)),
            None => return Err(error(ErrorCode::NotFound, "missing directory", path)),
        }
        let prefix = if path.is_empty() {
            String::new()
        } else {
            format!("{path}/")
        };
        let paths: BTreeSet<_> = state
            .files
            .keys()
            .chain(state.directories.iter())
            .filter(|child| {
                child.starts_with(&prefix)
                    && !child[prefix.len()..].is_empty()
                    && !child[prefix.len()..].contains('/')
            })
            .cloned()
            .collect();
        Ok(paths
            .into_iter()
            .filter_map(|path| stat(&state, &path))
            .collect())
    }
    async fn read_file(&self, path: &str, limit: Option<u64>) -> EditorResult<FileSnapshot> {
        let state = self.state.lock().unwrap();
        let bytes = state
            .files
            .get(path)
            .ok_or_else(|| error(ErrorCode::NotFound, "missing file", path))?;
        if limit.is_some_and(|limit| bytes.len() as u64 > limit) {
            return Err(error(
                ErrorCode::Unsupported,
                "file exceeds read limit",
                path,
            ));
        }
        Ok(FileSnapshot {
            data: bytes.clone(),
            revision: revision(bytes),
        })
    }
    async fn write_file(
        &self,
        path: &str,
        data: &[u8],
        mode: WriteMode,
        expected: Option<&str>,
    ) -> EditorResult<String> {
        let mut state = self.state.lock().unwrap();
        state.writes += 1;
        state.write_paths.push(path.into());
        if state.fail_writes || state.fail_write_number == Some(state.writes) {
            let mut failure = error(ErrorCode::Io, "injected write failure", path);
            failure.write_not_started = true;
            return Err(failure);
        }
        let previous = state.files.get(path).cloned();
        if mode == WriteMode::Create && previous.is_some() {
            return Err(error(ErrorCode::AlreadyExists, "file exists", path));
        }
        if mode == WriteMode::Replace && previous.is_none() {
            return Err(error(ErrorCode::NotFound, "missing file", path));
        }
        if expected
            .is_some_and(|expected| previous.as_deref().map(revision).as_deref() != Some(expected))
        {
            return Err(error(ErrorCode::Conflict, "changed on disk", path));
        }
        match state.write_fault {
            WriteFault::Before | WriteFault::Untouched => {
                let mut failure = error(ErrorCode::Io, "injected projection failure", path);
                failure.write_not_started = matches!(state.write_fault, WriteFault::Untouched);
                return Err(failure);
            }
            _ => {}
        }
        state.files.insert(path.into(), data.into());
        if matches!(state.write_fault, WriteFault::After | WriteFault::Reverted) {
            if matches!(state.write_fault, WriteFault::Reverted) {
                match previous {
                    Some(bytes) => {
                        state.files.insert(path.into(), bytes);
                    }
                    None => {
                        state.files.remove(path);
                    }
                }
            }
            return Err(error(ErrorCode::Io, "projection outcome unknown", path));
        }
        Ok(revision(data))
    }
    async fn mkdir(&self, path: &str, recursive: bool) -> EditorResult<()> {
        let mut state = self.state.lock().unwrap();
        if state.files.contains_key(path) {
            return Err(error(
                ErrorCode::NotDirectory,
                "file at directory path",
                path,
            ));
        }
        if !recursive
            && path.rsplit_once('/').is_some_and(|(parent, _)| {
                !parent.is_empty() && !state.directories.contains(parent)
            })
        {
            return Err(error(ErrorCode::NotFound, "missing parent", path));
        }
        let mut parent = path;
        state.directories.insert(parent.into());
        if recursive {
            while let Some((directory, _)) = parent.rsplit_once('/') {
                state.directories.insert(directory.into());
                parent = directory;
            }
        }
        Ok(())
    }
    async fn rename(&self, from: &str, to: &str) -> EditorResult<()> {
        let mut state = self.state.lock().unwrap();
        if stat(&state, from).is_none() {
            return Err(error(ErrorCode::NotFound, "missing source", from));
        }
        if from == to {
            return Ok(());
        }
        if stat(&state, to).is_some() {
            return Err(error(ErrorCode::AlreadyExists, "target exists", to));
        }
        let prefix = format!("{from}/");
        let files: Vec<_> = state
            .files
            .keys()
            .filter(|path| path.as_str() == from || path.starts_with(&prefix))
            .cloned()
            .collect();
        for path in files {
            let data = state.files.remove(&path).unwrap();
            state
                .files
                .insert(format!("{to}{}", &path[from.len()..]), data);
        }
        let directories: Vec<_> = state
            .directories
            .iter()
            .filter(|path| path.as_str() == from || path.starts_with(&prefix))
            .cloned()
            .collect();
        for path in directories {
            state.directories.remove(&path);
            state
                .directories
                .insert(format!("{to}{}", &path[from.len()..]));
        }
        Ok(())
    }
    async fn remove(&self, path: &str, recursive: bool) -> EditorResult<()> {
        let mut state = self.state.lock().unwrap();
        let Some(entry) = stat(&state, path) else {
            return Err(error(ErrorCode::NotFound, "missing path", path));
        };
        let prefix = format!("{path}/");
        if entry.kind == EntryKind::Directory
            && !recursive
            && state
                .files
                .keys()
                .chain(state.directories.iter())
                .any(|child| child.starts_with(&prefix))
        {
            return Err(error(
                ErrorCode::DirectoryNotEmpty,
                "directory not empty",
                path,
            ));
        }
        state
            .files
            .retain(|child, _| child != path && !child.starts_with(&prefix));
        state
            .directories
            .retain(|child| child != path && !child.starts_with(&prefix));
        Ok(())
    }
}
