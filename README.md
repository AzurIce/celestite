<div align="center">
  <img src="icons/128x128@2x.png" width="128" height="128" alt="Celestite 图标" />
  <h1>Celestite</h1>
  <p>WIP</p>
</div>

---

## 功能

**notist 语言内核**

通过 [AzurIce/notist](https://github.com/AzurIce/notist) 的统一 IR 与多前端实现支持多种文档语言（目前仅支持 `.md` 和 `.not`）的解析与预览。

基于 notist package（基于 Web Components）的文档元素拓展。

**多平台支持与文件空间抽象**

- Web App
  在本仓库 Github Pages 开箱可用
  - 普通文件使用 OPFS 或 File System Access API 本机目录；私有 OPFS 空间保存明文草稿与恢复证据
  - CRDT 历史与个人撤销由 Rust Buffer 在内存持有，远端副本随会话释放
- Tauri App
  - Native Rust 编辑内核与 IPC，默认库和本机目录共用 FileSystem 契约与明文恢复机制
  - 原生目录选择、设置与连接恢复、明文草稿恢复、预览、系统导出及远端协作客户端
- Native Headless Server
  - FileSystem 访问本机目录，协作历史仅驻留内存；与桌面共享 native 文件能力

远端客户端在 Buffer 内存中保存会话历史，不提供普通文件或目录映射；目录与附件通过 HTTP 访问 host，文本历史通过 WebSocket 同步。客户端副本随 Worker 结束而释放。状态归属与请求流程见 [Web 当前状态与请求交互](docs/state/web.md)。

**实时协作**

CRDT 单 Host 多人协作

- Web App（Client）
- Tauri App（Client）
- Headless Server（Host）

**And More...**

## 文档

- [目标架构](docs/architecture.md)
- [实施路线图](docs/roadmap.md)
- [EditorCore API 面](docs/core.md)
- [远端协议 v5](docs/protocol.md)
- [Web 当前状态与请求交互](docs/state/web.md)
- [桌面运行时与开发](docs/desktop.md)

## Nix 打包

在仓库根目录运行：

```sh
nix build
./result/bin/celestite
# 或直接构建并启动
nix run
```

默认包包含嵌入式前端、桌面启动项和图标，运行时的 GTK / WebKit 环境由包自身配置。`nix build .#web` 单独生成 Web 静态资源；`nix flake check` 检查桌面构建，以及前端类型和单元测试。

Flake 提供 `x86_64-linux`、`aarch64-linux` 和 `aarch64-darwin` 输出；macOS 包同时包含 `.app` 与命令行启动入口。首次构建会获取依赖，实际编译使用 Cargo / Bun 锁文件和固定哈希的离线依赖。修改 Web 依赖后需更新 `nix/bun-deps.nix` 的 hash；升级 wasm-bindgen 时同步更新 Cargo 锁文件、Web 构建脚本和 `nix/wasm-bindgen.nix`。

## 桌面开发

在仓库根目录进入 `nix develop` 后运行：

```sh
bun install --cwd web --frozen-lockfile
bun run --cwd web tauri dev
bun run --cwd web tauri build
```

桌面使用系统应用数据目录保存配置、明文草稿和恢复证据，普通 Vault 目录不包含这些数据。开发或测试可用 `CELESTITE_APP_DATA_DIR` 指定独立数据目录。
