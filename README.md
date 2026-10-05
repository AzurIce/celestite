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

**多平台支持 & 多后端存储实现抽象**

- Web App
  在本仓库 Github Pages 开箱可用
  - 浏览器存储实现（`BrowserBackend`）：私有历史存于 OPFS，普通文件可使用 OPFS 或 File System Access API 本机目录
  - 内存存储实现（`MemoryBackend`）：保存远端 Vault 客户端的会话历史
- Tauri App（WIP）
  - Tauri API 存储实现
- Native Headless Server
  - Native 存储实现（`NativeBackend`）：访问本机目录，可配置 redb 历史持久化

远端客户端的 `MemoryBackend` 保存文本快照与增量，不提供普通文件或目录映射；目录与附件通过 HTTP 访问 host，文本历史通过 WebSocket 同步。客户端副本随 Worker 结束而释放。状态归属与请求流程见 [Web 当前状态与请求交互](docs/state/web.md)。

**实时协作**

CRDT 单 Host 多人协作

- Web App（Client）
- Tauri App（WIP, Client, Host）
- Headless Server（Host）

**And More...**

## 文档

- [目标架构](docs/architecture.md)
- [实施路线图](docs/roadmap.md)
- [Web 当前状态与请求交互](docs/state/web.md)
