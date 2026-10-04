# Celestite core

Celestite 的统一 Rust 编辑器内核。`EditorCore<Backend>` 注入平台 IO，管理文档身份、CRDT、个人撤销、私有历史、文件保存、外部冲突与目录操作恢复。不依赖 HTTP、Solid 或 CodeMirror。

下层 `Document` 使用 `LoroText("source")`，固定 `loro = 1.16.2`，提供：

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

默认编译纯 Rust 库；`wasm` feature 在 `wasm32` target 导出异步 `EditorBinding` 和底层 `DocumentBinding`。Web Worker 构造 `EditorCore<OpfsBackend>`，浏览器 IO 桥只提供文件和私有存储读写。server 构造同类型的 `EditorCore<NativeBackend>`，使用普通目录与 redb。64 位 writer ID 在 JSON 中保持字符串。

## Backend 与服务接口

`Backend` 定义身份、时钟、历史加载、幂等提交、目录恢复意图及可选的普通文件 IO。`has_projection()` 决定实例是否映射普通目录；没有映射时，只提交私有历史，不报告普通文件已保存。异步方法不要求 `Send`，OPFS IO 可以留在 Worker 中；native 包装在阻塞任务中执行文件和 redb IO。

core 提供类型化的 `open_file`、`read`、`edit` / `transact`、`undo`、`import`、`save`、`resolve`、`rename`、`remove` 等 Rust 方法，`execute_service(method, params)` 提供 Worker / IPC 可序列化入口。Web 包装只管理请求队列、事件序号、视图投影和定时器；自动保存延迟由 core 返回。

编辑回复保留已接受的正文，即使历史提交失败；`persistenceError` 暂停后续修改，`retry_history` 重试提交。`durableVersion` 只确认本机历史；`savedVersion` 确认普通文件写回。保存按“历史 → 保存意图 → 条件写入 → 回执”执行；移动和删除也先记录恢复意图。恢复保留文档身份并重新分配 writer，个人撤销栈不持久化。

`tests/editor_backend.rs` 验证统一业务的故障恢复与服务契约；server 的 `headless_editor` 测试验证真实 HTTP / redb；Web 的编辑器回归验证 WASM / OPFS，包括旧日志兼容。实时单 host 协作、Catalog CRDT、Vim、Tree-sitter 和 LSP 按项目路线图继续推进。
