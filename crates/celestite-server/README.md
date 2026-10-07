# Celestite server MVP

独立 Rust 可执行程序。每个 server 进程服务一个 Vault，由配置文件或命令行指定。Web 客户端通过分享 URL 连接，可以连接多个独立 server，没有创建或删除远端 Vault 的接口。Tauri 尚未接入。目录操作位于 server 的 `vault/fs.rs`；`celestite-core::EditorCore<Backend>` 提供统一 Rust / WASM 编辑内核，server 使用 native 后端，默认 Web Vault 使用 OPFS 后端。

## 启动

从仓库根目录执行：

```sh
cargo build -p celestite-server
mkdir -p /tmp/celestite-demo/notes
cp crates/celestite-server/config.example.toml /tmp/celestite-demo/config.toml
./target/debug/celestite-server --config /tmp/celestite-demo/config.toml
```

正常启动时，自动生成并在日志里打印一对链接：

```text
Vault share links readonly_url=http://127.0.0.1:7437/ro-<key> edit_url=http://127.0.0.1:7437/<other-key>
```

打开 Web 客户端，在底部“管理 Vault”中粘贴其中一条完整 URL。链接到 key 为止，客户端自动追加 `/api/v1/...`。例子允许默认 Vite 客户端 `http://localhost:1420` 与 `http://127.0.0.1:1420`；其他客户端来源要加入 `allowed_origins`。没有分享初始化或分享管理命令。

配置内目录必须已经存在；相对路径以配置文件目录为基准。`[vault]` 指定唯一的 Vault，无配置 ID。配置启动时读取，修改后重启生效。Ctrl+C / SIGTERM 会结束事件订阅并等待正在处理的请求，避免事件长连接阻止退出。server 不读写私有状态库，CRDT 历史只在进程内存中保留；普通文件保存仍写入 Vault 目录。多 Vault 的集中托管留待 SaaS 场景再设计。

## 链接配置与轮换

每个 Vault 固定提供 readonly / edit 两条链接，由秘密值与 Vault 身份分别派生。Vault 身份由秘密值与规范化的 Vault 根目录确定。`ro-` 属于完整凭证，两个权限使用不同派生域；增删前缀不能转换权限。`read_only = true` 仍限制整个 Vault，因此它的 edit 链接也只有读取能力。

未配置 `share_key` 时，宿主每次启动产生 32 字节随机秘密值，仅保留在内存中，因此重启后链接和 Vault 身份改变。

在 `[vault]` 配置 `share_key`，或通过 CLI 传入 `--share-key`，可保留固定链接。任意非空字符串均可，字节原样参与派生，不做裁剪；短或可猜测的值会同时削弱两条链接的保密性，推荐用 `openssl rand -hex 32` 生成的随机值，较短的值会在启动时输出警告。相同秘密值与同一规范根目录保留链接和 Vault 身份，显示名 `name` 不参与派生；改目录或秘密值会同时替换两种链接和 Vault 身份，恢复原配置可能恢复旧链接。每次启动都会生成新的 `historyId`，固定链接不意味着历史跨重启保留。配置不支持动态热更新。

`[server] public_url` 可设置打印链接使用的公开 HTTP(S) 地址和反向代理前缀，例如 `https://notes.example.com/celestite`；默认使用实际监听地址。该选项只决定链接基址，其 Origin 自动允许，不改变 key 或监听地址。反向代理将该前缀后的请求转发给宿主，并转发 WebSocket upgrade。

完整链接是凭证，按要求打印在启动日志中，日志的可读者也获得对应权限。普通请求日志继续脱敏 key。客户端连接记录为重连保存完整链接，转发链接即转交权限。宿主退出关闭 HTTP 监听与活动 WebSocket / SSE；轮换后需从新启动日志复制链接重新连接，客户端保留未确认正文供恢复。

## 命令行

使用 clap 解析参数，`--help` 查看全部选项，`--version` 查看版本。优先级为 **命令行 > 配置文件 > 内置默认值**。不指定 `--config` 时读取当前目录的 `config.toml`（如果存在）；没有配置文件时，必须提供 `--vault PATH`。`share_key` 在配置文件和 CLI 中均为可选。`--no-config` 忽略默认配置文件。显式指定的配置文件不存在、内容无效或默认文件无效时会报错，不会静默回退。

```sh
# 完全通过命令行启动 Vault，目录必须已经存在
# 保存秘密值供后续启动复用，链接保持不变；CRDT 历史每次重新建立
share_key=$(openssl rand -hex 32)
./target/debug/celestite-server --no-config \
  --listen 127.0.0.1:7437 \
  --allowed-origin http://localhost:1420 \
  --vault ./notes --name '我的笔记' \
  --share-key "$share_key"

# 覆盖部分配置
./target/debug/celestite-server --config ./config.toml \
  --listen 127.0.0.1:8080 \
  --web-dir ./web/dist \
  --vault ./another-directory \
  --read-only false
```

| 参数                      | 行为                                            |
| ------------------------- | ----------------------------------------------- |
| `-c, --config FILE`       | 读取指定 TOML 文件                              |
| `--no-config`             | 不读取默认配置文件，与 `--config` 互斥          |
| `--public-url URL`        | 覆盖启动链接的公开 HTTP(S) 基址；不改变监听地址 |
| `--listen IP:PORT`        | 覆盖监听地址；内置默认 `127.0.0.1:7437`         |
| `--allowed-origin ORIGIN` | 可重复；整体替换配置中的来源列表                |
| `--clear-allowed-origins` | 清空显式来源列表；server 自身来源仍允许         |
| `--web-dir DIRECTORY`     | 覆盖静态 Web 资源目录                           |
| `--no-web`                | 禁用配置中的静态 Web 资源目录                   |
| `--vault PATH`            | 指定或覆盖唯一 Vault 的目录                     |
| `--name NAME`             | 覆盖显示名称；默认 `Vault`                      |
| `--share-key KEY`         | 可选分享秘密值；省略时生成临时链接              |
| `--read-only true\|false` | 覆盖 Vault 的只读状态                           |

命令行目录路径以**当前工作目录**为基准，配置文件中的路径以**配置文件所在目录**为基准。覆盖目录保留显示名称、秘密值与只读状态，除非另行覆盖。路径和秘密值中的 `=` 为普通字符，不再使用 `ID=VALUE`。包含空格的参数应加引号。重复的单值参数、互斥设置都会报错；只有允许来源列表接受重复参数。

`server.web_dir` 可指向 `bun run --cwd web build` 的产物目录；server 同时提供这份 UI。二进制本身不嵌入 Web 资源。静态目录应仅包含可信构建产物，不允许与 Vault 目录重叠。默认监听回环地址；网络访问通过 URL 中的完整随机 key 鉴权，不依赖账号。readonly 的 `ro-` 属于凭证，修改前缀不会转换权限。HTTP 和 WebSocket 共用授权，readonly 允许读取、预览和实时更新，edit 允许正文及目录修改，仍受 Vault 级 `read_only` 限制。Vault 启动时固定提供两条链接，通过配置轮换，无独立分享管理接口。公网使用 HTTPS / WSS，反向代理需转发 WebSocket，并脱敏访问路径中的 key。普通请求日志脱敏 key，授权响应使用 `no-store` / `no-referrer`。CORS 支持 `If-Match`、`Content-Type` 和读取 `ETag`，有 Origin 的请求另行检查来源；CORS 不承担认证。

## 日志

server 使用 `tracing`，二进制通过 `tracing-subscriber` 输出到 stderr，默认级别 `info`。`RUST_LOG` 可覆盖过滤规则；无效规则会使启动失败。

```sh
RUST_LOG=celestite_server=debug,tower_http=debug just serve-notist "$share_key"
```

`info` 记录启动、Vault 初始化、CRDT 导入结果、磁盘保存与关闭；`debug` 增加 HTTP 请求状态码和耗时、线程池操作、更新包大小与因果版本回执。4xx 请求记为 `warn`，5xx 和内部操作失败记为 `error`。每个 HTTP 请求有独立 `request_id`，线程池日志沿用请求上下文。SSE 的响应耗时表示建立响应所需时间。

启动日志打印完整连接链接；普通请求日志脱敏 key 且不包含查询串、请求头或正文；同步日志只记录包大小和状态。作为 library 使用时，由调用者初始化 subscriber。

## API v1

下面路径均相对于 `/<key>/api/v1`，文件路径通过查询参数传递，使用 Vault 内相对路径与 `/` 分隔。空路径表示根目录。

| 方法   | 路径                               | 功能                                                    |
| ------ | ---------------------------------- | ------------------------------------------------------- |
| GET    | 根地址                             | 描述：协议、版本、ShareId、Vault 身份、名称、只读和能力 |
| GET    | `/directory?path=`                 | 直接子项，不读正文                                      |
| GET    | `/stat?path=`                      | 元数据；不存在返回 JSON null                            |
| GET    | `/file?path=`                      | 二进制正文、内容哈希 ETag，禁止缓存                     |
| PUT    | `/file?path=&mode=create`          | 不覆盖的新建，原始字节 body                             |
| PUT    | `/file?path=&mode=replace`         | 已有文件替换，必须带读取时的 If-Match                   |
| POST   | `/directory?path=&recursive=false` | 创建目录                                                |
| DELETE | `/entry?path=&recursive=false`     | 删除条目，根目录受保护                                  |
| POST   | `/rename`                          | JSON `{ "from": "a", "to": "b" }`，不覆盖目标           |
| GET    | `/events`                          | SSE 变化提示；连接和重连首帧使整个树失效                |

错误采用 JSON `{ code, message, path }`，前端恢复为 `VaultError`。多步操作不保证事务。每个 Vault 内操作串行，磁盘操作在线程池执行；服务内多个客户端的版本比较与提交在同一锁内完成。外部程序不参与该锁，内容核对与提交之间仍有竞争窗口；没有跨程序的原子 CAS 承诺。

文件写入先暂存并同步数据，再提交；替换保留权限位，失败尽量清理暂存文件。暂存名称前缀 `.celestite-tmp-` 为保留命名空间，目录列表隐藏该前缀。异常退出可能留下暂存文件，MVP 不自动清理未知遗留文件，也不承诺断电后目录项已持久化。原子写入更换文件身份，其他硬链接不会同步更新；扩展属性/ACL 尚未复制。

不覆盖移动及文件提交当前验证并实现于 **Linux**；其他平台返回 Unsupported。跨挂载点移动返回 Unsupported，不自动复制/删除。符号链接可列出、删除或移动链接本身，正常操作不跟随链接；访问通过受限目录句柄，防止链接逃逸 Vault。对 Vault 内目录的并发替换仍以平台能力和实际错误为准。

notify 提供粗粒度提示，服务写操作也主动发送提示。监听不是可靠操作日志，事件溢出会发送全树失效，可能重复通知。网络挂载的外部变化未必能被系统监听捕获，可手动刷新。远端 Web 编辑器通过 WebSocket 加入历史、发送实时 CRDT 增量与显式保存命令。外部文件修改经 host bridge 合入历史并主动推送。

文件请求上限 64 MiB；正文整体进出内存。前端编辑上限仍为 5 MiB。请求超时或断网不会自动重放写操作，错误提示核对服务器状态。普通文件 API 不承担协作；在线文本协作使用下述 WebSocket 会话，离线编辑暂不支持。普通文件写请求仍不提供断线去重。

## 在线协作 WebSocket

描述接口报告 `websocketSync: true`。每个客户端 VaultInstance 建立一条 `/<key>/api/v1/sync` 连接；HTTPS 使用 WSS，反向代理需转发 WebSocket upgrade。分享鉴权与来源检查发生在升级前；首个 JSON 消息只校验协议和预期 Vault / 历史身份：

```json
{
  "protocolVersion": 2,
  "vaultIdentity": {
    "id": "描述接口的 id",
    "historyId": "描述接口的 historyId"
  }
}
```

host 返回 `hello`（`sessionId`）和 `ready`，握手不加载文件或发送文档。客户端 `open` 时，host 创建或复用对应 Buffer，分配该会话的十进制 `writerId` 并返回完整快照，同时订阅后续变化。快照与订阅在同一串行边界建立；只有本会话打开过的 Buffer 才会推送 `document`（元数据、`packet`、writer 和递增 `sequence`）。文本来自 CRDT 包；元数据不重复发送正文，`savedContent` 仅在初次打开或磁盘基线改变时发送。慢消费者只补齐其已订阅 Buffer；无法导出历史时结束会话，客户端冻结并保留正文。

请求均为 `{ sessionId, requestId, method, ...参数 }`，响应为 `{ kind: "reply", requestId, result }` 或 `error`：

| method  | 参数                           | 行为                                                                               |
| ------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| open    | path 或 id，二选一             | 按路径创建 / 复用 Buffer，或重连时按 ID 加入；返回快照与元数据                     |
| updates | id, packet, version, operation | 按会话递增序号提交本 writer 的增量；完整依赖、身份和 writer 验证后在内存接受并确认 |
| save    | id, version                    | 指定已见因果版本，单独条件写回物理文件；版本过期先补齐再重试                       |
| probe   | id, version                    | 查询已提交历史是否包含给定因果检查点，核对丢失的确认                               |
| ping    | —                              | 返回 pong；host 每 10 秒发送 heartbeat，超时终止会话                               |

`document`、`tree` 和 `heartbeat` 为主动通知；`tree` 使文件树失效，实际目录仍通过 HTTP 查询。除 `open` 和 `ping` 外，命令要求目标 Buffer 已在本会话打开。会话缓存最近 256 条操作回执，同序号同包重发返回原回执，变更载荷或跳号被拒绝；回执过期用因果检查点核对。重连分配新会话与 writer，按 ID 重新打开此前订阅的 Buffer，拒绝旧 writer 的未提交操作，不自动重放。回执只表示内存接受，server 重启后旧历史失效。

客户端的个人撤销也生成自己的 CRDT 增量。输入同步不隐式保存普通文件；保存可能写回已经合入的其他 writer 修改。外部文件变化按磁盘历史分支合并，客户端不能用“丢弃”清除所有人的共享未保存历史。客户端导入保留当前 writer / 撤销，UI 映射待确认输入和选区，IME 期间暂缓导入；断线时整个 Vault 工作区（文件树与编辑区）显示遮罩并禁止交互，重新认证核对历史身份并从 host 重建会话；未确认输入可导出正文或明确丢弃，不自动重放。`probe` 保留为调试与因果检查接口，首期 Web 重连流程不使用它恢复旧输入。

## 无头编辑器 API

下面路径仍相对于 `/<key>/api/v1`。正文与文档业务由 `celestite-core::EditorCore` 管理，不需要标签页、CodeMirror 或浏览器。所有返回值禁止缓存，沿用 Vault 的认证、来源检查与只读约束。

| 方法 | 路径                                  | 请求 / 行为                                                                                     |
| ---- | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| GET  | `/documents`                          | 核对并返回已加载的 Buffer，不扫描或加载未打开文件                                               |
| POST | `/documents/open`                     | `{ "path": "a.md" }`，登记文件并返回稳定文档 ID 与状态                                          |
| GET  | `/documents/<document>`               | 正文、因果版本、撤销与保存状态；重新核对磁盘                                                    |
| GET  | `/documents/<document>/snapshot`      | 完整 `SyncPacket`，新副本从这里加入同一历史                                                     |
| POST | `/documents/<document>/updates`       | `Version`，返回该版本之后的更新包                                                               |
| POST | `/documents/<document>/apply`         | `BufferCommand`，统一编辑、撤销、重做、导入和清除个人撤销；返回 `{ document, update, history }` |
| POST | `/documents/<document>/save`          | 当前 `Version`，条件写回文件，返回更新的状态                                                    |
| POST | `/documents/<document>/client-commit` | `{ packet, expectedRevision, action }`，客户端副本条件提交，返回 `{ document, packet }`         |

命令由 `kind` 区分；命令和回执的多词字段采用 `camelCase`，历史身份保留 `document_id` / `history_id`。`Version = { identity: { document_id, history_id }, clocks: { "十进制 writer ID": counter } }`。writer ID 用字符串，避免 JS 64 位整数精度丢失。`SyncPacket = { identity, kind: "snapshot" | "updates", data: [byte, ...] }`。JSON 字节数组用于当前测试传输，未来可加入二进制 framing。

`clientReplicaCommit: true` 表示支持独立 HTTP 副本以指定磁盘基线进行条件保存；正常 Web 编辑使用 WebSocket。`client-commit` 的 `action` 为 `save`、`overwrite` 或 `discard`：保存先核对 `expectedRevision`，基线不符时拒绝导入客户端操作；覆盖明确选择客户端正文；丢弃不发送客户端包，重新取得 host 最新文件。返回的完整快照用于补齐客户端历史，文档状态确认实际文件基线。快照限制为 16 MiB，文档请求 JSON 上限为 80 MiB 以容纳字节数组编码；仍使用既有认证、只读约束和 Vault 操作锁。

host 有尚未写回的正文时，客户端丢弃返回冲突，保留 host 修改；先处理 host 保存，再重试客户端丢弃。

事务示例：

```json
{
  "kind": "edit",
  "base": {
    "identity": { "document_id": "来自状态", "history_id": "来自状态" },
    "clocks": {}
  },
  "origin": "headless-client",
  "input": {
    "kind": "edits",
    "edits": [{ "from": 0, "to": 0, "insert": "hello\n" }]
  },
  "group": null,
  "undo": { "metadata": null, "positions": [] }
}
```

`base` 必须完整使用刚读取的 `snapshot.version`，示例中的空 clocks 不是现有文件的真实版本。`from/to` 是事务之前正文的 UTF-16 半开区间，不能切开 emoji 等字符的代理对；多项编辑必须有序且互不重叠。内核一次验证所有编辑，然后提交一个撤销步。过期事务 / 保存返回 `409 StaleVersion`，非法坐标和更新包返回 `400 InvalidEdit`。不同文档或历史之间的导入被拒绝。

`input` 也可为 `{ "kind": "text", "text": "完整目标正文" }`，仍进入 Buffer 的同一事务路径。撤销 / 重做命令为 `{ "kind": "undo" | "redo", "base": Version, "context": { "positions": [] } }`，导入为 `{ "kind": "import", "packet": SyncPacket }`，清除个人历史为 `{ "kind": "clear_undo" }`。

`update` 包含版本、显示增量、撤销上下文和原始操作；`history.status` 为 `committed` 或 `failed`。失败的历史提交仍返回已接受的正文，不能当成编辑被拒绝或盲目重发。普通文件写回依然是独立操作；WebSocket 只在历史提交后确认。server 会话的身份与因果检查使用准备好的导入结果，随后直接提交，不重复构造临时副本。

协作客户端各自从完整快照建立 `Buffer`，使用新的 writer，只发送命令结果中的本地 CRDT 操作。重复和乱序包按 CRDT 语义处理；依赖未齐的包保留，后续补齐。个人撤销也由客户端产生操作，不请求 server 代为撤销。直接向此 HTTP API 发出本地编辑 / 撤销命令会使用 server writer，因此该入口用于无头控制与开发测试，而非分配协作者身份。

### 内存历史与磁盘保存

server 的 Buffer、CRDT 历史、待补齐依赖、磁盘基线和操作意图只保留在内存中。启动无需状态目录或历史初始化：

```sh
mkdir -p /tmp/celestite-demo/notes
share_key=$(openssl rand -hex 32)  # 保存该值，后续启动复用
cargo run -p celestite-server -- --no-config \
  --vault /tmp/celestite-demo/notes \
  --share-key "$share_key"

# 仓库内 ../notist/docs 的开发入口：
just serve-notist "$share_key"
```

描述接口始终报告 `persistentHistory: false`，文档的 `durableVersion` 为 null。`dirty` 表示正文与最后已保存文本不同；`savedVersion` 是当前磁盘基线对应的因果版本（含已接受的外部保存）。内存历史确认不等于写回 `.md`，`/save` 是独立动作。没有可见文本变化的导入也可能推进因果版本；等待依赖的包不会被虚报为已应用版本。

server 重启丢弃未写回正文和历史，并生成新的 `historyId` 与实例身份；打开文件时从当前磁盘字节建立新文档 ID 和历史。旧客户端保留内存正文并拒绝重连到新历史，需要保留正文后重新打开连接。同一进程内重连可以恢复 host 已接受的编辑，包括回执丢失的操作。

保存通过哈希条件检查与暂存替换写文件，core 在进程内保留保存阶段和回执。结果不确定时暂停自动处理并保留正文；这些意图不跨重启恢复。普通文件 IO 不提供外部写入来源证明或跨程序 CAS，也不重放崩溃前的目录操作。

host 通过 core 的 `EditorOptions.external_changes = Merge` 启用外部修改合并，Backend 只负责 IO。core 保留磁盘的精确字节和历史版本；外部变化从该版本 fork，以独立 writer 生成有时间预算的 Unicode 细粒度 diff，再合入当前正文。连续观察沿磁盘分支推进，保留活动 Buffer 的 writer、个人撤销和订阅。重复提示及自身写回不生成额外文本操作，格式变化仅更新基线；超时、非法正文与不确定写回不会退化为整篇替换。启动注册递归监听；运行时由有界合并的监听唤醒后台核对，每 30 秒核对已加载 Buffer 以兜底漏报，不加载未打开文件。目录变化仍向全部客户端提示。单个无效 / 不可读文件不会阻止其他文件。外部删除保留原文档、未保存正文和历史并报告缺失；外部移动不按相同内容推断身份，稳定移动通过 host API 完成。原文件 API 也不能绕过未保存 CRDT 正文直接覆盖文件。通过 server 移动文件 / 目录保持已加载文档 ID；删除保留进程内历史，延迟保存不能重建旧路径。

### 文档变化通知

外部 diff 在后台释放 Vault 文件锁与文档锁后计算，提交时重新核对磁盘与基线。读取和增量导出始终返回当前已提交历史；计算未完成时不等待新磁盘内容，文档元数据中的 `externalChange` 显示 `pending` 或 `failed`（`code`、`message`、`retryAt`）。状态变化也通过 SSE / WebSocket 推送，不要求先有正文版本变化。

待协调时保存返回 `409 FilesystemReconciliationPending`，计算超时返回 `409 FilesystemDiffTimeout`，两者都携带文件路径并保留历史和磁盘内容。相同失败输入从 30 秒退避至最多 5 分钟；新内容绕过退避。`POST /documents/<document>/retry-observation` 或 WebSocket `retry_observation`（参数 `id`）立即重新排队，返回当前文档状态；重试只协调，不写回物理文件，也允许只读 Vault 使用。

`GET /<key>/api/v1/documents/events` 提供需要相同认证的 SSE（`event: documents`，`Cache-Control: no-store`）。连接首先收到 `kind: "resync"` 的全部已加载 Buffer 元数据，之后收到 `kind: "changed"` 的变化条目；通知包含 `streamId`、递增 `sequence`、`vaultIdentity` 和 `persistentHistory`。各条目包含文档 ID、路径、已接受 `version`、`savedVersion`、磁盘 revision、dirty / conflict / deleted / available 与错误状态，不传正文，也不加载其他文件。

初始元数据与 receiver 在同一 core 锁下建立，订阅后出现的变化进入 receiver；消费者落后超过广播缓冲时重新原子取得全部驻留状态和新 receiver。重连始终重新核对，`Last-Event-ID` 不表示持久化操作回执；server 重启改变 `streamId` 和历史身份。客户端收到通知后通过 `/snapshot` 或 `/updates` 获取 CRDT 内容。

描述接口报告 `documentEvents: true`。此通道是状态核对提示，不确认编辑请求，也不提供会话有效性、重发去重或在线租约；在线编辑由 WebSocket 会话协议提供这些约束。原 `/events` 继续提供文件树提示。

### 当前范围

已实现独立文本 CRDT 与单个 server 的文件协调。打开文本时才建立 Buffer，排除符号链接、非 UTF-8 / 二进制内容及超过 5 MiB 的文件；内存正文为 LF，保存恢复文件原有 BOM 与首个换行样式，混合换行会统一。当前关闭标签不取消订阅，已加载的 host Buffer 保留到进程结束，以保留已接受但未保存的编辑。尚未实现目录 Catalog CRDT、整个 Vault 的离线结构合并、附件同步、工作集淘汰、历史压缩或 P2P 同步。描述接口明确报告 `vaultCrdt: false`。

移动 / 删除的物理结果保留在文件系统中，内存元数据与目录操作不构成跨资源原子事务。外部程序 rename 的稳定身份识别暂未实现。HTTP 导入保留为无头 / 调试传输，SSE 保留为变化提示；远端 Web 使用自己的 Rust WASM core 和实时 WebSocket 会话。

## 多实例与可视化调试

多个独立客户端可从同一快照加入，通过 `/updates` 与 `/apply` 的 import 命令交换各自 writer 的历史。生产连接使用 WebSocket 会话、心跳和主动广播；调试页通过目录元数据列出文件，选择文档后才打开，保留 HTTP 主动拉取，不提供在线成员 / presence 列表。客户端个人撤销在自己的 core 上执行，不能用服务端 writer 的 undo 命令替代。

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

无头 Rust 测试使用临时目录和随机端口，覆盖独立副本合并、个人撤销、按需打开与会话订阅、过期版本、非法 / 跨历史导入、进程内乱序更新补齐、重启丢弃未保存历史、外部修改、移动 / 删除、BOM / CRLF 与只读约束。

## 预览 package 资源

Vault 根目录只确定文档范围。`Notist.toml` 中的 package 路径相对于该配置解析，可使用 `../packages/grammar` 或绝对路径；无需扩大 Vault 根或迁移文档历史。

描述接口的 `previewResourceRoot` 提供编译资源解析根。`POST /<key>/api/v1/preview/resources` 接收 `{context: {documentPath, overlays}, request: {path, read}}`，返回文件种类、可选字节或不存在状态；`POST /<key>/api/v1/preview/directory` 接收相同 `context` 和绝对 `path`，返回直接子项。`overlays` 包含 Vault 内的 `Notist.toml` 未保存正文及已读取的外部清单源码快照，不写入磁盘；外部身份使用规范绝对路径，仅在 Notist 依赖图实际读取时生效。资源发现由 Notist 执行，这两条接口只读取直接或递归依赖的 `Notist.toml`、`lib.notc` 与 `components/`，沿用 Vault 的认证与来源检查；单文件上限 16 MiB，目录内部符号链接不跟随。

每个 package 的清单声明 `[package].name`，依赖键与名称一致。递归依赖、根配置的开发依赖和各作用域的 transforms 均由 Notist 装配；server 只提供资源。外部清单、声明与组件目录变更触发预览失效通知，不运行文档协调，也不将 package 导入文件树或 CRDT 历史。外部配置和声明诊断由 Web 显示只读源码快照。启用这些接口需要重新构建并重启 server；现有 Vault 路径和状态目录保持原配置。
