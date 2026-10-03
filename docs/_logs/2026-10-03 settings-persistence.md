# 设置持久化抽象（Zed / VSCode 式 settings.json）

- 日期：2026-10-03
- 项目：Celestite（`web/`）
- 范围：新增 `web/src/lib/settings/`，迁移主题、侧边栏宽度、编辑器自动换行三个键
- 决策来源：与用户逐项确认（全局存 OPFS、项目级只读、逐 key 校验、本次不做设置面板）
- 证据约定：只记录本项目的行为契约与代码事实；不引用会随版本变动的 Zed / VSCode 文档

## 1. 结论

偏好从 `localStorage` 与组件本地 state 收敛到一个设置层：唯一的全局真相是 OPFS `/celestite/settings.json`，打开的 vault 根目录下 `.celestite/settings.json` 提供只读的项目级覆盖。优先级 `默认值 < 全局 < 项目`，逐键生效。

文件格式选择 **VSCode 式扁平点号键**（`{"theme.mode": "dark"}`）而不是 Zed 的嵌套分区：合并、保留未知键、逐 key 校验都直接落到单个键上，不需要展开嵌套路径。文件不写 `version` 字段；将来键改名由显式迁移代码处理。

## 2. 模块与职责

| 文件 | 职责 |
| --- | --- |
| `lib/settings/schema.ts` | 唯一权威：默认值、取值解析、范围、键说明；导出 `Settings` 类型与 `describeInvalidSetting` |
| `lib/settings/document.ts` | 纯函数：`parseDocument` / `parseSettingsText` / `resolveSettings` / `withSetting`；未知键保留，坏键回退并记录问题 |
| `lib/settings/app-file.ts` | OPFS `/celestite/settings.json` 读写；写走 Web Locks `celestite.settings.app`，`createWritable` + `abort` 保留旧内容；环境不支持时退回首字母内存文件 |
| `lib/settings/store.ts` | `SettingsStore`：`load` / `set` / `reloadProject` / `clearProject` / `snapshot` / `subscribe`；与 `FileTreeModel` 同样是无 IO 之外的纯状态类 |
| `lib/settings/project.ts` | 只读地通过 `VaultBackend` 读 `.celestite/settings.json` |
| `lib/settings/legacy.ts` | 旧 `localStorage` 键 → 设置键的一次性迁移 |
| `lib/settings/index.ts` | `initSettings()`、响应式 `settings()`、`setSetting`、项目级挂载/清理 |

`settings()` 由 Solid signal 驱动，JSX 中直接读取即响应式；注意 signal 写在微任务提交，因此主题应用等副作用订阅 store 的通知、使用通知携带的快照，而不是写完再同步读信号。

## 3. 写入语义（含高频拖动）

`set(key, value, { persist })`：

- 先校验，非法值直接抛错，不改内存也不落盘。
- `persist: false` 只更新内存态，供拖动宽度这类每帧调用；松手时以默认 `persist: true` 一次性写整份文档。
- 落盘成功才把新值写进内存；失败则内存仍采用用户选择，`storage` 置为 `memory`，`saveError` 记录键与原因，之后任意一次成功写入都会带上这次修改。这样界面不会"点了没反应"，也不会把两份真相留在磁盘与内存之间。

## 4. 失败与兼容

| 情形 | 行为 |
| --- | --- |
| 设置文件不存在 | 视为空文档；若存在旧 `localStorage` 键则迁移一次并在写成功后删除旧键 |
| 文件不是合法 JSON / 顶层不是对象 | 该层视为空，记录一条 `problems`，应用照常启动 |
| 某个键类型错误 | 该键回退到下一层（项目 → 全局 → 默认），其余键照常生效 |
| 数字超出 `range` | 夹取到范围内，不算错误 |
| 未知键 | 原样保留，回写时不丢 |
| 写入失败 | 保留内存态，`saveError` 可见，下次成功写入补齐 |
| 项目文件读失败 | 忽略项目层，其余不变 |
| 项目级提供的键 | 界面只读（自动换行按钮禁用并提示来源），与 VSCode 工作区覆盖一致 |

已知限制：OPFS `watch()` 不产生事件，项目级文件的外部修改需要重新打开 vault 才能读到；跨标签页不广播设置变化；多标签并发写同一份 JSON 由 Web Locks 串行化，最后一次写入生效。

## 5. 影响到的既有代码

- `lib/theme.ts`：改为薄封装，`theme()` 读设置层，`initializeTheme()` 应用一次并订阅后续变化。
- `VaultWorkspace.tsx`：删除本地宽度常量、clamp 与 `localStorage` 读写；宽度来自 `sidebar.width`；拖动期间用 `persist: false` 预览，松手/键盘/窗口变化时落盘；vault 打开后 `attachProjectSettings`，关闭时清理。
- `VaultEditor.tsx`：`wrap` 改为读 `editor.wordWrap`；项目级覆盖时按钮禁用并提示来源。
- `src/index.tsx`：先 `initSettings()` 再渲染，保证第一帧主题正确；`initSettings()` 内部不抛。

## 6. 验证结果（均实际执行）

```sh
bun run typecheck        # 通过
bun run test:vault       # 47 passed / 0 failed（新增 14 个设置用例）
bun run format:check     # 通过
bun run build            # 通过
bun run test:ui          # 45 个用例：44 passed / 1 failed
```

浏览器用例覆盖：主题写入全局文件并跨刷新保持、旧 `localStorage` 键迁移一次后删除、项目级覆盖 `editor.wordWrap` 与 `sidebar.width`、项目级覆盖主题、应用从不写项目文件、坏项目文件回退不阻塞启动。`tests/workspace.spec.ts` 中的持久化断言已从 `localStorage` 改为读 OPFS 设置文件，并使用 `expect.poll` 等待异步落盘。

唯一失败 `tests/file-tree.spec.ts "keyboard navigation …"` 是既有缺陷（右键菜单关闭后焦点落到 `<body>` 而不是文件树），与本次改动无关，已用改动前的代码复现确认；详见 `docs/_logs/2026-10-02 sidebar-single-click-resize.md` 第 6 节。

## 7. 未做与后续

- 设置面板 UI（搜索、分组、恢复默认、显示来源）；`snapshot().source` 已为其准备好。
- `.celestite/` 在文件树中的显隐、JSONC 注释与 Schema 提示。
- 多标签页设置同步、项目级文件的写回开关（当前只读是明确决策，要改需与用户确认）。
- 编辑器字号、缩进、字体等键已具备落点，但没有对应界面入口。
