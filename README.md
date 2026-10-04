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
  - OPFS 存储实现
  - File System Access API 存储实现（WIP）
- Tauri App（WIP）
  - Tauri API 存储实现
- Native Headless Server
  - Native 存储实现

**实时协作**

CRDT 单 Host 多人协作

- Web App（Client）
- Tauri App（WIP, Client, Host）
- Headless Server（Host）

**And More...**
