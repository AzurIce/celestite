# Celestite core

Celestite 的统一 Rust 编辑器内核。`EditorCore` 显式接收实例身份、普通文件空间及可选私有恢复空间，管理文档身份、内存 CRDT、个人撤销、文件保存、明文草稿恢复和外部协调。不依赖 HTTP、Solid 或 CodeMirror。

模块导航、Rust / JSON 服务映射和平台接入流程统一维护在 [API 文档](../../docs/core.md)。目标架构与实施阶段分别见 [architecture](../../docs/architecture.md) 和 [roadmap](../../docs/roadmap.md)。

单份文本副本属于独立的 [`celestite-buffer`](../celestite-buffer/README.md)。它拥有内存正文、CRDT 历史、个人撤销、锚点、导入准入和精确修改效果，不拥有文件、持久化或网络。原生 walkthrough 位于 [`celestite-buffer/examples/buffer.rs`](../celestite-buffer/examples/buffer.rs)，运行 `cargo run --locked -p celestite-buffer --example buffer`。

## 原生模块边界

调用方使用实际所有者的路径，不通过根模块转导出类型：

- `celestite_buffer::Buffer` 与 `celestite_buffer::types`：单文本副本及其值类型。
- `celestite_buffer::codec`：版本与 peer 的规范编码，历史包和网络共享同一表示。
- `celestite_core::editor`：`EditorCore` 与构造选项；相对路径校验由 `celestite_core::fs::validate_path` 提供。
- `celestite_core::editor::types`：文档状态和修改回执。
- `celestite_core::editor::observation` / `replica`：磁盘观察任务与副本接入契约。
- `celestite_core::fs::FileSystem`、`instance` 与 `source`：纯文件 IO、实例身份和只读文档源。
- `celestite_core::fs::native::FsVault` 与 `preview::native`：本机文件操作及独立 package 授权。
- `celestite_core::preview::sessions::PreviewController`：独立预览消费者。
- `celestite_core::protocol::buffer::BufferAdapter` / `protocol::editor::EditorAdapter`：外部消息适配，不是原生编辑 API。

```sh
cargo test -p celestite-core
cargo test -p celestite-core --features native,preview
cargo check -p celestite-core --target wasm32-unknown-unknown --features wasm
```

core 默认使用支持 JS 目标的 UUID v4 分配文档 ID，并用 `web-time` 提供 epoch 毫秒时钟；这两者是跨平台内核依赖。`native` feature 仅在非 Wasm 目标启用 `cap-std`、`same-file`、`blake3` 和 `rustix`，提供本机 FileSystem；同时启用 `preview` 时提供 `preview::native` 的本机 package 授权。

`wasm` feature 在 `wasm32` target 导出 `EditorBinding` 和底层 `BufferBinding`。本地 Worker 调用 `EditorBinding.open(identity, io, recoveryIo, mergeExternal)`：普通文件与私有恢复区是两个独立的基础函数桥，均由 `createBrowserIo(backend)` 创建。远端 Worker 调用同一绑定的 `EditorBinding.memory(identity)`，直接在内存持有 Buffer，无文件空间或恢复区。原生纯内存调用使用同步 `EditorCore::memory(identity)`，无需指定文件系统泛型；纯内存模式不提供文件树，文件操作和保存返回 `Unsupported`，不安排自动保存。桌面由根应用库的 [`runtime`](../../src/runtime/mod.rs) 模块承载 native core，并为普通文件 IO 添加观察边界。server 复用同一内核与本机 FileSystem，协作历史只驻留内存。桌面开发与验证见[桌面文档](../../docs/desktop.md)。

`BufferAdapter` / `EditorAdapter` 解码 JSON、检查消息基准版本、转换 UTF-16 坐标与撤销 metadata，然后调用原生方法。原生 EditorCore 不提供 JSON 服务分发或通用 `apply`。版本由 `celestite_buffer::codec` 集中编码为 `{ identity, clocks }`；64 位 peer 在 JSON 中保持十进制字符串，直接 WASM getter 为 `bigint`。

EditorBinding 的 `call(method, paramsJson)` 异步返回 `{ status, value | error, mutations }`。即便文件 IO 最终失败，先前已接受的修改仍随批次返回。Worker 先消费 mutations，再处理命令结果；适配器在编码失败时保留回执供重试。

## FileSystem、明文恢复与服务接口

FileSystem 只提供字节读取、内容 revision、create / replace 条件写入、目录枚举与目录操作。普通文件空间和私有恢复空间使用同一契约的独立实例；平台不解释 CRDT 或恢复格式，不提供历史 load / commit、身份、熵源或时钟服务。异步方法不要求 `Send`，OPFS IO 可以留在 Worker；native 包装在阻塞任务中执行文件 IO。

| 实例        | 普通文件空间             | 私有恢复空间       |
| ----------- | ------------------------ | ------------------ |
| 本地 Web    | OPFS 或获授权的本机目录  | 独立 OPFS 实例目录 |
| Tauri 本地  | 默认库或本机目录         | 应用私有目录       |
| server host | 托管本机目录             | 无                 |
| 远端 client | 无；文件请求由 host 执行 | 无                 |

宿主保留稳定 instanceId / vaultId，每次运行建立新的 historyId。文档 ID 和默认 epoch 毫秒时钟由 core 提供；`EditorOptions.clock` 只供确定性测试覆盖。浏览器的 `OpfsInstanceStore` 仅提供稳定 profile 和私有文件空间。

core 将明文草稿、磁盘字节基线与 revision、删除状态及待完成写入意图写入 `recovery/{UUID-key}.json`。记录不保存文档 ID、CRDT bytes、版本向量或撤销栈；目录意图另存 `directory-intent.json`。恢复从明文和基线建立新 Buffer，不延续旧历史身份或个人撤销。`recovery-format.json` 标记旧私有 CRDT 数据的一次性明文迁移；旧文件保留只读，不再写入。

EditorCore 拥有活动 Buffer，提供同步 `edit`、`replace_text`、`undo`、`redo`、`import` 及副本接入等 `&mut self` 方法；只有文件或恢复 IO 需要异步。修改返回原生 `EditorMutation`，只包含文档状态和 Buffer 修改效果，不附历史提交状态。所有修改共用同一效果接纳与派生状态更新管线；每次命令后 `take_mutations()` 取走批次，WASM 自动完成此步骤。

正文接受不等待恢复 IO，首次待写起 500ms 内合并明文 checkpoint，连续输入不延后该期限；保存、移动、删除和关闭强制排空。checkpoint 尝试全部文档与目录意图，单个失败不阻止后续材料写入；本轮自动计时均停止，首个失败通过 `recoveryError` 报告，正文保留且后续编辑继续。`checkpoint` 重试当前恢复材料，不重复执行编辑；`close` 完成 checkpoint 后才允许释放 owner，失败可以重试。`flush` 仍保存普通文件。`savedVersion` 只确认普通文件写回，host 确认只表示共同历史已在进程内存接受。

保存先协调外部修改；有恢复区时在条件写盘前记录明文与写回意图，写盘后更新基线及 checkpoint。结果不确定时保留意图和证据；移动、删除也先记录操作意图。`open_file` 按需创建或复用 Buffer；目录发现和驻留文档核对不扫描其他文件建立 CRDT。server 重启后从实际打开的文件建立新历史，未写回正文不跨重启保留。

`ExternalChangePolicy::Merge` 使用当前运行内的磁盘历史隔离分支合入外部修改。`defer_filesystem_diff` 允许平台在锁外运行 `FileObservationTask::compute()`，core 重新核对磁盘、文档身份、路径、基线与观察序号后接受结果。行级定位与 Unicode 字符级 Myers 共用固定预算，失败不降级为粗替换。`externalChange` 报告 pending / failed，相同失败输入退避重试，磁盘变化或显式重试立即重新排队；协调期间正文可读，自动写回暂停。

远端副本从 host 快照加入内存历史，只上传 Buffer 结果中的本地操作。`apply_host_state` 接受已由客户端因果历史包含的路径、保存基线和权限回执。`replace_replica_session` 整批验证快照、最终路径和删除状态后原子替换活动会话并清空个人撤销；失败保留旧会话。`release_replica_document` 释放活动路径及预览需求，保留同会话 Buffer、writer 与撤销缓存。远端关闭不隐式保存共享文件，共享保存失败只提供取消或重试。

网络协议为 v5，文档使用 `peerId`、`fileRevision`、`stateRevision`、`recoveryError`，读取模型的顶层只有一个 `version`，`snapshot` 仅含 `{ text, stateRevision }`。CRDT 历史包及 Version 的 identity / clocks 表示保持不变；协议不提供 CRDT 持久化版本或能力声明。

测试在规则所属层验证正文接受、明文恢复失败、写回证据、重启身份、会话替换和平台接线。当前契约见 [API 文档](../../docs/core.md)，验收标准见项目路线图。

## 预览计算与会话

`preview` feature 提供纯 Rust 的 `compute_preview(&PreviewTask)`，通过 Notist `Vault` 的资源接口加载配置与导入模块，执行配置中的文档扩展，输出 HTML、源码映射、组件描述和跨文件诊断。Web / WASM 宿主只启用内置 `replace` 扩展；native 使用 `compute_preview_native` 暴露真实配置路径，因此配置中的 `command` 扩展可在真实项目目录运行。资源发现和 package 授权会移除 `command` 扩展，避免准备只读快照时启动用户进程。工作区 `Cargo.toml` 中的两个 crate 使用 `https://github.com/AzurIce/notist.git` 的同一固定提交，由 Cargo 获取并通过 `Cargo.lock` 锁定；无需同级源码目录。默认编译不启用预览计算依赖，core 的会话和任务契约始终可用。Web 构建启用 `wasm,preview,language`，导出对象式预览入口与 `LanguageBinding`；不创建 EditorCore、不打开 OPFS。

`language` feature 提供独立的 `LanguageService`，接受无头 LSP JSON-RPC 消息，覆盖诊断、悬停、定义与文档符号。宿主用 `handle` / `provide` 驱动资源回填，并在资源变化时失效缓存；`ResourceContext` 同时供预览与语言读取使用，携带已接受正文和打开文档覆盖。文档查询使用稳定的 `file:///vault/…` URI，真实资源根由宿主传入；外部读取复用 native / HTTP 的授权和观察边界。语言端点不拥有编辑状态，补全与格式化待上游提供能力。

`wasm` feature 使用 `tsify 0.5.8` 生成预览值、`DocumentIdentity` 和版本协议形状的 TypeScript 声明，构建时随 wasm-bindgen 一起输出。`Ts<T>` 只传递 JS 数据句柄，函数内部显式反序列化并报告失败；不采用已弃用的隐式 ABI 转换。map 为普通对象，缺失的 Option 输出 `null`，字节保持 `number[]`；Serde 缺省字段在生成声明中可选。原生 Version 仍是不透明共享向量，协议结构不暴露 Loro 内部表示。

对象入口承载 core 发出的合法文本快照，不是任意 JavaScript 值与旧 JSON 解码器的等价替代。JS / WASM 字符串转换会将未配对的 UTF-16 surrogate 替换为 U+FFFD；生产任务来自 Rust 字符串，不包含这类输入。若以后将入口用于不受信任的任意 JS 任务，应另行确定 Unicode 拒绝契约，不能在转换后拒绝合法的 U+FFFD 文本。

平台按以下顺序承载预览：

1. 创建独立的 `PreviewController`，同步 `editor.document_source(&[])` 的活动目录。源只含身份、路径、版本与会话 `epoch`，不读取或保留另一份正文。
2. `subscribe(document_id, client_session, now)` 返回订阅标识和状态；多个视图共享一个文档会话。控制器的 `take_events()` 提供合并、连续编号的状态。平台按 `dueAt` 设置计时器；首次立即就绪，后续 120 ms 防抖、500 ms 最长等待。
3. 到期用 `required_snapshots(id)` 选择目标与声明 ID，通过 `editor.document_source(&ids)` 原子捕获目录及不可变正文，再调用 `take_task(id, &source, now)`。捕获与目录不符则拒绝为 `StaleVersion`，不占用计算槽；尚未到期或已有任务时返回 `None`。源也可以直接由 standalone Buffer 或其他只读文档提供者构造。
4. `preview_resource_requests` 驱动只读资源补齐，再由独立执行器调用 `compute_preview` / `compute_preview_native`。回报前先同步最新源，再调用控制器的 `complete`；旧任务返回 false。Web 的同步消费回调与源读取共用 core 队列边界，不能在读取与接受之间插入整批替换。计算及资源 IO 不持有这个边界。
5. 视图关闭用 `unsubscribe`，客户端断开用 `release_client`；消费者退出时 `clear` / 释放绑定。Editor 的 `close` 只完成明文恢复 checkpoint，不管理消费者。

控制器根据只读目录变化协调正文、路径和未保存声明版本；资源写入或通知由组合层调用 `invalidate_project`。整批源替换推进 `epoch`，即使版本与路径相同也撤销旧任务，同时保留当前订阅与待更新的旧结果。Editor 对象重开时，组合所有者重建或显式重置消费者。诊断区间仍为任务正文的 UTF-16 范围，定位前确认结果适用。

计算或执行器失败通过 `PreviewOutcome::Failure` 返回，保留上一份显示结果，不自动重试。平台撤销旧执行器后调用 `retry_preview` 取得新代次。预览读取已接受正文，不依赖正文是否已保存或明文 checkpoint 是否成功。

正文输入上限为规范 LF UTF-8 的 5 MiB；物理文本字节另容纳 CRLF 与 BOM，读取上限为 `MAX_FILE_BYTES = 2 * MAX_TEXT_BYTES + 3`，解码后仍检查正文上限。保存、恢复与外部合并沿用同一规则。Web 项目资源与未保存覆盖合计上限 32 MiB，组件目录快照上限 32 MiB，单份输出上限 16 MiB，core 缓存输出总量上限 64 MiB；输出容量包含 HTML、正文与失败诊断、源码映射和组件描述，超过限制时返回预览失败。最后一个订阅关闭后释放该文档的缓存。Web 执行器同时运行一个任务，30 秒未返回则终止并等待显式重试；运行旧任务期间只保留最新目标版本。

输出的 `sourceMap` 记录实际 HTML 元素的内部 `data-notist-node` 标识、UTF-16 源码区间及 `block` / `inline` / `container` 粒度。Notist renderer 开启 `with_source_map()` 后返回 UTF-8 字节范围，core 在同一次源码扫描中与诊断一起转换坐标；renderer 默认输出不变。映射与 HTML 共用结果 ticket，节点标识仅在当前任务内有效。core 不保存 DOM 坐标；Web 在当前映射上测量排版，并通过内容锚点进行双向定位与滚动跟随。

控制器的 `link(document_id, task_id, target)` 只接受当前就绪结果的链接，返回同文档片段、规范化的 Vault 内路径或允许的外部 URL。相对路径从任务中的文档目录出发，拒绝越出 Vault、无效编码及不允许的 URL scheme。

WASM `PreviewBinding` 独立持有上述控制器，直接使用生成的类型化对象；`EditorAdapter` 不再提供 `preview_*` 分发。Web `lib/preview` 在工作区组合层消费只读源与资源能力。Notist 原始分析及语义环境供语言查询使用，预览转换与 HTML 渲染从原始分析分叉，不从转换后的树反推语言语义。后续阶段见 [路线图](../../docs/roadmap.md)。

```sh
cargo test -p celestite-core --features preview
cargo check -p celestite-core --target wasm32-unknown-unknown --features wasm,preview
```
