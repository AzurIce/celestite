//! Precision-safe peer identities at serialization boundaries.
use serde::{Deserialize, Deserializer, Serializer, de::Error};

pub fn parse(value: &str) -> Result<u64, &'static str> {
    let peer = value
        .parse::<u64>()
        .map_err(|_| "invalid decimal peer id")?;
    if peer.to_string() != value {
        return Err("noncanonical decimal peer id");
    }
    Ok(peer)
}

pub fn serialize<S: Serializer>(peer: &u64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&peer.to_string())
}

pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    parse(&String::deserialize(deserializer)?).map_err(D::Error::custom)
}
