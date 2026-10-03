# 无头 server 中的 Rust 编辑器内核

日期：2026-10-04。状态：第一轮实现及测试完成。此轮先通过纯 server 验证文本内核、CRDT 交换、历史恢复和文件写回；不以 Web UI 或 Tauri 为前置条件。本文记录当前实现与局限，后续阶段仍按整库同步设计推进。

## 代码职责

```text
celestite-core/
  document/        Document、事务、版本、锚点、协作撤销与事件
  wasm.rs          wasm feature + wasm32 target 下的 DocumentBinding
  tests/           13 项文档契约测试（12 项归档 + 1 项乱序 schema 回归）
celestite-server/
  vault/fs.rs      原 core 中的受限原生目录操作与 4 项测试
  vault/documents.rs 文本发现、内核实例、外部编辑与文件写回协调
  vault/store.rs   redb 初始快照、更新日志、身份、磁盘基线
  editor_api.rs    无头 HTTP 文档接口
  tests/          监听实际随机端口的 HTTP / CRDT 集成测试
```

`celestite-core` 不依赖 Axum、redb、cap-std、本地路径或浏览器对象。server 是第一个宿主，拥有 IO、互斥与持久化；原有文件 API、鉴权、只读、来源检查、SSE 与静态资源托管保留。Tauri 继续搁置。Web 编辑器仍使用现有文件 API，本轮没有替换其缓冲区与撤销实现。

文档内核和文档 WASM 绑定从归档 Notist 的 `refactor` 提取，固定提交 `f4e121d84b77a80bb4608636519903a1fd6d6fdb`，固定 Loro 1.16.2。没有迁入归档语言栈、PeerNode 或另一套 UI。core 的默认 feature 为空，绑定 feature 名为 `wasm`，输出 `rlib` / `cdylib`；实际 wasm32 目标检查通过。

## 可以通过 server 验证的编辑闭环

文件首次登记时生成稳定文档 ID 和独立历史 ID，保存初始快照。其他副本必须从该快照加入，使用新的 writer。文件移动只改变路径，不更换正文身份；删除保留历史，但旧文档的直接编辑和保存不能重建已删除路径。

`GET /documents` 扫描整个 Vault 的合格文本，包含没有在 UI 打开的文件；`POST /documents/open` 显式登记路径。单文件状态包括正文、因果版本、撤销状态、磁盘基线及冲突。以 `/documents/<document>` 为前缀，还提供：

| 接口                  | 内容                                         |
| --------------------- | -------------------------------------------- |
| `GET /snapshot`       | 加入同一历史的完整快照                       |
| `POST /updates`       | 指定因果版本之后的更新包                     |
| `POST /import`        | 导入快照或增量，保留等待因果依赖的包         |
| `POST /transact`      | 有序、不重叠的 UTF-16 编辑事务，检查预期版本 |
| `POST /undo`、`/redo` | server writer 的本地协作撤销与重做           |
| `POST /save`          | 检查正文因果版本及磁盘哈希，显式写回原文件   |

以上路径相对于 `/api/v1/vaults/<配置 ID>`。核心类型使用 snake_case JSON，外层状态使用 camelCase；`SyncPacket` 包含文档 / 历史身份、snapshot 或 updates 类型及 JSON 字节数组。当前传输方便无头测试，后续可以加入二进制 framing。

事务先验证所有编辑与 Unicode 边界，过期版本不会修改正文。导入拒绝跨文档 / 跨历史、错误格式、浅历史、非正文 schema 以及 live writer 冲突。host 还验证 LF 正文、控制字符与 5 MiB 文本限制。两个独立客户端可以离线编辑、发送增量，再通过版本交换补齐、收敛；客户端本地撤销产生自己的 CRDT 更新，保留对方修改。

直接通过 HTTP `/transact` 的测试请求共享 server writer，因此 `/undo` 不能当成每个 HTTP 客户端的个人撤销接口。个人撤销属于客户端自己的内核和 writer 生命周期；重启恢复文本历史不恢复本地撤销栈。

## 历史持久化与文件保存

新增 TOML `server.state_dir` 及 CLI `--state-dir DIRECTORY`。目录必须事先存在，不能与任何 Vault 或静态资源目录重叠。配置文件中的相对路径以配置文件目录为基准，CLI 相对路径以工作目录为基准。

指定后，每个配置 ID 对应一个 redb profile，绑定规范化 Vault 根目录。它记录持久 Vault 身份、文档 header、初始历史和有序更新日志。重新打开恢复同一文档 / 历史身份，writer 重新生成。日志保留原始等待包；仅保存已应用快照会遗漏这些更新，故恢复时重放日志并检查每一步应用版本。

不指定时，CRDT 历史驻留内存，`durableVersion` 为 null，重启建立新身份。显式 `/save` 仍写文件，但这不能替代历史持久化。

| 状态               | 含义                                              |
| ------------------ | ------------------------------------------------- |
| `snapshot.version` | 当前已经应用的因果版本                            |
| `durableVersion`   | 成功提交日志后确认的应用版本；没有持久化时为 null |
| `savedVersion`     | 最后写回磁盘时的版本                              |
| `dirty`            | 当前正文与最后保存文本不同                        |
| `conflict`         | 当前磁盘内容不再匹配记录的基线                    |
| `persistenceError` | 存储失败信息；失败后不再确认持久化并停止后续写入  |

依赖未齐的包会落日志，但不虚报为已经应用。持久化 CRDT 历史也不等于保存 `.md`；`/save` 是独立显式动作。保存前提交写回意图，再通过哈希核对和原有暂存替换写文件，最后提交回执。文件已写完而回执尚未提交时，恢复识别匹配的内容并完成保存基线更新。

文件被外部编辑器修改，正文干净则以独立 filesystem writer 导入，避免污染 server 本地撤销；正文有未保存编辑则保留编辑、标记冲突，保存返回 409，不静默覆盖。原有文件 PUT 也不能绕过未保存正文。内存统一 LF，保存保留 BOM 和文件首个换行形式；混合换行会统一。

## 实际验证

```sh
cargo test -p celestite-core -p celestite-server
cargo test -p celestite-server --test headless_editor
cargo check -p celestite-core --target wasm32-unknown-unknown --features wasm
cargo build -p celestite-server
cargo clippy -p celestite-core -p celestite-server --all-targets -- -D warnings
```

本轮完整 Rust 测试共 40 项通过：core 文档契约 13 项，server 模块 / 文件与恢复 15 项，CLI 5 项，真实 HTTP 集成 7 项。HTTP 测试启动监听随机端口的 server，使用独立临时目录和 redb profile，直接创建两个 Rust CRDT 客户端，不借助浏览器或 mock transport。

覆盖离线并发插入与协作撤销、emoji / UTF-16、未打开文件发现、重复及乱序包、非法和跨历史导入不改变状态、乱序包不绕过正文 schema、未保存编辑恢复、因果等待包重启后补齐、外部修改冲突、server 移动 / 删除、BOM / CRLF、只读。模块测试还模拟文件写完但保存回执未提交的恢复边界；CLI 测试验证 state_dir 配置与命令行覆盖各自的路径基准。

另外以实际二进制启动并执行登记、事务、重启恢复、保存与 SIGTERM 退出的 HTTP 检查。WASM 此轮验证编译接口，尚未运行浏览器内 Rust / JS 行为对照。

## 后续阶段与边界

这不是完整 Vault CRDT 的交付，描述接口明确返回 `vaultCrdt: false`。先完成可测试的文本 / host 基线，再加入 Catalog 与同步调度：

1. core 增加 CatalogDocument、EntryId、父子 / 名称 / 删除语义，测试并发目录移动和同名冲突。
2. server 增加结构投影日志，处理 rename / delete 与历史存储之间的崩溃窗口、外部 rename 和路径重用。
3. 加入多文档发现与复制调度、附件引用、按需工作集及日志检查点 / 压缩。
4. Web 经 WASM 使用同一内核，对接 OPFS 与 CM6 / Vim，然后依次接 Tree-sitter 和 LSP。

当前目录扫描会加载全部合格文本，启动恢复也重放全部历史，没有大库性能保证。等待包与追加日志尚无容量回收策略。移动 / 删除的 filesystem 和 redb 修改不构成跨资源事务，外部程序也不参与文件哈希检查与替换之间的锁。HTTP 仅提供拉取 / 提交传输，不主动连接其他副本，SSE 仍是粗粒度变化提示。本轮结果证明单 server 的文本协作与保存闭环，不替代这些后续验收。
