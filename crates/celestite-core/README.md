# Celestite core

Celestite 的宿主无关 Rust 编辑器内核。不依赖 HTTP、磁盘路径、浏览器或 UI。

当前实现一个 `LoroText("source")` 文本文档，固定 `loro = 1.16.2`，从归档 Notist `refactor` 的文档内核与契约测试迁入。它提供：

- 先完整验证、再提交的 UTF-16 编辑事务与因果版本检查。
- 完整快照和增量交换、乱序 / 重复更新、文档和历史身份校验。
- 插入亲和性的锚点，以及保留远端修改的本地撤销 / 重做。
- 显式撤销组、全部撤销位置转换、不参与 CRDT 的宿主元数据。
- 操作结束后排队交付的变更事件，不在 CRDT 提交中回调宿主。

```rust
use celestite_core::{Document, DocumentIdentity, TextEdit, Transaction};

let mut document = Document::new(
    DocumentIdentity { document_id: "file-1".into(), history_id: "history-1".into() },
    None,
    "hello",
)?;
document.transact(Transaction {
    expected_version: document.version(),
    origin: "headless".into(),
    edits: vec![TextEdit { from: 5, to: 5, insert: " world".into() }],
    undo_metadata: None,
    undo_positions: vec![],
})?;
assert_eq!(document.snapshot().text, "hello world");
# Ok::<(), celestite_core::CoreError>(())
```

一个逻辑文档只创建一次历史，其他副本通过 `Document::from_snapshot` 加入，使用新的 writer。独立地用相同初始字符串创建两个文档不会建立共同历史。writer ID 是当前内核实例的身份；恢复时使用新 writer，撤销栈不随 CRDT 历史持久化。`revision` 仅在当前实例内递增，跨实例比较使用 `Version`。

```sh
cargo test -p celestite-core
cargo check -p celestite-core --target wasm32-unknown-unknown --features wasm
```

默认编译纯 Rust 库；`wasm` feature 仅在 `wasm32` target 导出薄 `DocumentBinding`，同一 crate 同时输出 `rlib` / `cdylib`。WASM 使用 JSON 接口、二进制版本辅助接口和显式 `take_events()`，64 位 writer ID 在 JSON 中保持字符串。

server 已使用此内核提供真实 HTTP 编辑、同步包交换、redb 日志恢复和文件写回，可运行 `cargo test -p celestite-server --test headless_editor` 验证。目录 Catalog CRDT、Vault 同步调度、Vim、Tree-sitter 和 LSP 仍待实现。
