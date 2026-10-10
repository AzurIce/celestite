# Celestite core

Celestite 的统一 Rust 编辑器内核。`EditorCore<Backend>` 注入平台 IO，管理文档身份、CRDT、个人撤销、私有历史、文件保存、外部冲突与目录操作恢复。不依赖 HTTP、Solid 或 CodeMirror。

本文说明文档集合、Backend、服务适配与预览组合；模块导航、Rust / JSON 服务映射和平台接入流程统一维护在 [API 文档](../../docs/core.md)。目标架构与实施阶段分别见 [architecture](../../docs/architecture.md) 和 [roadmap](../../docs/roadmap.md)。

单份文本副本属于独立的 [`celestite-buffer`](../celestite-buffer/README.md)。它拥有正文、CRDT 历史、个人撤销、锚点、导入准入和精确修改效果，不拥有文件、持久化或网络。原生 walkthrough 位于 [`celestite-buffer/examples/buffer.rs`](../celestite-buffer/examples/buffer.rs)，运行 `cargo run --locked -p celestite-buffer --example buffer`。

## 原生模块边界

调用方使用实际所有者的路径，不通过根模块转导出类型：

- `celestite_buffer::Buffer` 与 `celestite_buffer::types`：单文本副本及其值类型。
- `celestite_buffer::codec`：版本与 peer 的规范编码，历史和网络共享同一表示。
- `celestite_core::editor`：`EditorCore`、构造选项与文档路径规则。
- `celestite_core::editor::types`：文档状态、历史提交和修改回执。
- `celestite_core::editor::observation` / `replica`：磁盘观察任务与副本接入契约。
- `celestite_core::backend` / `instance` / `source`：IO、身份和只读文档源；内存实现显式导入 `celestite_core::backend::memory::MemoryBackend`。
- `celestite_core::preview::sessions::PreviewController`：独立预览消费者。
- `celestite_core::protocol::buffer::BufferAdapter` / `protocol::editor::EditorAdapter`：外部消息适配，不是原生编辑 API。

```sh
cargo test -p celestite-core
cargo check -p celestite-core --target wasm32-unknown-unknown --features wasm
```

默认编译纯 Rust 库；`wasm` feature 在 `wasm32` target 导出异步 `EditorBinding`、`MemoryEditorBinding` 和底层 `BufferBinding`。本地 Web Worker 通过 `EditorBinding` 构造 `EditorCore<BrowserBackend>`，浏览器 IO 桥只提供文件和私有存储读写；远端 Web Worker 通过 `MemoryEditorBinding` 构造 `EditorCore<MemoryBackend>`。server 构造同一内核类型的 `EditorCore<NativeBackend>`，访问普通目录，CRDT 历史仅驻留内存。64 位 peer ID 在 JSON 中保持字符串。

`protocol::buffer::BufferAdapter` / `protocol::editor::EditorAdapter` 是外部薄壳：解码 JSON、检查消息基准版本、转换 UTF-16 坐标与撤销 metadata，然后调用原生方法。原生 EditorCore 不提供 JSON 服务分发或通用 `apply`。JSON 版本格式由 `celestite_buffer::codec` 集中保持 `{ identity, clocks }`，兼容历史存储与协作协议，不成为原生可变 clock map。

`BufferBinding` 持有 Buffer 与 BufferAdapter，`apply(commandJson)` 返回 UTF-16 协议效果；直接 `peer_id()` 是 JS `bigint`，`resolve_anchor()` 是 UTF-16 数字坐标。EditorBinding / MemoryEditorBinding 的 `call(method, paramsJson)` 异步返回 `{ status, value | error, mutations }`；即便文件 IO 最终失败，先前已接受的修改仍会随同返回。Worker 先消费 mutations，再处理命令结果。适配器在编码失败时保留原生回执供重试。

## Backend 与服务接口

`Backend` 定义身份、时钟、历史加载、幂等提交、目录恢复意图及可选的普通文件 IO。`has_projection()` 决定实例是否映射普通目录；没有映射时，只提交私有历史，不报告普通文件已保存。异步方法不要求 `Send`，OPFS IO 可以留在 Worker 中；native 包装在阻塞任务中执行文件 IO。

| 实现             | 历史存储                             | 普通文件映射            | 使用位置                              |
| ---------------- | ------------------------------------ | ----------------------- | ------------------------------------- |
| `BrowserBackend` | OPFS 私有历史目录                    | OPFS 或获授权的本机目录 | 本地 Web Vault                        |
| `MemoryBackend`  | Rust 内存集合，非持久化              | 无                      | 远端 Web 客户端、无头副本与同步调试器 |
| `NativeBackend`  | 无私有历史存储；活动 Buffer 驻留内存 | 本机普通目录            | server host                           |

[`MemoryBackend`](src/backend/memory.rs) 是公开的 `Backend` 实现，以 `BTreeMap<String, StoredDocument>` 保存文档头、初始 CRDT 快照与增量 journal。`commit()` 校验序号与重发内容后更新记录，`load()` 返回内存记录，`replace_volatile_documents()` 原子替换整批记录并清空增量。它的 `persistent()` 和 `has_projection()` 均为 `false`，文件与目录 IO 返回 `Unsupported`；编辑与撤销由 `EditorCore` 中的活动文档执行。后端随 core 释放，不跨 Worker 或进程重启保留数据。

[`backend/mod.rs`](src/backend/mod.rs) 定义 trait 与存储类型；[`backend/browser.rs`](src/backend/browser.rs) 提供浏览器实现。核心不提供根模块 reexport。

EditorCore 拥有活动 Buffer，提供 `edit(id, edits)`、`replace_text(id, text)`、`undo(id)`、`redo(id)`、`import(id, packet)` 等 `&mut self` 方法；需要历史 IO 时使用异步方法，借用关系不变。它们返回原生 `EditorMutation`，共用历史登记与派生状态更新管线。只有准入失败返回错误；已接受修改的历史提交结果单独表达为 `HistoryCommit::Committed` 或 `Failed`。网络确认和文件保存通过 `require_committed()` 检查提交状态，不能把提交失败误判成文本未修改。

所有活动 Buffer 的结果经同一个流程登记历史、更新派生状态并发布。运行时在每次命令后调用 `take_mutations()` 取走批次；WASM 的 `call` 自动执行该步骤。Rust 返回值和批次共享同一回执，重试历史 IO 不产生第二次文本修改。`open_file`、`read`、`save`、`resolve`、`rename`、`remove` 等负责文档集合与文件业务，不另建编辑历史。

`open_file` 按需创建或复用 Buffer；`list` 和 `reconcile_files` 只核对已加载记录，不扫描其他文件建立 CRDT。文件发现由目录元数据接口承担。server 重启生成新的历史身份，打开文件时从当前磁盘字节建立历史，未写回的正文和操作意图不跨重启保留。

Web 使用同一处理层消费 Buffer 结果、维护版本化视图映射并交付命令回复 / 外部变化。远端只发送结果中的本地操作包，不在编辑或撤销后另行导出；本机目录不从前后字符串重新猜测差异。视图端按输入时间和显式 Vim 会话选择组 ID，core 不解释 UI 命令名称。

映射普通目录的实例可用 `ExternalChangePolicy::Merge` 协调外部修改。设置 `EditorOptions.defer_filesystem_diff = true` 后，`refresh` 只安排任务；平台通过 `take_file_observation()` 取得隔离历史分支，在锁外运行 `FileObservationTask::compute()`，再调用 `complete_file_observation()`。core 重读磁盘并校验文档身份、路径、基线与观察序号，允许协作历史在计算期间推进。未采用后台执行的独占 core 使用相同算法内联计算。

差异计算使用固定的行级 Myers 定位与变化区域内的 Unicode 字符级 Myers，共享 5 秒预算；超时拒绝整次观察，不接受粗替换退路。`externalChange` 报告 `pending` 或带错误码、消息及 `retryAt` 的 `failed` 状态；已提交历史保持可读，待完成 / 失败期间不自动写回。相同失败输入从 30 秒逐步退避到最多 5 分钟，新磁盘内容立即重新排队；`retry_file_observation` / `retry_observation` 支持显式重试。

编辑回复保留已接受的正文，即使历史提交失败；`persistenceError` 暂停后续修改，`retry_history` 重试提交。`persistedVersion` 只确认本机历史提交，不承诺 fsync；`savedVersion` 确认普通文件写回。保存按“历史 → 保存意图 → 条件写入 → 回执”执行；移动和删除也先记录恢复意图。恢复保留文档身份并重新分配 peer，个人撤销栈不持久化。

远端 Web Worker 使用 `EditorCore<MemoryBackend>`，从 host 完整快照加入历史，编辑、撤销和预览均在客户端 core 执行。`apply_host_state` 接受 host 的路径、已保存正文、磁盘版本与权限回执，要求回执的历史与版本已由客户端接受；只读限制同时作用于 core 和 UI。内存副本不报告本机持久化成功，远端普通文件只通过显式保存写回。`replace_replica_session` / `replica_session` 仅适用于非持久化、无文件映射的副本，整批验证快照、补齐增量、最终路径与删除状态后原子替换活动历史，并清空个人撤销；失败保留旧会话。`join_replica_document` / `replica_join` 在新文档加入时同时验证 host 元数据，删除记录不占用活动路径。只读和已删除副本仍可导入 host 已接受的历史，不能产生本地编辑。

`flush_history` 和 `close` 只处理历史提交；`flush` 仍执行普通文件保存。关闭远端视图或实例只释放会话，不能写回未打开的共享文档。共享保存失败只提供取消或重试保存，不复用独立实例的覆盖 / 丢弃动作。

host 的更新准入绑定连接分配的 peer 和因果依赖，文件保存等待显式的正文版本。`release_replica_document` 保留客户端 Buffer 与撤销并释放活动路径；重新加入通过 host 元数据恢复活动状态。完整会话替换以活动订阅为目录，失败保留旧会话。

网络协议仍为 v3：server 边界保留 legacy-wire `writerId`、`durableVersion`、`backendRevision` 和 `snapshot.revision`；Web transport 将它们规范化为内部新名。这只是兼容拼写，不是双模型；JSON history packet、Version 的 identity / clocks 与 Loro bytes 均不变。

`tests/editor_backend.rs` 验证统一业务的故障恢复与服务契约；server 的 `headless_editor` 测试验证真实 HTTP、内存历史和普通文件保存；Web 的编辑器回归验证 WASM / OPFS，包括旧日志兼容。后续阶段见项目路线图。

## 预览计算与会话

`preview` feature 提供纯 Rust 的 `compute_preview(&PreviewTask)`，通过 Notist `Vault` 的资源接口加载配置与 package，执行配置中的 IR transforms，输出 HTML、源码映射、组件描述和跨文件诊断。工作区 `Cargo.toml` 中的两个 crate 使用 `https://github.com/AzurIce/notist.git` 的同一固定提交，由 Cargo 获取并通过 `Cargo.lock` 锁定；无需同级源码目录。默认编译不启用预览计算依赖，core 的会话和任务契约始终可用。Web 构建启用 `wasm,preview`，额外导出 `preview_resource_requests(task)` 与 `render_preview(task)`；两者直接接收普通 JS 对象并返回资源请求数组或 `PreviewCompletion`，不创建 EditorCore、不打开 OPFS。

`wasm` feature 使用 `tsify 0.5.8` 生成预览值、`DocumentIdentity` 和版本协议形状的 TypeScript 声明，构建时随 wasm-bindgen 一起输出。`Ts<T>` 只传递 JS 数据句柄，函数内部显式反序列化并报告失败；不采用已弃用的隐式 ABI 转换。map 为普通对象，缺失的 Option 输出 `null`，字节保持 `number[]`；Serde 缺省字段在生成声明中可选。原生 Version 仍是不透明共享向量，协议结构不暴露 Loro 内部表示。

对象入口承载 core 发出的合法文本快照，不是任意 JavaScript 值与旧 JSON 解码器的等价替代。JS / WASM 字符串转换会将未配对的 UTF-16 surrogate 替换为 U+FFFD；生产任务来自 Rust 字符串，不包含这类输入。若以后将入口用于不受信任的任意 JS 任务，应另行确定 Unicode 拒绝契约，不能在转换后拒绝合法的 U+FFFD 文本。

平台按以下顺序承载预览：

1. 创建独立的 `PreviewController`，同步 `editor.document_source(&[])` 的活动目录。源只含身份、路径、版本与会话 `epoch`，不读取或保留另一份正文。
2. `subscribe(document_id, client_session, now)` 返回订阅标识和状态；多个视图共享一个文档会话。控制器的 `take_events()` 提供合并、连续编号的状态。平台按 `dueAt` 设置计时器；首次立即就绪，后续 120 ms 防抖、500 ms 最长等待。
3. 到期用 `required_snapshots(id)` 选择目标与声明 ID，通过 `editor.document_source(&ids)` 原子捕获目录及不可变正文，再调用 `take_task(id, &source, now)`。捕获与目录不符则拒绝为 `StaleVersion`，不占用计算槽；尚未到期或已有任务时返回 `None`。源也可以直接由 standalone Buffer 或其他只读文档提供者构造。
4. `preview_resource_requests` 驱动只读资源补齐，再由独立执行器调用 `compute_preview` / `render_preview`。回报前先同步最新源，再调用控制器的 `complete`；旧任务返回 false。Web 的同步消费回调与源读取共用 core 队列边界，不能在读取与接受之间插入整批替换。计算及资源 IO 不持有这个边界。
5. 视图关闭用 `unsubscribe`，客户端断开用 `release_client`；消费者退出时 `clear` / 释放绑定。Editor 的 `close` 只完成历史提交，不管理消费者。

控制器根据只读目录变化协调正文、路径和未保存声明版本；资源写入或通知由组合层调用 `invalidate_project`。整批源替换推进 `epoch`，即使版本与路径相同也撤销旧任务，同时保留当前订阅与待更新的旧结果。Editor 对象重开时，组合所有者重建或显式重置消费者。诊断区间仍为任务正文的 UTF-16 范围，定位前确认结果适用。

计算或执行器失败通过 `PreviewOutcome::Failure` 返回，保留上一份显示结果，不自动重试。平台撤销旧执行器后调用 `retry_preview` 取得新代次。预览读取已接受正文，不依赖正文是否已保存或历史提交是否成功。

正文输入上限 5 MiB，Web 项目资源与未保存覆盖合计上限 32 MiB，组件目录快照上限 32 MiB，单份输出上限 16 MiB，core 缓存输出总量上限 64 MiB；输出容量包含 HTML、正文与失败诊断、源码映射和组件描述，超过限制时返回预览失败。最后一个订阅关闭后释放该文档的缓存。Web 执行器同时运行一个任务，30 秒未返回则终止并等待显式重试；运行旧任务期间只保留最新目标版本。

输出的 `sourceMap` 记录实际 HTML 元素的内部 `data-notist-node` 标识、UTF-16 源码区间及 `block` / `inline` / `container` 粒度。Notist renderer 开启 `with_source_map()` 后返回 UTF-8 字节范围，core 在同一次源码扫描中与诊断一起转换坐标；renderer 默认输出不变。映射与 HTML 共用结果 ticket，节点标识仅在当前任务内有效。core 不保存 DOM 坐标；Web 在当前映射上测量排版，并通过内容锚点进行双向定位与滚动跟随。

控制器的 `link(document_id, task_id, target)` 只接受当前就绪结果的链接，返回同文档片段、规范化的 Vault 内路径或允许的外部 URL。相对路径从任务中的文档目录出发，拒绝越出 Vault、无效编码及不允许的 URL scheme。

WASM `PreviewBinding` 独立持有上述控制器，直接使用生成的类型化对象；`EditorAdapter` 不再提供 `preview_*` 分发。Web `lib/preview` 在工作区组合层消费只读源与资源能力。Notist 原始分析及语义环境是未来语言查询的共享边界，预览转换与 HTML 渲染是派生分支；本轮不建立增量分析器或完整 IR 的跨 Worker 缓存。后续阶段见 [路线图](../../docs/roadmap.md)。

```sh
cargo test -p celestite-core --features preview
cargo check -p celestite-core --target wasm32-unknown-unknown --features wasm,preview
```
