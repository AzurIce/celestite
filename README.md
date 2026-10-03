# Celestite

对标 Obsidian 的笔记 / PKM 编辑器。Web 自带 OPFS 默认 Vault，可连接由独立 server 提供的目录 Vault；Tauri 后端暂未接入。

- [Web 开发与界面说明](web/README.md)
- [server 配置、启动与 API](crates/celestite-server/README.md)
- [server 配置示例](crates/celestite-server/config.example.toml)

```sh
bun run --cwd web dev
cargo build -p celestite-server
./target/debug/celestite-server --config /path/to/config.toml
```
