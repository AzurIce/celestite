# 归档编辑器、Tree-sitter 与 LSP 调查

日期：2026-10-03。本文保留当日源码核查、固定版本的能力与测试结果。实施顺序和验收已迁入 [路线图](../roadmap.md)，当前资源与接口边界见 [项目架构](../architecture.md)，不再在本日志维护阶段方案。

## Celestite 调查基线

当时 CodeMirror 6 的语言包使用 Lezer，并提供高亮、折叠与缩进；只启用 Tree-sitter 装饰不会让 CodeMirror 的语法树 API 自动使用 Tree-sitter。VaultDocuments 当时管理全文、保存与文件操作，缺少供语言分析使用的版本化增量事件和缓冲区优先工作区读取。Tauri 尚无原生 Vault 或语言服务器进程接入。

这些是 2026-10-03 的基线，后续 OPFS Worker / WASM 实现已改变编辑链路，不能按本记录判断当前进度。调查没有安装语言服务依赖或运行 LSP 集成原型。

## Tree-sitter 坐标证据

CodeMirror 位置使用 UTF-16 code unit。已核查的 `web-tree-sitter` 0.25.10 Web 桥接在 JS 与 C 之间转换 UTF-16 code unit 和字节偏移，因此其节点 index 与列坐标不能套用“原生 UTF-8 字节数”的假设。若以后改用 Rust Tree-sitter 解析 UTF-8 输入，则需另外转换字节位置。

应用内部高亮区间统一约定 UTF-16；实现时对选定版本验证中文、emoji、代理对、多行插入和多个编辑。文档运行时已将 CRLF/CR 规范为 LF，解析与 LSP 使用这份内存正文，保存时再恢复原换行形式。

固定源码为 [Tree-sitter 0.25.10 的 Web 桥接](https://github.com/tree-sitter/tree-sitter/blob/da6fe9beb4f7f67beb75914ca8e0d48ae48d6406/lib/binding_web/lib/tree-sitter.c)。调查时发布列表已出现 0.27.0；0.25.10 只是坐标证据版本，正式接入仍需固定并验证运行时、CLI、grammar 和 query 的配套版本。

该次核查的 CodeMirror 提供 StateField、StateEffect、DecorationSet、ViewPlugin 与 visibleRanges，可承接异步高亮，不要求更换 DOM 编辑器。增量解析不自动保证 query 增量化，字符串内容与谓词变化也需要重新捕获；grammar、highlights、locals 与 injections 的支持范围须按选定版本验证。

## LSP 客户端评估

本次核查到官方 GitHub 已归档镜像中的 `@codemirror/lsp-client` 源码，其 `package.json` 标注 6.2.2，MIT 许可。它的 CodeMirror 依赖范围覆盖本项目目前版本，新增依赖包括 `@codemirror/lint` 和协议类型包。新维护站点访问返回 403，因此本文不宣称 6.2.2 是最新版本，也不将镜像局限推广到所有后续版本。

核查版本包含补全、hover、签名提示、诊断、格式化、跳转和符号重命名，以及可自定义的 `Workspace`。其传输约定是 `send(message: string)`、`subscribe(handler)`、`unsubscribe(handler)`，消息是完整 JSON 文本，不带 stdio 的 LSP 头。推荐按功能选择扩展，试点先启用诊断、补全和 hover。

核查版本的限制需要在选定正式版本时重新验证：

| 能力           | 核查发现及接入影响                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------- |
| 默认工作区     | 跟随编辑器视图打开和关闭；需要适配我们的后台标签与文档生命周期                                     |
| 跨文件跳转     | 应用实现 `displayFile(uri)`，打开或激活目标文档并返回视图                                          |
| 符号重命名     | 源码处理 `response.changes`，且跳过未打开的文件；不能直接承诺整个 Vault 的跨文件重命名             |
| 工作区修改     | 默认 `updateFile` 只向现存视图 dispatch，应用需处理后台及未打开文档                                |
| 服务器主动请求 | 核心接收代码对未实现请求返回 MethodNotFound；`workspace/applyEdit`、配置和动态注册等不能假定已支持 |
| 语义高亮       | 已核查导出没有 semantic tokens 扩展；需要单独实现或重新评估正式版本                                |
| 保存和退出     | 应用需补充适用服务器的 didSave、shutdown/exit 与实际进程终止协调                                   |

应先验证官方客户端的具体版本和目标服务器，再决定是否增加适配或维护小补丁。若目标服务器依赖大量双向请求与动态能力，可进一步评估 Microsoft JSON-RPC 库搭配自有 CodeMirror 功能扩展；这会增加位置映射和 UI 接入工作量。没有必要仅为 LSP 切换到 Monaco。

## 平台与协议观察

浏览器 Worker 不自动提供 Node fs、工具链或任意本机进程；普通语言服务器无法直接读取 OPFS URI。didOpen / didChange 提供打开正文，不能代替未打开文件、配置、标准库与依赖访问。可浏览器运行的语言服务需要虚拟文件系统；native / 远端进程需要真实工作目录或另外的文件访问协议。

核查客户端 transport 收发完整 JSON，不带 stdio 头。native 桥接须按 UTF-8 字节 Content-Length 解帧，处理头 / 正文分片、多消息粘连并分离 stderr；position encoding 与传输编码分别处理。URI 是项目地址而非文档身份，路径组件必须编码；移动后更新 URI 与诊断关联。

## 归档 Notist 编辑器调查

以下证据迁自原编辑器路线图，保留 2026-10-03 的固定提交、测试结果与局限。当前阶段安排统一维护在路线图中。

核查了归档 `notist` 的 `refactor` 分支，固定提交 `f4e121d84b77a80bb4608636519903a1fd6d6fdb`。主要编辑器尝试位于 `editor/`，其中 `d0c423c` 为 `WIP: editor-attempt`。

| 部分                          | 已实现能力                                | 迁移判断                             |
| ----------------------------- | ----------------------------------------- | ------------------------------------ |
| `editor-document`             | Loro 文本、事务、因果版本、锚点、协作撤销 | 作为 Rust 内核起点，保留契约和测试   |
| `editor-node-wasm` 与 JS 包装 | Rust / Web 共用文档、异步事件交付         | 提取文档绑定，保留单一文档实例       |
| `source-projection`           | CM6 / Tiptap 共用源码，未知语法受保护     | 留作富文本后续设计参考               |
| `PeerNode`                    | 版本补齐、重连、多跳转发、持久化确认      | 保留协议经验，正式传输后续接入       |
| IndexedDB / redb 日志         | 有序追加、确认已提交版本、历史恢复        | 复用持久化语义，增加检查点和文件协调 |
| `text_file` 输出              | 临时文件替换、哈希检查、外部修改保护      | 不能直接沿用其数据库权威模型         |

归档文档内核固定 `loro = 1.16.2`。它维护一个 `LoroText("source")`，不依赖语言栈；网络节点和视图共用同一个文档 handle。初始历史创建一次，其他副本从快照加入，不能分别从相同字符串初始化后视为同一历史。

归档的 Loro / CM6 实验在固定版本中观察到初始化竞态、嵌套 dispatch、只恢复主选区、非 CM 本地写入不刷新视图，以及远端导入拆分 IME 撤销组。官方同步服务实验也观察到 ACK 早于持久化及异步保存竞争。这些是当时版本的观察，不宣称后续版本仍然如此；迁移时应保留对应回归场景，不能直接把旧官方绑定或参考服务端视为已满足验收。

Vim 实际位于归档 `obsidian-notist`，固定提交 `39b07fcd13c51d29571c224d387e0a4ac5871ca4`，使用 `@replit/codemirror-vim ^6.4.0`。它包含模式切换、中文输入处理、visual block、多光标，以及另一套 LSP / tree-sitter 接入，但没有与上述 CRDT 内核整合。该插件已声明 deprecated；其语言实现不能视为兼容当前 Notist。

本次实际重跑了文档内核 12 项、同步状态机 8 项和投影模型 7 项测试，共 27 项通过。未重跑完整 native 网络、WASM 浏览器和真实系统输入法链路。归档 README / ROADMAP 的阶段状态落后于实际代码，实施以源码和复跑测试为依据。
