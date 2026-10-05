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

默认编译纯 Rust 库；`wasm` feature 在 `wasm32` target 导出异步 `EditorBinding`、`MemoryEditorBinding` 和底层 `DocumentBinding`。本地 Web Worker 通过 `EditorBinding` 构造 `EditorCore<BrowserBackend>`，浏览器 IO 桥只提供文件和私有存储读写；远端 Web Worker 通过 `MemoryEditorBinding` 构造 `EditorCore<MemoryBackend>`。server 构造同一内核类型的 `EditorCore<NativeBackend>`，访问普通目录并可配置 redb 历史存储。64 位 writer ID 在 JSON 中保持字符串。

## Backend 与服务接口

`Backend` 定义身份、时钟、历史加载、幂等提交、目录恢复意图及可选的普通文件 IO。`has_projection()` 决定实例是否映射普通目录；没有映射时，只提交私有历史，不报告普通文件已保存。异步方法不要求 `Send`，OPFS IO 可以留在 Worker 中；native 包装在阻塞任务中执行文件和 redb IO。

| 实现             | 历史存储                            | 普通文件映射            | 使用位置                              |
| ---------------- | ----------------------------------- | ----------------------- | ------------------------------------- |
| `BrowserBackend` | OPFS 私有历史目录                   | OPFS 或获授权的本机目录 | 本地 Web Vault                        |
| `MemoryBackend`  | Rust 内存集合，非持久化             | 无                      | 远端 Web 客户端、无头副本与同步调试器 |
| `NativeBackend`  | 可配置 redb；未配置时历史仅驻留内存 | 本机普通目录            | server host                           |

[`MemoryBackend`](src/memory.rs) 是公开的 `Backend` 实现，以 `BTreeMap<String, StoredDocument>` 保存文档头、初始 CRDT 快照与增量 journal。`commit()` 校验序号与重发内容后更新记录，`load()` 返回内存记录，`replace_volatile_documents()` 原子替换整批记录并清空增量。它的 `persistent()` 和 `has_projection()` 均为 `false`，文件与目录 IO 返回 `Unsupported`；编辑与撤销由 `EditorCore` 中的活动文档执行。后端随 core 释放，不跨 Worker 或进程重启保留数据。

core 提供类型化的 `open_file`、`read`、`edit` / `transact`、`undo`、`import`、`save`、`resolve`、`rename`、`remove` 等 Rust 方法，`execute_service(method, params)` 提供 Worker / IPC 可序列化入口。Web 包装只管理请求队列、事件序号、视图投影和定时器；自动保存延迟由 core 返回。

映射普通目录的实例可用 `ExternalChangePolicy::Merge` 协调外部修改。设置 `EditorOptions.defer_filesystem_diff = true` 后，`refresh` 只安排任务；平台通过 `take_file_observation()` 取得隔离历史分支，在锁外运行 `FileObservationTask::compute()`，再调用 `complete_file_observation()`。core 重读磁盘并校验文档身份、路径、基线与观察序号，允许协作历史在计算期间推进。未采用后台执行的独占 core 使用相同算法内联计算。

差异计算使用固定的行级 Myers 定位与变化区域内的 Unicode 字符级 Myers，共享 5 秒预算；超时拒绝整次观察，不接受粗替换退路。`externalChange` 报告 `pending` 或带错误码、消息及 `retryAt` 的 `failed` 状态；已提交历史保持可读，待完成 / 失败期间不自动写回。相同失败输入从 30 秒逐步退避到最多 5 分钟，新磁盘内容立即重新排队；`retry_file_observation` / `retry_observation` 支持显式重试。

编辑回复保留已接受的正文，即使历史提交失败；`persistenceError` 暂停后续修改，`retry_history` 重试提交。`durableVersion` 只确认本机历史；`savedVersion` 确认普通文件写回。保存按“历史 → 保存意图 → 条件写入 → 回执”执行；移动和删除也先记录恢复意图。恢复保留文档身份并重新分配 writer，个人撤销栈不持久化。

远端 Web Worker 使用 `EditorCore<MemoryBackend>`，从 host 完整快照加入历史，编辑、撤销和预览均在客户端 core 执行。`apply_host_state` 接受 host 的路径、已保存正文、磁盘版本与权限回执，要求回执的历史与版本已由客户端接受；只读限制同时作用于 core 和 UI。内存副本不报告本机持久化成功，远端普通文件只通过显式保存写回。`replace_replica_session` / `replica_session` 仅适用于非持久化、无文件映射的副本，整批验证快照、补齐增量、最终路径与删除状态后原子替换活动历史，并清空个人撤销；失败保留旧会话。`join_replica_document` / `replica_join` 在新文档加入时同时验证 host 元数据，删除记录不占用活动路径。只读和已删除副本仍可导入 host 已接受的历史，不能产生本地编辑。

`flush_history` 和 `close` 只处理历史提交；`flush` 仍执行普通文件保存。关闭远端视图或实例只释放会话，不能写回未打开的共享文档。共享保存失败只提供取消或重试保存，不复用独立实例的覆盖 / 丢弃动作。

host 的 `commit_replica` 在导入客户端快照前核对磁盘版本，再通过既有保存逻辑写回；覆盖动作选择客户端正文，丢弃动作以 host 最新文件为准。传输包装只负责认证、请求与回执，不复制编辑或文件冲突策略。

`tests/editor_backend.rs` 验证统一业务的故障恢复与服务契约；server 的 `headless_editor` 测试验证真实 HTTP / redb；Web 的编辑器回归验证 WASM / OPFS，包括旧日志兼容。实时单 host 协作、Catalog CRDT、Vim、Tree-sitter 和 LSP 按项目路线图继续推进。

## 预览计算与会话

`preview` feature 提供纯 Rust 的 `compute_preview(&PreviewTask)`，通过 Notist `Vault` 的资源接口加载配置与 package，执行配置中的 IR transforms，输出 HTML、源码映射、组件描述和跨文件诊断。工作区 `Cargo.toml` 中的两个 crate 使用 `https://github.com/AzurIce/notist.git` 的同一固定提交，由 Cargo 获取并通过 `Cargo.lock` 锁定；无需同级源码目录。默认编译不启用预览计算依赖，core 的会话和任务契约始终可用。Web 构建启用 `wasm,preview`，额外导出 `preview_resource_requests(taskJson)` 与 `render_preview(taskJson)`；该入口不创建 EditorCore、不打开 OPFS。

平台按以下顺序承载预览：

1. `subscribe_preview(document_id, client_session)` 返回订阅标识和状态；多个视图共享一个文档会话。平台填写自己的客户端会话身份。
2. `take_preview_events()` 取得合并后的状态事件；按 `dueAt` 在 Backend 时钟上设置计时器。首次订阅立即就绪，后续变化以 120 ms 防抖、500 ms 最长等待合并。
3. 到期调用 `take_preview_task(document_id)`，取得 core 原子生成的正文、版本、项目代次及非预览文档的未保存覆盖。同一文档已有运行任务或尚未到期时返回 `None`。
4. 调用 `preview_resource_requests`，由平台以只读 IO 补齐 `task.resources`，重复直到没有缺失资源；不存在的配置候选也保留查询结果。Notist 决定配置发现及 package 加载规则，平台不自行解析配置。任务的 `resourceRoot` 由宿主提供，文档 ticket 路径仍相对 Vault；Vault 内资源使用相对键，外部 package 使用绝对编译资源身份，宿主通过独立 package 通道读取。随后在独立执行器中调用 `compute_preview` 或 WASM `render_preview`，然后将 `PreviewCompletion` 交给 `complete_preview`。返回 `false` 表示结果过期、重复或任务已撤销；匹配的旧任务结束后仍需检查最新待处理任务。
5. 视图隐藏或关闭时 `unsubscribe_preview`；客户端断开时 `release_preview_client`。最后一个订阅释放会话及缓存，文档历史保留。

输入、撤销、导入、外部重载和路径变化会使目标任务失效。非预览文档的正文变化推进项目代次；平台在目录操作或外部文件通知后调用 `invalidate_preview_project()`，正文不变的旧任务同样不能被接受。任务标识在 core 重开和会话重建后不同；执行器仅回传任务标识，core 从自己的上下文恢复版本与路径。诊断区间已转换为任务正文的 UTF-16 范围，正文诊断定位前必须确认结果仍适用；跨文件诊断携带自己的路径和 LF 源码，平台打开目标后校验源码一致才定位。

计算或执行器失败通过 `PreviewOutcome::Failure` 返回，保留上一份显示结果，不自动重试。平台撤销旧执行器后调用 `retry_preview` 取得新代次。预览读取已接受正文，不依赖正文是否已保存或历史提交是否成功。

正文输入上限 5 MiB，Web 项目资源与未保存覆盖合计上限 32 MiB，组件目录快照上限 32 MiB，单份输出上限 16 MiB，core 缓存输出总量上限 64 MiB；输出容量包含 HTML、正文与失败诊断、源码映射和组件描述，超过限制时返回预览失败。最后一个订阅关闭后释放该文档的缓存。Web 执行器同时运行一个任务，30 秒未返回则终止并等待显式重试；运行旧任务期间只保留最新目标版本。

输出的 `sourceMap` 记录实际 HTML 元素的内部 `data-notist-node` 标识、UTF-16 源码区间及 `block` / `inline` / `container` 粒度。Notist renderer 开启 `with_source_map()` 后返回 UTF-8 字节范围，core 在同一次源码扫描中与诊断一起转换坐标；renderer 默认输出不变。映射与 HTML 共用结果 ticket，节点标识仅在当前任务内有效。core 不保存 DOM 坐标；Web 在当前映射上测量排版，并通过内容锚点进行双向定位与滚动跟随。

`preview_link(document_id, task_id, target)` 只接受当前就绪结果的链接，返回同文档片段、规范化的 Vault 内路径或允许的外部 URL。相对路径从任务中的文档目录出发，拒绝越出 Vault、无效编码及不允许的 URL scheme。

上述方法也有 `execute_service` 的 `preview_*` JSON 入口，字段与 Web 的 `web/src/lib/editor/preview/contract.ts` 对齐。默认 OPFS Vault 已接入独立 Worker 与预览 UI；后续阶段见 [路线图](../../docs/roadmap.md)。

```sh
cargo test -p celestite-core --features preview
cargo check -p celestite-core --target wasm32-unknown-unknown --features wasm,preview
```
