# Celestite server MVP

独立 Rust 可执行程序。Vault 由配置文件或 server 命令行注册，Web 客户端通过 Vault URL 连接；客户端没有创建或删除远端 Vault 的接口。Tauri 尚未接入。目录操作位于 server 的 `vault/fs.rs`；`celestite-core::EditorCore<Backend>` 提供统一 Rust / WASM 编辑内核，server 使用 native 后端，默认 Web Vault 使用 OPFS 后端。

## 启动

从仓库根目录执行：

```sh
cargo build -p celestite-server
mkdir -p /tmp/celestite-demo/notes /tmp/celestite-demo/state/notes
cp crates/celestite-server/config.example.toml /tmp/celestite-demo/config.toml
./target/debug/celestite-server --config /tmp/celestite-demo/config.toml --init-vault notes
./target/debug/celestite-server --config /tmp/celestite-demo/config.toml
```

打开 Web 客户端，在底部“管理 Vault”中连接 `http://127.0.0.1:7437/api/v1/vaults/notes`。例子允许默认 Vite 客户端 `http://localhost:1420` 与 `http://127.0.0.1:1420`；其他客户端来源要加入 `allowed_origins`。

配置内目录必须已经存在；相对路径以配置文件目录为基准。Vault ID 只接受 ASCII 字母、数字、`-`、`_`。ID 唯一，根目录不得相同或互相嵌套。配置启动时读取，修改后重启生效。Ctrl+C / SIGTERM 会结束事件订阅并等待正在处理的请求，避免事件长连接阻止退出。名称与目录可修改，保留 ID 即保留 URL。

## 命令行

使用 clap 解析参数，`--help` 查看全部选项，`--version` 查看版本。优先级为 **命令行 > 配置文件 > 内置默认值**。不指定 `--config` 时读取当前目录的 `config.toml`（如果存在）；没有配置文件时，可以通过 `--vault` 直接启动。`--no-config` 忽略默认配置文件。显式指定的配置文件不存在、内容无效或默认文件无效时会报错，不会静默回退。

```sh
# 完全通过命令行启动，目录必须已经存在
./target/debug/celestite-server --no-config \
  --listen 127.0.0.1:7437 \
  --allowed-origin http://localhost:1420 \
  --vault notes=./notes --vault-name 'notes=我的笔记' \
  --vault reference=./reference --vault-read-only reference=true \
  --ephemeral-vault notes --ephemeral-vault reference

# 覆盖部分配置；其他 Vault 及设置保留
./target/debug/celestite-server --config ./config.toml \
  --listen 127.0.0.1:8080 \
  --web-dir ./web/dist \
  --vault notes=./another-directory \
  --vault-read-only notes=false
```

| 参数                               | 行为                                                            |
| ---------------------------------- | --------------------------------------------------------------- |
| `-c, --config FILE`                | 读取指定 TOML 文件                                              |
| `--no-config`                      | 不读取默认配置文件，与 `--config` 互斥                          |
| `--listen IP:PORT`                 | 覆盖监听地址；内置默认 `127.0.0.1:7437`                         |
| `--allowed-origin ORIGIN`          | 可重复；整体替换配置中的来源列表，`--allow-origin` 是别名       |
| `--clear-allowed-origins`          | 清空显式来源列表；server 自身来源仍允许                         |
| `--token-env VARIABLE`             | 覆盖用于读取访问令牌的环境变量名                                |
| `--no-token`                       | 清除配置中的令牌要求；非回环监听仍会拒绝启动                    |
| `--web-dir DIRECTORY`              | 覆盖静态 Web 资源目录                                           |
| `--state-dir DIRECTORY`            | 兼容旧的共享状态目录布局 `<id>.redb`                            |
| `--vault-state-dir ID=DIRECTORY`   | 可重复；覆盖指定 Vault 的私有状态目录，使用 `history.redb`      |
| `--ephemeral-vault ID`             | 可重复；明确使用临时内存历史，禁用该 Vault 的持久化             |
| `--init-vault ID`                  | 可重复；首次初始化指定 Vault 的历史，完成后退出；已有数据库报错 |
| `--reset-vault ID`                 | 可重复；归档指定 Vault 的旧历史，创建新身份，完成后退出         |
| `--no-web`                         | 禁用配置中的静态 Web 资源目录                                   |
| `--vault ID=PATH`                  | 可重复；新增 Vault 或仅覆盖已有 Vault 的目录                    |
| `--vault-name ID=NAME`             | 可重复；覆盖已声明 Vault 的显示名称                             |
| `--vault-read-only ID=true\|false` | 可重复；覆盖已声明 Vault 的只读状态                             |

命令行目录路径以**当前工作目录**为基准，配置文件中的路径仍以**配置文件所在目录**为基准。新增 Vault 默认名称为 ID、可写；覆盖已有 Vault 目录保留其名称与只读状态，除非另行覆盖。不支持通过命令行移除配置中的 Vault，完全替换注册列表可使用 `--no-config` 加多个 `--vault`。

`ID=VALUE` 仅按第一个 `=` 分隔，路径和名称可包含后续 `=`；包含空格的整个参数应加引号。同一种 Vault 参数内重复 ID、未声明 ID 的覆盖、同一 Vault 的初始化 / 重置冲突，以及临时历史与持久化参数冲突都会报错。清除选项与对应设置选项互斥。令牌参数只接受环境变量名称，令牌本身不会进入命令行参数或 URL。

`server.web_dir` 可指向 `bun run --cwd web build` 的产物目录；server 同时提供这份 UI。二进制本身不嵌入 Web 资源。静态目录应仅包含可信构建产物，不允许与 Vault 目录重叠。默认监听回环地址；监听其他地址必须配置 `token_env`，从环境变量读取 Bearer token。前端令牌只保留在当前会话，连接 URL 与本地记录不包含令牌。远端 HTTPS 可由反向代理提供，代理后的客户端来源也需配置。CORS 支持 `Authorization`、`If-Match` 和读取 `ETag`，有 Origin 的 API 请求另行检查来源；CORS 不承担认证。

## 日志

server 使用 `tracing`，二进制通过 `tracing-subscriber` 输出到 stderr，默认级别 `info`。`RUST_LOG` 可覆盖过滤规则；无效规则会使启动失败。

```sh
RUST_LOG=celestite_server=debug,tower_http=debug just serve-notist
```

`info` 记录启动、Vault 初始化、CRDT 导入结果、磁盘保存与关闭；`debug` 增加 HTTP 请求状态码和耗时、线程池操作、更新包大小与因果版本回执。4xx 请求记为 `warn`，5xx 和内部操作失败记为 `error`。每个 HTTP 请求有独立 `request_id`，线程池日志沿用请求上下文。SSE 的响应耗时表示建立响应所需时间。

请求日志不包含查询串、请求头或正文；同步日志只记录包大小和状态。作为 library 使用时，由调用者初始化 subscriber。

## API v1

下面路径均相对于 `/api/v1/vaults/<id>`，文件路径通过查询参数传递，使用 Vault 内相对路径与 `/` 分隔。空路径表示根目录。

| 方法   | 路径                               | 功能                                          |
| ------ | ---------------------------------- | --------------------------------------------- |
| GET    | 根地址                             | 描述：协议、版本、ID、名称、只读和能力        |
| GET    | `/directory?path=`                 | 直接子项，不读正文                            |
| GET    | `/stat?path=`                      | 元数据；不存在返回 JSON null                  |
| GET    | `/file?path=`                      | 二进制正文、内容哈希 ETag，禁止缓存           |
| PUT    | `/file?path=&mode=create`          | 不覆盖的新建，原始字节 body                   |
| PUT    | `/file?path=&mode=replace`         | 已有文件替换，必须带读取时的 If-Match         |
| POST   | `/directory?path=&recursive=false` | 创建目录                                      |
| DELETE | `/entry?path=&recursive=false`     | 删除条目，根目录受保护                        |
| POST   | `/rename`                          | JSON `{ "from": "a", "to": "b" }`，不覆盖目标 |
| GET    | `/events`                          | SSE 变化提示；连接和重连首帧使整个树失效      |

错误采用 JSON `{ code, message, path }`，前端恢复为 `VaultError`。多步操作不保证事务。每个 Vault 内操作串行，磁盘操作在线程池执行；服务内多个客户端的版本比较与提交在同一锁内完成。外部程序不参与该锁，内容核对与提交之间仍有竞争窗口；没有跨程序的原子 CAS 承诺。

文件写入先暂存并同步数据，再提交；替换保留权限位，失败尽量清理暂存文件。暂存名称前缀 `.celestite-tmp-` 为保留命名空间，目录列表隐藏该前缀。异常退出可能留下暂存文件，MVP 不自动清理未知遗留文件，也不承诺断电后目录项已持久化。原子写入更换文件身份，其他硬链接不会同步更新；扩展属性/ACL 尚未复制。

不覆盖移动及文件提交当前验证并实现于 **Linux**；其他平台返回 Unsupported。跨挂载点移动返回 Unsupported，不自动复制/删除。符号链接可列出、删除或移动链接本身，正常操作不跟随链接；访问通过受限目录句柄，防止链接逃逸 Vault。对 Vault 内目录的并发替换仍以平台能力和实际错误为准。

notify 提供粗粒度提示，服务写操作也主动发送提示。监听不是可靠操作日志，事件溢出会发送全树失效，可能重复通知。网络挂载的外部变化未必能被系统监听捕获，可手动刷新。远端 Web 编辑器通过 WebSocket 加入历史、发送实时 CRDT 增量与显式保存命令。外部文件修改经 host bridge 合入历史并主动推送。

文件请求上限 64 MiB；正文整体进出内存。前端编辑上限仍为 5 MiB。请求超时或断网不会自动重放写操作，错误提示核对服务器状态。普通文件 API 不承担协作；在线文本协作使用下述 WebSocket 会话，离线编辑暂不支持。普通文件写请求仍不提供断线去重。

## 在线协作 WebSocket

描述接口报告 `websocketSync: true`。每个客户端 VaultInstance 建立一条 `/api/v1/vaults/<id>/sync` 连接；HTTPS 使用 WSS，反向代理需转发 WebSocket upgrade。来源检查发生在升级前，认证通过首个 JSON 消息完成，不把令牌写入 URL：

```json
{
  "protocolVersion": 1,
  "token": "本次会话令牌",
  "vaultIdentity": {
    "id": "描述接口的 id",
    "historyId": "描述接口的 historyId"
  }
}
```

host 返回 `hello`（`sessionId`），然后按文档发送 `document`（元数据、`packet`、分配的十进制 `writerId`、递增 `sequence`），在快照补齐屏障后发送 `ready`。文本来自 CRDT 包；元数据不重复发送正文，`savedContent` 仅在磁盘基线改变时发送。首次传快照，之后主动广播增量，覆盖未打开文件。慢消费者丢失提示后重新补齐；无法导出已提交历史时结束会话，客户端冻结并保留正文。

请求均为 `{ sessionId, requestId, method, ...参数 }`，响应为 `{ kind: "reply", requestId, result }` 或 `error`：

| method  | 参数                           | 行为                                                                             |
| ------- | ------------------------------ | -------------------------------------------------------------------------------- |
| open    | path                           | 取得文档完整历史及元数据；非文本通过普通文件 API 下载                            |
| updates | id, packet, version, operation | 按会话递增序号提交本 writer 的增量；完整依赖、身份和 writer 验证后持久提交并确认 |
| save    | id, version                    | 指定已见因果版本，单独条件写回物理文件；版本过期先补齐再重试                     |
| probe   | id, version                    | 查询已提交历史是否包含给定因果检查点，核对丢失的确认                             |
| ping    | —                              | 返回 pong；host 每 10 秒发送 heartbeat，超时终止会话                             |

`document`、`tree` 和 `heartbeat` 为主动通知；`tree` 使文件树失效，实际目录仍通过 HTTP 查询。会话缓存最近 256 条操作回执，同序号同包重发返回原回执，变更载荷或跳号被拒绝；回执过期用因果检查点核对。重连分配新会话与 writer，拒绝旧 writer 的未提交操作，不自动重放。已确认操作的恢复依据持久 CRDT 历史，临时测试 Vault 的回执仅代表内存提交。

客户端的个人撤销也生成自己的 CRDT 增量。输入同步不隐式保存普通文件；保存可能写回已经合入的其他 writer 修改。外部文件变化按磁盘历史分支合并，客户端不能用“丢弃”清除所有人的共享未保存历史。客户端导入保留当前 writer / 撤销，UI 映射待确认输入和选区，IME 期间暂缓导入；断线时整个 Vault 工作区（文件树与编辑区）显示遮罩并禁止交互，重新认证核对历史身份并从 host 重建会话；未确认输入可导出正文或明确丢弃，不自动重放。`probe` 保留为调试与因果检查接口，首期 Web 重连流程不使用它恢复旧输入。

## 无头编辑器 API

下面路径仍相对于 `/api/v1/vaults/<id>`。正文与文档业务由 `celestite-core::EditorCore` 管理，不需要标签页、CodeMirror 或浏览器。所有返回值禁止缓存，沿用 Vault 的认证、来源检查与只读约束。

| 方法 | 路径                                  | 请求 / 行为                                                                             |
| ---- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| GET  | `/documents`                          | 扫描整个目录，返回可编辑文本状态，包括未在 UI 打开的文件                                |
| POST | `/documents/open`                     | `{ "path": "a.md" }`，登记文件并返回稳定文档 ID 与状态                                  |
| GET  | `/documents/<document>`               | 正文、因果版本、撤销与保存状态；重新核对磁盘                                            |
| GET  | `/documents/<document>/snapshot`      | 完整 `SyncPacket`，新副本从这里加入同一历史                                             |
| POST | `/documents/<document>/updates`       | `Version`，返回该版本之后的更新包                                                       |
| POST | `/documents/<document>/import`        | `SyncPacket`，验证并合并；返回 `{ result, document }`                                   |
| POST | `/documents/<document>/transact`      | `Transaction`，UTF-16 范围编辑；返回 `{ result, document }`                             |
| POST | `/documents/<document>/undo`          | `UndoContext`，可用 `{}`；撤销 server writer 的本地操作                                 |
| POST | `/documents/<document>/redo`          | 同上，重做                                                                              |
| POST | `/documents/<document>/save`          | 当前 `Version`，条件写回文件，返回更新的状态                                            |
| POST | `/documents/<document>/client-commit` | `{ packet, expectedRevision, action }`，客户端副本条件提交，返回 `{ document, packet }` |

核心类型字段采用 Rust 的 `snake_case`；外层状态字段采用 `camelCase`。`Version = { identity: { document_id, history_id }, clocks: { "十进制 writer ID": counter } }`。writer ID 用字符串，避免 JS 64 位整数精度丢失。`SyncPacket = { identity, kind: "snapshot" | "updates", data: [byte, ...] }`。JSON 字节数组用于当前测试传输，未来可加入二进制 framing。

`clientReplicaCommit: true` 保留旧 HTTP 客户端副本提交能力；正常 Web 编辑使用 WebSocket。`client-commit` 的 `action` 为 `save`、`overwrite` 或 `discard`：保存先核对 `expectedRevision`，基线不符时拒绝导入客户端操作；覆盖明确选择客户端正文；丢弃不发送客户端包，重新取得 host 最新文件。返回的完整快照用于补齐客户端历史，文档状态确认实际文件基线。快照限制为 16 MiB，文档请求 JSON 上限为 80 MiB 以容纳字节数组编码；仍使用既有认证、只读约束和 Vault 操作锁。

host 有尚未写回的正文时，客户端丢弃返回冲突，保留 host 修改；先处理 host 保存，再重试客户端丢弃。

事务示例：

```json
{
  "expected_version": {
    "identity": { "document_id": "来自状态", "history_id": "来自状态" },
    "clocks": {}
  },
  "origin": "headless-client",
  "edits": [{ "from": 0, "to": 0, "insert": "hello\n" }],
  "undo_metadata": null,
  "undo_positions": []
}
```

`expected_version` 必须完整使用刚读取的 `snapshot.version`，示例中的空 clocks 不是现有文件的真实版本。`from/to` 是事务之前正文的 UTF-16 半开区间，不能切开 emoji 等字符的代理对；多项编辑必须有序且互不重叠。内核一次验证所有编辑，然后提交一个撤销步。过期事务 / 保存返回 `409 StaleVersion`，非法坐标和更新包返回 `400 InvalidEdit`。不同文档或历史之间的导入被拒绝。

协作客户端各自从完整快照建立 `Document`，使用新的 writer，只发送 CRDT 更新。重复和乱序包按 CRDT 语义处理；依赖未齐的包保留，后续补齐。客户端撤销由自己的内核产生更新，不调用 server writer 的 `/undo` 代替个人撤销。两个 HTTP 客户端直接调用 `/transact` 会共享 server writer 的撤销历史，因此这组接口先用于无头开发与测试。

### 持久化和磁盘保存

每个正式 Vault 在 `[[vaults]]` 中配置 `state_dir`；正常启动仅打开已有历史。以下两条命令分别初始化和运行：

```sh
mkdir -p /tmp/celestite-demo/notes /tmp/celestite-demo/state/notes
cargo run -p celestite-server -- --no-config \
  --vault notes=/tmp/celestite-demo/notes \
  --vault-state-dir notes=/tmp/celestite-demo/state/notes --init-vault notes
cargo run -p celestite-server -- --no-config \
  --vault notes=/tmp/celestite-demo/notes \
  --vault-state-dir notes=/tmp/celestite-demo/state/notes

# 仓库内 ../notist/docs 的开发入口：
just init-notist  # 首次执行，已有历史时拒绝覆盖
just serve-notist
```

状态目录必须存在，不能与任何 Vault、其他私有状态目录或静态资源目录重叠；符号链接别名按实际路径校验。一个 profile 同时只允许一个 host 打开。状态库包含稳定 Vault / 文档 / host 实例身份、初始快照、追加更新日志、pending 依赖包、磁盘基线和恢复意图；每次历史事务提交成功后才报告 `durableVersion`。更改名称或 URL 配置 ID，保留相同物理目录与私有状态目录时保留内部身份。更改物理目录则拒绝恢复，需要另行迁移。

未指定状态目录时拒绝启动。临时测试可显式配置 `ephemeral = true` 或 `--ephemeral-vault ID`：重启建立新身份和历史，`durableVersion` 为 null。初始化 / 重置是一次性 CLI 操作，不能配置为每次启动执行。多个 Vault 的配置会在操作前统一校验，但历史初始化 / 重置按 Vault 执行，不提供跨 Vault 事务；发生失败后核对各 profile，再仅初始化尚未完成的 Vault。

正常恢复遇到数据库缺失、损坏、身份 / schema / 根目录不匹配时失败，不从普通文件静默重建。`--init-vault ID` 使用独占创建，不覆盖任何已有文件。`--reset-vault ID` 要求原 profile 可校验且没有其他 owner，先将完整旧数据库移入同一状态目录的 `reset-<uuid>/history.redb`，同步归档目录后创建新身份；普通文件保持原样，未写回的旧正文仍在归档内。重置中断或失败时保留归档和任何已创建文件，不自动推断恢复；损坏库应先单独保留并处理，不通过 reset 忽略损坏。

兼容旧 `[server].state_dir` / `--state-dir`：没有私有 `state_dir` 的持久化 Vault 继续打开其下的 `<配置 id>.redb`，不改名或重新 seed。私有配置优先。迁移布局时停止 host，保留备份，将该数据库迁入私有目录并命名为 `history.redb`，再修改配置；旧布局更改 URL ID 需要同时明确迁移对应文件。

`dirty` 表示正文与最后已保存文本不同；`savedVersion` 是当前磁盘基线对应的因果版本（含已接受的外部保存）；`durableVersion` 是已提交历史的应用版本。持久化历史不等于写回 `.md`，`/save` 是显式动作。没有可见文本变化的导入也可能推进因果版本。等待依赖的包已经写入日志，但不会被虚报为已应用版本。

保存先持久化 Prepared 意图，再持久化 Started 阶段，随后通过哈希条件检查与暂存替换写文件，最后持久化回执。恢复 Prepared 时可以确定该次文件 IO 尚未开始；Started / 旧格式意图仅在磁盘字节匹配目标时完成回执，否则保留意图并暂停自动处理，包括磁盘仍为旧内容的情况。后端能证明失败发生在投影写入前时，core 先持久化回退至 Prepared，允许安全重试。目标匹配属于普通文件协调的恢复契约，不提供外部写入来源证明或跨程序 CAS。日志提交失败会使该宿主停止后续写入，并在状态中保留最后成功提交的版本、报告 `persistenceError`；应核对状态，不能把失败响应视为已保存。

host 通过 core 的 `EditorOptions.external_changes = Merge` 启用外部修改合并，存储 Backend 只负责 IO。core 保留磁盘的精确字节和历史版本；外部变化从该版本 fork，以独立 writer 生成有时间预算的 Unicode 细粒度 diff，再合入当前正文。连续观察沿磁盘分支推进；操作 journal 与新磁盘基线在同一事务中提交，提交成功后才更新活动文档，保留其 writer、个人撤销和订阅。重复提示及自身写回不生成额外文本操作，格式变化仅更新基线；超时、非法正文与不确定写回不会退化为整篇替换。启动时先注册递归监听，再发现全库文本；运行时由有界合并的监听唤醒后台串行核对，每 30 秒全库观察兜底漏报。访问事件不触发协调，重复提示及自身写回不会产生新文本操作。单个无效 / 不可读文件不会阻止其他文件；历史提交失败仍冻结 core，监听不自动重试历史。外部删除保留原文档、未保存正文和历史并报告缺失；外部移动不按相同内容推断身份，稳定移动通过 host API 完成。原文件 API 也不能绕过未保存 CRDT 正文直接覆盖文件。通过 server 移动文件 / 目录保持文档 ID；删除保留历史，延迟保存不能重建旧路径。

### 文档变化通知

`GET /api/v1/vaults/{id}/documents/events` 提供需要相同认证的 SSE（`event: documents`，`Cache-Control: no-store`）。连接首先收到 `kind: "resync"` 的全量文档元数据，之后收到 `kind: "changed"` 的变化条目；通知包含 `streamId`、递增 `sequence`、`vaultIdentity` 和 `persistentHistory`。各条目包含文档 ID、路径、已提交 `version`、`savedVersion`、磁盘 revision、dirty / conflict / deleted / available 与错误状态，不传正文。

初始元数据与 receiver 在同一 core 锁下建立，订阅后出现的变化进入 receiver；消费者落后超过广播缓冲时重新原子取得全量状态和新 receiver。重连始终重新核对，`Last-Event-ID` 不表示持久化操作回执；server 重启改变 `streamId`，保留 Vault / 文档历史身份。客户端收到通知后通过 `/snapshot` 或 `/updates` 获取 CRDT 内容；私有历史提交失败不会把未提交正文版本宣布为已确认版本；此时 `/snapshot` 与 `/updates` 暂停导出，避免通知后的一次失败提交被后续拉取当作已确认历史。

描述接口报告 `documentEvents: true`。此通道是状态核对提示，不确认编辑请求，也不提供会话有效性、重发去重或在线租约；在线编辑由 WebSocket 会话协议提供这些约束。原 `/events` 继续提供文件树提示。

### 当前范围

已实现独立文本 CRDT 与单个 server 的文件协调。`/documents` 当前扫描并加载全部合格文本，排除符号链接、非 UTF-8 / 二进制内容及超过 5 MiB 的文件；内存正文为 LF，保存恢复文件原有 BOM 与首个换行样式，混合换行会统一。尚未实现目录 Catalog CRDT、整个 Vault 的离线结构合并、附件同步、工作集淘汰、日志压缩或 P2P 同步。描述接口明确报告 `vaultCrdt: false`。

移动 / 删除与 redb 元数据不是跨资源原子事务，正常重启保留结果，core 先记录目录操作意图以恢复崩溃窗口；存在源 / 目标歧义时停止恢复并保留文件与历史。外部程序 rename 的稳定身份识别暂未实现。HTTP 导入保留为无头 / 调试传输，SSE 保留为变化提示；远端 Web 使用自己的 Rust WASM core 和实时 WebSocket 会话。Vim、Tree-sitter、LSP 尚未接入。

## 多实例与可视化调试

多个独立客户端可从同一快照加入，通过 `/updates` 与 `/import` 交换各自 writer 的历史。生产连接使用 WebSocket 会话、心跳和主动广播；调试页保留 HTTP 主动拉取，不提供在线成员 / presence 列表。客户端个人撤销在自己的 core 上执行，不能用服务端 `/undo` 替代。

Web 提供 `/debug/sync` 调试页，显示 host 与最多 6 个独立 WASM core，支持手动 / 每秒同步、暂停传输、个人撤销、显式保存、版本与提交回执检查。开发时使用 `http://localhost:1420/debug/sync`；构建后配置 `--web-dir web/dist`，也可从 server 的同一路径打开。详见 [Web 调试说明](../../web/README.md#同步调试页)。调试页用现有文档 API，沿用令牌、来源和只读检查。

## 验证

```sh
cargo test -p celestite-core -p celestite-server
# 只跑监听真实端口、无需浏览器的编辑器集成测试：
cargo test -p celestite-server --test headless_editor
cargo test -p celestite-server --test websocket_sync
# 校验 feature 后面的实际 WASM 绑定：
cargo check -p celestite-core --target wasm32-unknown-unknown --features wasm
cargo build -p celestite-server
bun run --cwd web test:vault
bun run --cwd web test:ui tests/multi-vault.spec.ts
```

浏览器测试启动临时真实 server，使用临时目录和随机端口。默认寻找 `target/debug/celestite-server`，可以用 `CELESTITE_SERVER_BIN` 指定其他构建产物；自定义 Chromium 路径用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`。覆盖二进制文件、目录操作、版本冲突、外部监听、认证、连接持久化、Vault 切换和撤销历史、只读与移动端。

无头 Rust 测试使用临时目录、随机端口及独立 redb profile，覆盖双副本离线合并、个人撤销、未打开文件发现、过期版本、非法 / 跨历史导入、乱序更新重启补齐、未保存正文恢复、外部修改冲突、移动 / 删除、BOM / CRLF 与只读约束。另有写完文件但回执未写时的恢复契约测试。
