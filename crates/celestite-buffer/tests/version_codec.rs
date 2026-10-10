use celestite_buffer::{
    Buffer,
    codec::peer_id,
    types::{DocumentIdentity, Version},
};
use serde::{Deserialize, Serialize};

fn identity() -> DocumentIdentity {
    DocumentIdentity {
        document_id: "doc".into(),
        history_id: "history".into(),
    }
}

#[test]
fn precise_peer_json_and_binary_round_trips_use_the_same_version() {
    // Loro reserves u64::MAX internally; its highest admitted peer ID is MAX - 1.
    for peer in [9_007_199_254_740_993, u64::MAX - 1] {
        let buffer = Buffer::with_peer_id(identity(), peer, "hello").unwrap();
        let version = buffer.version();
        let json = serde_json::to_string(&version).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "identity": {"document_id": "doc", "history_id": "history"},
                "clocks": {peer.to_string(): version.clock(peer)},
            })
        );
        assert_eq!(serde_json::from_str::<Version>(&json).unwrap(), version);
        assert_eq!(
            Version::decode(identity(), &version.encode().unwrap()).unwrap(),
            version
        );
    }
}

#[test]
fn malformed_noncanonical_duplicate_and_nonpositive_clocks_are_rejected() {
    for clocks in [
        r#"{"01":1}"#,
        r#"{"":1}"#,
        r#"{"-1":1}"#,
        r#"{"+1":1}"#,
        r#"{" 1":1}"#,
        r#"{"18446744073709551616":1}"#,
        r#"{"1":1,"1":2}"#,
        r#"{"1":1,"01":2}"#,
        r#"{"1":0}"#,
        r#"{"1":-1}"#,
        r#"{"1":2147483648}"#,
        r#"{"1":1.5}"#,
        r#"{"1":"1"}"#,
        r#"[]"#,
    ] {
        let json = format!(
            r#"{{"identity":{{"document_id":"doc","history_id":"history"}},"clocks":{clocks}}}"#
        );
        assert!(serde_json::from_str::<Version>(&json).is_err(), "{json}");
    }
}

#[test]
fn empty_identity_is_rejected_by_json_and_binary_decoders() {
    let bytes = Buffer::new(identity(), "text")
        .unwrap()
        .version()
        .encode()
        .unwrap();
    for identity in [
        DocumentIdentity {
            document_id: String::new(),
            history_id: "history".into(),
        },
        DocumentIdentity {
            document_id: "doc".into(),
            history_id: String::new(),
        },
    ] {
        let json = serde_json::json!({"identity": identity, "clocks": {}});
        assert!(serde_json::from_value::<Version>(json).is_err());
        assert!(Version::decode(identity, &bytes).is_err());
    }
    let empty: Version = serde_json::from_value(serde_json::json!({
        "identity": identity(), "clocks": {},
    }))
    .unwrap();
    assert_eq!(empty.iter().count(), 0);
}

#[test]
fn peer_field_codec_is_precision_safe_and_canonical() {
    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Peer {
        #[serde(with = "peer_id")]
        peer: u64,
    }
    let peer = Peer { peer: u64::MAX };
    let json = serde_json::to_string(&peer).unwrap();
    assert_eq!(json, r#"{"peer":"18446744073709551615"}"#);
    assert_eq!(serde_json::from_str::<Peer>(&json).unwrap(), peer);
    for invalid in ["01", "+1", "1.0", " 1", "-1", "18446744073709551616"] {
        assert!(peer_id::parse(invalid).is_err());
        assert!(serde_json::from_value::<Peer>(serde_json::json!({"peer": invalid})).is_err());
    }
    assert_eq!(peer_id::parse("0"), Ok(0));
    assert!(serde_json::from_str::<Peer>(r#"{"peer":1}"#).is_err());
}
