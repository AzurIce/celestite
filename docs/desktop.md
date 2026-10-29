# Celestite desktop

原生编辑会话运行时位于根 `celestite` 应用库的 [`src/runtime`](../src/runtime/mod.rs)，作为应用内部模块实现和测试。它不直接依赖 WebView API；[`src/commands.rs`](../src/commands.rs) 在阻塞任务中调用它，每个会话独占 EditorCore、EditorAdapter 和独立 PreviewController；不同会话可以并行。本机实例分别注入普通目录与应用私有恢复目录的 FileSystem，远端会话只在内存持有 Buffer。原生文件能力由 core 提供，本机 package 授权位于 `preview::native`；`native` feature 只在非 Wasm 目标启用这些实现。server 复用文件与 package 能力，历史继续驻留内存。

`DesktopRuntime::open(app_data)` 创建运行时，`open_session` 接收默认库、本机目录或远端实例身份。宿主从私有 profile 恢复稳定 instanceId / vaultId，每次运行生成新的 historyId，再将身份和两个文件空间交给 core；文档 ID 和默认时钟由 core 统一提供。默认库位于 `app_data/default/files`，明文草稿、磁盘基线和操作意图单独保存。私有恢复区不保存 CRDT 快照、增量或个人撤销；进程重启从明文建立新历史。同一本机目录重复接入复用 owner，WebView 代次切换通过 `reset_views` 清理旧预览、语言服务与远端会话，保留仍存活的本机 Buffer 和个人撤销。

前端 `CorePort` 传递对象参数与 `CoreReply`，Tauri 直接调用结构化 IPC，WASM 适配器独自处理字符串编解码。桌面以标准 `MessageChannel` 接入共享编辑服务。`core(handle, method, params)` 返回与 WASM 相同的命令与 mutation 批次；错误不会吞掉此前已接受的变化。`preview` 承载独立控制器方法，package 读取使用 `ResourceContext` 中的正文及依赖快照重新核对资源范围，不保存正文，也不占用编辑所有者的 IO 等待。

本机会话的语言服务由 `language(handle, command)` 驻留，与 Web 共用服务、客户端及打开文档同步。查询 URI 保持 `file:///vault/…`；资源解析使用实际 Vault 根，完整保留相对父目录与绝对依赖身份。库内资源经 `LocalFiles` 的观察边界读取；外部资源复用 package 授权及观察，单独使用语言服务也能发现依赖变化。远端副本使用 WASM 语言 Worker，由 HTTP host 提供同一契约的只读依赖。WebView 重建清理旧语言状态，新客户端重新握手并同步文档。

平台给普通文件 IO 添加观察边界，私有空间使用独立 FileSystem；明文恢复格式、checkpoint、编辑与保存策略均由 `EditorCore` 决定。`LocalFiles` 让编辑与预览读取共用目录监听屏障，并核对持有的 Vault 根句柄与当前路径是否仍对应同一目录；根被替换时保留草稿并明确报失联，不自动绑定新目录。

`WatchService` 在独立线程中按需注册单目录监听，开库只异步登记根及父目录锚点。读取目录前确认该目录及祖先的监听，恢复文档在后台登记父目录；未访问子树不枚举、不递归监听。普通路径拒绝符号链接，显式 package 同时观察授权别名的锚点、实际根和已读取资源目录。新观察范围与重建监听都会触发一次核对，目录替换自动重挂；后端监听故障重试并触发保守轮询，不剥夺已授权的文件读写。定时检查有界合并，窗口聚焦强制核对工作集及已展开文件树。

预览执行器接收异步任务、资源读取函数与取消信号；浏览器适配器持有 Worker，桌面直接调用 native 分析与渲染。预览所有者统一管理任务、超时、资源快照和迟到结果，取消不会在分析完成后继续启动已放弃的渲染。

`close_session` 完成明文 checkpoint 才移除会话；`shutdown` 先验证全部会话可完成 checkpoint，再统一释放。运行时不替 UI 判断尚未提交的投影，也不替协作会话判断 host 确认，因此桌面关闭先由前端排空输入和确认屏障。失败保留 owner；成功立即释放私有恢复区锁，不依赖派生读取何时结束。

接受编辑不等待恢复 IO；恢复写入按首次待写起 500ms 的硬期限合并，连续输入不延后。checkpoint 失败通过 `recoveryError` 展示，已接受正文保留且编辑可继续。显式 checkpoint 与关闭会重试当前明文；失败保留窗口和 owner。旧私有 CRDT 数据只迁移一次明文与恢复证据，不延续旧历史或撤销。

## 开发与验证

仓库根目录进入开发环境后运行：

```sh
bun run --cwd web tauri dev
bun run --cwd web tauri build
cargo test -p celestite --lib
cargo test --workspace
```

根 `src/commands.rs` 只处理 IPC 和阻塞任务执行。应用设置与连接存于应用私有目录；`CELESTITE_APP_DATA_DIR` 可在开发和测试时隔离数据。组件资源由专用内存 URI scheme 提供，普通文件下载和草稿导出使用系统保存对话框。

[`src/runtime/tests.rs`](../src/runtime/tests.rs) 在根应用库内覆盖明文草稿、保存基线、重启历史身份、checkpoint 失败后继续编辑、关闭重试、同目录重连、预览、package 授权与文件观察；文件能力和监听边界的单元测试与模块放在一起。平台构建、真实 WebView 和系统对话框需要与运行系统一起验收。

目录启动基准使用临时私有恢复区，仅枚举指定 Vault 的根目录，不修改普通文件：

```sh
CELESTITE_BENCH_VAULT="$HOME/Files/Vault" cargo test -p celestite --lib runtime::tests::measure_open -- --ignored --exact --nocapture --test-threads=1
```

输出分别报告开库、根目录枚举和关闭耗时；Linux 同时报告该进程的原生目录监听数量。只运行这一项基准且使用单个测试线程，避免其他测试干扰进程监听计数。

Linux 的真实 WebView 验收使用独立应用数据和临时 Vault，不读取个人配置：

```sh
bun run --cwd web tauri build --debug --no-bundle
cargo build -p celestite-server
python3 scripts/test-desktop.py --output /tmp/celestite-gui-acceptance --server-binary target/debug/celestite-server
```

脚本需要 Python 3、WebKitWebDriver 和 Xvfb；可用 `--webdriver` / `--xvfb` 显式指定路径。它验证原生编辑、保存与撤销、预览与组件 ESM / WASM、保存失败保窗、进程中断恢复、WebView 重载、外部文件变化、本机目录和远端协作，并输出截图、IPC 轨迹和 `report.json`。
