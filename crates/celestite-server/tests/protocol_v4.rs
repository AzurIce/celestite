//! Wire regression for the v4 document shape.
mod support;
use serde_json::{json, Value};
use support::Host;

fn assert_v4_document(document: &Value) {
    for key in ["version", "peerId", "persistedVersion", "fileRevision"] {
        assert!(document.get(key).is_some(), "missing {key}: {document}");
    }
    for key in ["writerId", "durableVersion", "backendRevision"] {
        assert!(document.get(key).is_none(), "leaked {key}: {document}");
    }
    assert!(document["peerId"].as_str().unwrap().parse::<u64>().is_ok());
    // The nested v3 snapshot carried its own version; v4 has one top-level version.
    assert!(document["snapshot"].get("version").is_none());
    assert!(document["snapshot"].get("revision").is_none());
    assert!(document["snapshot"]["stateRevision"].as_u64().is_some());
}

#[tokio::test]
async fn http_open_state_and_batch_documents_use_v4_json() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "A😀B").unwrap();
    let host = Host::start(root.path(), false).await;
    let opened = host
        .json("POST", "/documents/open", json!({"path":"a.md"}))
        .await;
    assert_v4_document(&opened);
    let id = opened["id"].as_str().unwrap();
    let state = host
        .json("GET", &format!("/documents/{id}"), Value::Null)
        .await;
    assert_v4_document(&state);
    assert_eq!(state, opened);
    let batch = host.json("GET", "/documents", Value::Null).await;
    assert_eq!(batch.as_array().unwrap().len(), 1);
    assert_v4_document(&batch[0]);
    assert_eq!(batch[0], state);
    assert_eq!(state["snapshot"]["text"], "A😀B");
    assert!(state["persistedVersion"].is_null());
    host.stop().await;
}
