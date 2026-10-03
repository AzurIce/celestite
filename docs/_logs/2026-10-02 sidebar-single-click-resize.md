# 侧边栏改为 Zed 式单击交互并支持拖动宽度

- 日期：2026-10-02
- 项目：Celestite（`web/`）
- 范围：文件树的点击语义与首页侧边栏宽度；不动文件后端、编辑器缓冲区与既有键盘导航
- 证据约定：只记录本次实现采用的交互契约与代码事实，不引用会随版本变动的外部文档；Zed 的具体版本行为未在本文固定

## 1. 需求与结论

用户要求把侧边栏从“双击打开”改成与 Zed 编辑器一致的单击交互，并让侧边栏宽度可拖动；交互直接对标 Zed 的侧边文件树。

结论：单击即打开文件、单击即展开/折叠文件夹；侧边栏右边界提供可拖动、可键盘操作的分隔条；其余交互（多选、范围选择、拖拽移动、右键菜单、键盘导航）保持不变。双击入口全部移除，不再作为受支持路径。

## 2. 采用的交互契约

| 操作 | 行为 |
| --- | --- |
| 单击文件（左键、无修饰键、按下到松手位移 ≤ 4px） | 选中并打开 |
| 单击文件夹（同样条件） | 选中并展开 / 折叠 |
| Ctrl / Cmd + 单击 | 只增减选择 |
| Shift + 单击 | 范围选择 |
| 位移 > 4px 的点击 | 视为拖拽收尾，不打开、不改变展开状态 |
| Enter / 方向键 / 前缀跳转 | 保持原有键盘行为 |

没有前置 `pointerdown` 的 `click`（合成点击）不参与位移判断，按普通单击处理。

位移阈值是必需的：HTML5 拖拽在部分情况下仍会补发 `click`，若不判断就可能把“移动到某文件夹”误当成“打开/折叠该文件夹”。阈值取 4px，与常见的点击抖动范围一致；拖动本身仍由原生 DnD 完成。

## 3. 宽度模型

侧边栏宽度与 Zed 左侧 dock 一样可以拖动，但保持简单、可回退：

- 常量：默认 300px（与改动前固定值一致）、最小 200px、最大 560px 与 60% 视口宽度中的较小值、键盘步进 16px。
- 布局：`VaultWorkspace` 用 CSS 变量 `--workspace-sidebar-width` 加 `sm:` 媒体查询描述三列栅格（侧边栏 / 5px 分隔条 / 编辑器），窄屏仍是单列，分隔条 `hidden sm:block`。
- 分隔条：`role="separator"` + `aria-orientation="vertical"` + `aria-valuenow` / `min` / `max` + `tabindex=0`；拖动用指针捕获，`pointercancel` 与 `pointerup` 都结束；拖动期间在容器上置 `data-resizing`，统一光标、禁止选中，并让两侧面板临时不响应指针，避免行 hover 高亮闪烁。
- 持久化：`localStorage` 键 `celestite.workspace.sidebarWidth`，只在拖动或键盘调整结束时写入，读入时校验并夹取；窗口变窄时重新夹取。存储不可用时只影响当前会话，与 `lib/theme.ts` 的取舍一致（该文件已有 tauri 下应改用编辑器设置的 TODO）。

## 4. 明确不做的事

避免把“对标 Zed”扩大成重做侧边栏，本次保持现状：

- 预览标签页语义（单击文件只占用一个可被替换的预览标签）。
- 侧边栏顶部筛选 / 模糊查找输入框，以及“自动定位当前文件”。
- 侧边栏整体收起（dock toggle）与 `hide_root` 单根隐藏。
- 目录行 hover 才显示折叠箭头等纯视觉细节。

这些都可以在确认交互契约稳定后再单独立项。

## 5. 影响到的代码与文档

- `src/components/file-tree/FileTree.tsx`：删除行 `onDblClick`，打开逻辑并入 `onClick`；新增每行的按下坐标记录；页脚提示改为包含“单击打开”。
- `src/VaultWorkspace.tsx` 与新增的 `src/workspace.css`：宽度状态、拖动、键盘、持久化与栅格。
- `src/components/editor/VaultEditor.tsx`：空状态文案由“双击”改为“单击”。
- `web/README.md`：更新文件树交互表、编辑与保存小节，新增“工作区布局”小节。
- 测试：`tests/editor.spec.ts`、`tests/file-tree.spec.ts` 的 `.dblclick()` 全部改为 `.click()`；新增单击打开/折叠、修饰键只选择、拖动后补发 click 不打开的用例；新增 `tests/workspace.spec.ts` 覆盖拖动、键盘、夹取、持久化与窄屏。

## 6. 验证范围与结果

本次执行了以下命令（均在仓库可用的环境下实际运行，非推测）：

```sh
bun run --cwd web format        # prettier 3.9.9，随后 format:check 通过
bun run --cwd web typecheck     # tsc --noEmit 两个配置均通过
bun run --cwd web test:vault    # 32 passed / 0 failed
bun run --cwd web build         # vite build 成功
bun run --cwd web test:ui       # 用系统 Chromium（PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH）运行全部 36 个用例
```

浏览器用例结果为 34 passed / 2 failed，两个失败都不是本次改动引入的，并已用改动前的代码复现确认：

| 失败用例 | 现象 | 确认方式 |
| --- | --- | --- |
| `tests/file-tree.spec.ts` "keyboard navigation … Shift+F10" | 关闭右键菜单后焦点落在 `<body>`，不在文件树上（实测 `document.activeElement` 为 `BODY`） | 把 `FileTree.tsx` 与该用例回退到改动前版本后仍同样失败 |
| `tests/editor.spec.ts` "write failure preserves edits …" | 注入写入失败后"重试保存"未完成，用例 30s 超时 | 用改动前的双击版 `FileTree` + `dblclick` 版用例复现同样失败 |

这两项都指向右键菜单 / 弹窗关闭后的焦点管理，属于本次范围之外的既有缺陷，建议单独处理（前者表现为关掉菜单后焦点丢失到 `body`，而不是回到文件树）。

未覆盖：真实 Zed 版本行为的逐项比对（本文只固定本项目的契约）；触屏下拖动宽度（窄屏不显示分隔条）。与 README 早前记录的 `EPERM: listen` 不同，本次沙箱可以启动 Playwright 的 dev server，因此浏览器用例真实执行过。
