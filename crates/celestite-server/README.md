# Celestite server MVP

独立 Rust 可执行程序。Vault 由 `config.toml` 注册，Web 客户端通过 Vault URL 连接；客户端没有创建或删除远端 Vault 的接口。Tauri 尚未接入，共享目录操作位于 `celestite-core`。

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

notify 提供粗粒度提示，服务写操作也主动发送提示。监听不是可靠操作日志，事件溢出会发送全树失效，可能重复通知。网络挂载的外部变化未必能被系统监听捕获，可手动刷新。已打开编辑器目前保留缓冲区，外部文件变化不自动重载正文；下次保存通过 ETag 检测冲突，保留编辑且不继续自动保存。MVP 尚未提供冲突合并界面。

文件请求上限 64 MiB；正文整体进出内存。前端编辑上限仍为 5 MiB。请求超时或断网不会自动重放写操作，错误提示核对服务器状态。没有离线同步、协同编辑或断线写请求去重。

## 验证

```sh
cargo test -p celestite-core -p celestite-server
cargo build -p celestite-server
bun run --cwd web test:vault
bun run --cwd web test:ui tests/multi-vault.spec.ts
```

浏览器测试启动临时真实 server，使用临时目录和随机端口。默认寻找 `target/debug/celestite-server`，可以用 `CELESTITE_SERVER_BIN` 指定其他构建产物；自定义 Chromium 路径用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`。覆盖二进制文件、目录操作、版本冲突、外部监听、认证、连接持久化、Vault 切换和撤销历史、只读与移动端。
