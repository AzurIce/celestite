//! Protocol v3 keeps its historical field spellings at the encoding boundary.
//! Core remains the only document model; history identity, clocks and bytes are
//! never rewritten here.
use celestite_core::editor::types::{EditorDocument, HostDocument};
use serde_json::Value;

pub(crate) fn editor_document(document: &EditorDocument) -> Value {
    legacy_document(serde_json::to_value(document).expect("editor document serializes"))
}

pub(crate) fn host_document(document: &HostDocument) -> Value {
    legacy_document(serde_json::to_value(document).expect("host document serializes"))
}

fn legacy_document(mut value: Value) -> Value {
    rename(&mut value, "peerId", "writerId");
    rename(&mut value, "persistedVersion", "durableVersion");
    rename(&mut value, "fileRevision", "backendRevision");
    if let Some(snapshot) = value.get_mut("snapshot") {
        rename(snapshot, "stateRevision", "revision");
    }
    value
}

fn rename(value: &mut Value, canonical: &str, legacy: &str) {
    let object = value
        .as_object_mut()
        .expect("document metadata is an object");
    if let Some(value) = object.remove(canonical) {
        object.insert(legacy.into(), value);
    }
}

#[cfg(test)]
mod tests {
    use super::{editor_document, host_document};
    use crate::vault::documents::Documents;
    use serde_json::{json, Value};

    // Compare the entire serialized model after reversing only v3's spellings.
    // This catches accidentally dropped content, causal progress or metadata.
    fn assert_equivalent(mut wire: Value, canonical: Value) {
        for (old, new) in [
            ("writerId", "peerId"),
            ("durableVersion", "persistedVersion"),
            ("backendRevision", "fileRevision"),
        ] {
            assert!(wire.get(new).is_none(), "{wire}");
            if let Some(value) = wire.as_object_mut().unwrap().remove(old) {
                wire[new] = value;
            }
        }
        if let Some(snapshot) = wire.get_mut("snapshot") {
            assert!(snapshot.get("stateRevision").is_none());
            let revision = snapshot
                .as_object_mut()
                .unwrap()
                .remove("revision")
                .unwrap();
            snapshot["stateRevision"] = revision;
        }
        assert_eq!(wire, canonical);
    }

    #[test]
    fn v3_editor_and_host_encoding_preserves_the_real_models() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.md"), "A😀B").unwrap();
        let mut documents = Documents::open(root.path(), &[0; 32]).unwrap();
        let id = documents.open_file("a.md").unwrap();
        documents.edit(&id, [(1..1, "中文")]).unwrap();
        let mut document = documents.state(&id).unwrap();
        document.peer_id = u64::MAX - 1;
        document.snapshot.state_revision = 123;
        document.persisted_version = Some(document.snapshot.version.clone());
        let wire = editor_document(&document);
        assert_eq!(wire["writerId"], "18446744073709551614");
        assert_eq!(wire["snapshot"]["revision"], 123);
        assert_eq!(wire["snapshot"]["text"], "A中文😀B");
        assert_equivalent(wire, serde_json::to_value(&document).unwrap());

        for include_saved in [false, true] {
            let known = (!include_saved).then_some(document.file_revision.as_str());
            let mut host = documents.host_document(&id, known).unwrap();
            host.status.persisted_version = Some(host.status.version.clone());
            let wire = host_document(&host);
            assert_eq!(wire["durableVersion"], json!(host.status.version));
            assert_eq!(wire.get("savedContent").is_some(), include_saved);
            assert_equivalent(wire, serde_json::to_value(&host).unwrap());
        }
    }
}
