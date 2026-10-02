docs/_logs 内的文档为“日志文档”以 `yyyy-mm-dd <topic>` 命名，禁止引用外部会变更的文档。

## 格式化（agent 必须遵守）

Web 代码（`.ts .tsx .js .jsx .css .html .json .md`）的统一格式化工具是 **prettier 3.9.9**，与 Zed 内置格式化器同版本、同读 `web/.prettierrc.json`，CLI 与 Zed 输出逐字节一致（已实测验证）。

- 修改 web 代码后、交付前必须执行：`bun run --cwd web format`（在 `web/` 目录内则为 `bun run format`）
- 提交前 `bun run --cwd web format:check` 必须通过；不允许带着格式问题交付
- 不要手动把代码"掰"成 prettier 的风格再交，一律跑 format 让工具统一处理
- 禁止擅自修改 `web/.prettierrc.json`：它会同时决定 Zed 里的格式化结果。要改先和用户确认
- 新目录/新文件若不该被格式化，加入 `web/.prettierignore`
- 版本对齐：devDependency 里的 prettier 版本必须等于 Zed 内置格式化器版本（记录在 `~/.local/share/zed/prettier/package.json`，当前 3.9.9）。Zed 升级后如该版本变化，同步升级 devDependency，否则两边输出可能漂移

Rust 目前未强制该流程：`cargo fmt --all` 可用（flake 固定 nightly-2026-08-01），需要同等体验时再补 `rustfmt.toml` 与同款规则。
