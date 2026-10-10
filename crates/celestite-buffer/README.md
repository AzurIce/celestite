# celestite-buffer

A synchronous, single-owner collaborative text replica built on Loro. Buffer
owns text history, validated edits, stable anchors, personal undo and atomic
import admission. It does not own files, observation timers, persistence,
transport, UI state or a WASM runtime.

## Native use

```rust
use celestite_buffer::{Buffer, types::DocumentIdentity};

let mut buffer = Buffer::new(
    DocumentIdentity {
        document_id: "notes/draft".into(),
        history_id: "history-1".into(),
    },
    "hello",
)?;
let update = buffer.edit([(5..5, " world")])?;
// Apply update.edits to the owner's display; persist or transmit update.operation.
# Ok::<(), celestite_buffer::types::BufferError>(())
```

Create a history once; other replicas join its exported snapshot rather than
recreating it from text. Generated peer IDs come from `new_peer_id()`.
Explicit peer IDs remain subject to history admission and collision checks.
Use `Buffer::with_peer_id` or `Buffer::from_snapshot_with_peer_id` only when
the caller can guarantee uniqueness; `Buffer::peer_id()` reads the local ID.
Run the complete walkthrough with
`cargo run --locked -p celestite-buffer --example buffer`.

## Interface ownership

- Root: `Buffer` and `new_peer_id()`, without type re-export barrels.
- `types`: identities, versions, snapshots, edits, receipts, packets, anchors,
  options, undo context/state, import previews and `BufferError`.
- `history::PreparedImport`: read-only admission tied to one unchanged Buffer.
- `positions::ToOffset`: UTF-8 byte positions and stable anchor resolution.
- `text::{difference, utf16_to_byte}`: display deltas and coordinate conversion.
- `codec::peer_id`: canonical decimal peer parsing and serde field encoding.
- `change::TextChangeTask`: an isolated historical text rewrite, constructed only
  through `Buffer::prepare_text_change`. Callers provide the time budget.
  Fixed Myers alignment either completes or returns `BufferError::DiffTimeout`;
  computing a change never mutates the live Buffer. Import its returned packet
  explicitly. `historical_text` validates history identity and exact causal state.

`TextSnapshot::state_revision` counts local Buffer state changes, including
imports and personal undo state. It is not a file revision or causal `Version`.
Snapshot JSON outputs `stateRevision` and accepts legacy `revision` input.
`HistoryPacket` retains the `identity`/`kind`/`data` envelope and the `snapshot`
and `updates` kind values. Peer errors use native `u64` IDs in Rust while retaining
legacy JSON error codes and precision-safe decimal `peer` strings.

`Version` JSON is `{identity, clocks}` with canonical decimal-string peer keys
and positive causal counts. Binary versions require an explicit validated
identity when decoded. Native vectors, Loro documents, undo internals and
branch construction remain private.

Loro is pinned to `1.16.2` and Similar to `2.7.0`. Diff alignment preserves
the original algorithm's tie-breaking, not only the final text or edit cost:
changing which repeated character survives changes CRDT identities and anchors.
Dependency upgrades require separate alignment and persisted-history validation.

Default features are native-only. Optional `wasm` enables TypeScript declarations
from the same serialized contract; it does not add a second Buffer implementation.
