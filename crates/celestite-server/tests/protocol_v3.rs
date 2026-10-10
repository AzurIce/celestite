//! Regression coverage for v3's historical JSON spellings, not core's API names.
mod support;
use serde_json::{json, Value};
use support::Host;

fn assert_v3_document(document: &Value) {
    for key in ["writerId", "durableVersion", "backendRevision"] {
        assert!(document.get(key).is_some(), "missing {key}: {document}");
    }
    for key in ["peerId", "persistedVersion", "fileRevision"] {
        assert!(document.get(key).is_none(), "leaked {key}: {document}");
    }
    assert!(document["writerId"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .is_ok());
    assert!(document["snapshot"]["revision"].as_u64().is_some());
    assert!(document["snapshot"].get("stateRevision").is_none());
}

#[tokio::test]
async fn http_open_state_and_batch_documents_keep_v3_json() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.md"), "A😀B").unwrap();
    let host = Host::start(root.path(), false).await;
    let opened = host
        .json("POST", "/documents/open", json!({"path":"a.md"}))
        .await;
    assert_v3_document(&opened);
    let id = opened["id"].as_str().unwrap();
    let state = host
        .json("GET", &format!("/documents/{id}"), Value::Null)
        .await;
    assert_v3_document(&state);
    assert_eq!(state, opened);
    let batch = host.json("GET", "/documents", Value::Null).await;
    assert_eq!(batch.as_array().unwrap().len(), 1);
    assert_v3_document(&batch[0]);
    assert_eq!(batch[0], state);
    assert_eq!(state["snapshot"]["text"], "A😀B");
    assert!(state["durableVersion"].is_null());
    host.stop().await;
}
