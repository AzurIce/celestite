//! The sole decimal-map codec for native causal versions.
use crate::types::{DocumentIdentity, Version};
use loro::VersionVector;
use serde::{
    Deserialize, Deserializer, Serialize, Serializer,
    de::{Error, MapAccess, Visitor},
    ser::SerializeMap,
};
use std::{collections::BTreeSet, fmt};

struct Clocks<'a>(&'a Version);
impl Serialize for Clocks<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut clocks: Vec<_> = self.0.iter().collect();
        clocks.sort_by_key(|(peer, _)| peer.to_string());
        let mut map = serializer.serialize_map(Some(clocks.len()))?;
        for (peer, count) in clocks {
            map.serialize_entry(&peer.to_string(), &count)?;
        }
        map.end()
    }
}

/// The encoded shape, not the opaque native vector. Serialization and
/// generated preview contracts use this same declaration.
#[derive(Serialize)]
#[serde(rename = "Version")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(rename = "Version", missing_as_null, hashmap_as_object)
)]
struct WireVersion<'a> {
    identity: &'a DocumentIdentity,
    #[cfg_attr(feature = "wasm", tsify(type = "Record<string, number>"))]
    clocks: Clocks<'a>,
}

impl Serialize for Version {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        WireVersion {
            identity: self.identity(),
            clocks: Clocks(self),
        }
        .serialize(serializer)
    }
}

struct ClockVector(VersionVector);
impl<'de> Deserialize<'de> for ClockVector {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ClockVisitor;
        impl<'de> Visitor<'de> for ClockVisitor {
            type Value = ClockVector;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a decimal peer map with positive causal counts")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut vector = VersionVector::default();
                let mut seen = BTreeSet::new();
                while let Some((key, count)) = map.next_entry::<String, i32>()? {
                    let peer = super::peer_id::parse(&key).map_err(A::Error::custom)?;
                    if count <= 0 || !seen.insert(peer) {
                        return Err(A::Error::custom("invalid or duplicate causal clock"));
                    }
                    vector.insert(peer, count);
                }
                Ok(ClockVector(vector))
            }
        }
        deserializer.deserialize_map(ClockVisitor)
    }
}

impl<'de> Deserialize<'de> for Version {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Wire {
            identity: DocumentIdentity,
            clocks: ClockVector,
        }
        let wire = Wire::deserialize(deserializer)?;
        Version::from_vector(wire.identity, wire.clocks.0).map_err(D::Error::custom)
    }
}
