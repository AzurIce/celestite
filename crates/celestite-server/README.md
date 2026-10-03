# Celestite server MVP

独立 Rust 可执行程序。Vault 由配置文件或 server 命令行注册，Web 客户端通过 Vault URL 连接；客户端没有创建或删除远端 Vault 的接口。Tauri 尚未接入。目录操作位于 server 的 `vault/fs.rs`；`celestite-core` 提供独立的 Rust / WASM 文本编辑内核，server 是它的第一个无头宿主。

## 启动

从仓库根目录执行：

```sh
cargo build -p celestite-server
mkdir -p /tmp/celestite-demo/notes
cp crates/celestite-server/config.example.toml /tmp/celestite-demo/config.toml
./target/debug/celestite-server --config /tmp/celestite-demo/config.toml
```

打开 Web 客户端，在底部“管理 Vault”中连接 `http://127.0.0.1:7437/api/v1/vaults/notes`。例子允许默认 Vite 客户端 `http://localhost:1420` 与 `http://127.0.0.1:1420`；其他客户端来源要加入 `allowed_origins`。

配置内目录必须已经存在；相对路径以配置文件目录为基准。Vault ID 只接受 ASCII 字母、数字、`-`、`_`。ID 唯一，根目录不得相同或互相嵌套。配置启动时读取，修改后重启生效。Ctrl+C / SIGTERM 会结束事件订阅并等待正在处理的请求，避免 SSE 长连接阻止退出。名称与目录可修改，保留 ID 即保留 URL。

## 命令行

使用 clap 解析参数，`--help` 查看全部选项，`--version` 查看版本。优先级为 **命令行 > 配置文件 > 内置默认值**。不指定 `--config` 时读取当前目录的 `config.toml`（如果存在）；没有配置文件时，可以通过 `--vault` 直接启动。`--no-config` 忽略默认配置文件。显式指定的配置文件不存在、内容无效或默认文件无效时会报错，不会静默回退。

```sh
# 完全通过命令行启动，目录必须已经存在
./target/debug/celestite-server --no-config \
  --listen 127.0.0.1:7437 \
  --allowed-origin http://localhost:1420 \
  --vault notes=./notes --vault-name 'notes=我的笔记' \
  --vault reference=./reference --vault-read-only reference=true

# 覆盖部分配置；其他 Vault 及设置保留
./target/debug/celestite-server --config ./config.toml \
  --listen 127.0.0.1:8080 \
  --web-dir ./web/dist \
  --vault notes=./another-directory \
  --vault-read-only notes=false
```

| 参数                               | 行为                                                         |
| ---------------------------------- | ------------------------------------------------------------ |
| `-c, --config FILE`                | 读取指定 TOML 文件                                           |
| `--no-config`                      | 不读取默认配置文件，与 `--config` 互斥                       |
| `--listen IP:PORT`                 | 覆盖监听地址；内置默认 `127.0.0.1:7437`                      |
| `--allowed-origin ORIGIN`          | 可重复；整体替换配置中的来源列表，`--allow-origin` 是别名    |
| `--clear-allowed-origins`          | 清空显式来源列表；server 自身来源仍允许                      |
| `--token-env VARIABLE`             | 覆盖用于读取访问令牌的环境变量名                             |
| `--no-token`                       | 清除配置中的令牌要求；非回环监听仍会拒绝启动                 |
| `--web-dir DIRECTORY`              | 覆盖静态 Web 资源目录                                        |
| `--state-dir DIRECTORY`            | 启用持久化 CRDT 历史；目录需存在且不得与 Vault、静态资源重叠 |
| `--no-web`                         | 禁用配置中的静态 Web 资源目录                                |
| `--vault ID=PATH`                  | 可重复；新增 Vault 或仅覆盖已有 Vault 的目录                 |
| `--vault-name ID=NAME`             | 可重复；覆盖已声明 Vault 的显示名称                          |
| `--vault-read-only ID=true\|false` | 可重复；覆盖已声明 Vault 的只读状态                          |

命令行目录路径以**当前工作目录**为基准，配置文件中的路径仍以**配置文件所在目录**为基准。新增 Vault 默认名称为 ID、可写；覆盖已有 Vault 目录保留其名称与只读状态，除非另行覆盖。不支持通过命令行移除配置中的 Vault，完全替换注册列表可使用 `--no-config` 加多个 `--vault`。

`ID=VALUE` 仅按第一个 `=` 分隔，路径和名称可包含后续 `=`；包含空格的整个参数应加引号。同一种 Vault 参数内重复 ID、未声明 ID 的名称/只读覆盖都会报错。清除选项与对应设置选项互斥。令牌参数只接受环境变量名称，令牌本身不会进入命令行参数或 URL。

`server.web_dir` 可指向 `bun run --cwd web build` 的产物目录；server 同时提供这份 UI。二进制本身不嵌入 Web 资源。静态目录应仅包含可信构建产物，不允许与 Vault 目录重叠。默认监听回环地址；监听其他地址必须配置 `token_env`，从环境变量读取 Bearer token。前端令牌只保留在当前会话，连接 URL 与本地记录不包含令牌。远端 HTTPS 可由反向代理提供，代理后的客户端来源也需配置。CORS 支持 `Authorization`、`If-Match` 和读取 `ETag`，有 Origin 的 API 请求另行检查来源；CORS 不承担认证。

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

notify 提供粗粒度提示，服务写操作也主动发送提示。监听不是可靠操作日志，事件溢出会发送全树失效，可能重复通知。网络挂载的外部变化未必能被系统监听捕获，可手动刷新。现有 Web 编辑器仍通过文件 API 保存并在冲突时提示覆盖、丢弃或取消。新增无头文档 API 使用下面的 CRDT 与文件协调规则；Web 尚未迁入该内核。

文件请求上限 64 MiB；正文整体进出内存。前端编辑上限仍为 5 MiB。请求超时或断网不会自动重放写操作，错误提示核对服务器状态。现有 Web 文件 API 没有离线同步或协同编辑。无头文档 API 已能交换 CRDT 历史；普通文件写请求仍不提供断线去重。

## 无头编辑器 API

下面路径仍相对于 `/api/v1/vaults/<id>`。正文存于 `celestite-core::Document`，不需要标签页、CodeMirror 或浏览器。所有返回值禁止缓存，沿用 Vault 的认证、来源检查与只读约束。

| 方法 | 路径                             | 请求 / 行为                                                 |
| ---- | -------------------------------- | ----------------------------------------------------------- |
| GET  | `/documents`                     | 扫描整个目录，返回可编辑文本状态，包括未在 UI 打开的文件    |
| POST | `/documents/open`                | `{ "path": "a.md" }`，登记文件并返回稳定文档 ID 与状态      |
| GET  | `/documents/<document>`          | 正文、因果版本、撤销与保存状态；重新核对磁盘                |
| GET  | `/documents/<document>/snapshot` | 完整 `SyncPacket`，新副本从这里加入同一历史                 |
| POST | `/documents/<document>/updates`  | `Version`，返回该版本之后的更新包                           |
| POST | `/documents/<document>/import`   | `SyncPacket`，验证并合并；返回 `{ result, document }`       |
| POST | `/documents/<document>/transact` | `Transaction`，UTF-16 范围编辑；返回 `{ result, document }` |
| POST | `/documents/<document>/undo`     | `UndoContext`，可用 `{}`；撤销 server writer 的本地操作     |
| POST | `/documents/<document>/redo`     | 同上，重做                                                  |
| POST | `/documents/<document>/save`     | 当前 `Version`，条件写回文件，返回更新的状态                |

核心类型字段采用 Rust 的 `snake_case`；外层状态字段采用 `camelCase`。`Version = { identity: { document_id, history_id }, clocks: { "十进制 writer ID": counter } }`。writer ID 用字符串，避免 JS 64 位整数精度丢失。`SyncPacket = { identity, kind: "snapshot" | "updates", data: [byte, ...] }`。JSON 字节数组用于当前测试传输，未来可加入二进制 framing。

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

```sh
mkdir -p /tmp/celestite-demo/notes /tmp/celestite-demo/editor-state
cargo run -p celestite-server -- --no-config \
  --vault notes=/tmp/celestite-demo/notes \
  --state-dir /tmp/celestite-demo/editor-state
```

`state_dir` 也可写在 TOML `[server]` 中。不指定时，内核历史只驻留内存，重启会建立新身份和历史，状态中 `durableVersion` 为 null。指定后，每个配置 ID 对应一个 redb 文件，记录 Vault 身份、文件 ID、初始快照、追加更新日志与磁盘基线。每次提交成功后才报告 `durableVersion`；目录与 profile 绑定，不能将同一个 profile 静默用于另一目录。

`dirty` 表示正文与最后已保存文本不同；`savedVersion` 是最后磁盘写回时的因果版本；`durableVersion` 是已提交历史的应用版本。持久化历史不等于写回 `.md`，`/save` 是显式动作。没有可见文本变化的导入也可能推进因果版本。等待依赖的包已经写入日志，但不会被虚报为已应用版本。

保存先持久化写回意图，再通过原有哈希条件检查与暂存替换写文件，最后持久化回执。重启后识别已经写完、尚未记录回执的内容，完成基线更新。日志提交失败会使该宿主停止后续写入，并在状态中清除持久化确认、报告 `persistenceError`；应核对状态，不能把失败响应视为已保存。

外部程序修改文件时，正文干净则导入外部变化，使用独立 writer，避免进入 server 本地撤销；已有未保存编辑则保留两份内容，通过 `conflict` 和保存时的 `409 Conflict` 交给后续协调。原文件 API 也不能绕过未保存 CRDT 正文直接覆盖文件。通过 server 移动文件 / 目录保持文档 ID；删除保留历史，延迟保存不能重建旧路径。

### 当前范围

已实现独立文本 CRDT 与单个 server 的文件协调。`/documents` 当前扫描并加载全部合格文本，排除符号链接、非 UTF-8 / 二进制内容及超过 5 MiB 的文件；内存正文为 LF，保存恢复文件原有 BOM 与首个换行样式，混合换行会统一。尚未实现目录 Catalog CRDT、整个 Vault 的离线结构合并、附件同步、工作集淘汰、日志压缩或网络同步调度。描述接口明确报告 `vaultCrdt: false`。

移动 / 删除与 redb 元数据不是跨资源原子事务，正常重启保留结果，崩溃窗口仍需后续投影日志处理。外部程序 rename 的稳定身份识别暂未实现。HTTP 导入是拉取 / 提交参考传输，SSE 仍为变化提示；没有自动连接其他副本。Web、OPFS、Vim、Tree-sitter、LSP 尚未接入 Rust 内核。

## 验证

```sh
cargo test -p celestite-core -p celestite-server
# 只跑监听真实端口、无需浏览器的编辑器集成测试：
cargo test -p celestite-server --test headless_editor
# 校验 feature 后面的实际 WASM 绑定：
cargo check -p celestite-core --target wasm32-unknown-unknown --features wasm
cargo build -p celestite-server
bun run --cwd web test:vault
bun run --cwd web test:ui tests/multi-vault.spec.ts
```

浏览器测试启动临时真实 server，使用临时目录和随机端口。默认寻找 `target/debug/celestite-server`，可以用 `CELESTITE_SERVER_BIN` 指定其他构建产物；自定义 Chromium 路径用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`。覆盖二进制文件、目录操作、版本冲突、外部监听、认证、连接持久化、Vault 切换和撤销历史、只读与移动端。

无头 Rust 测试使用临时目录、随机端口及独立 redb profile，覆盖双副本离线合并、个人撤销、未打开文件发现、过期版本、非法 / 跨历史导入、乱序更新重启补齐、未保存正文恢复、外部修改冲突、移动 / 删除、BOM / CRLF 与只读约束。另有写完文件但回执未写时的恢复契约测试。
