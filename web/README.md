# Celestite 前端

使用 Solid 2 RC + TypeScript + Vite，桌面容器为 Tauri。

Solid 与 `@solidjs/web` 固定为 `2.0.0-rc.13`，构建插件为 `@solidjs/vite-plugin@3.0.0-next.47`，Kobalte 为 `2.0.0-alpha.2`。这些预发布包需要一起升级并验证交互。保留 Vite SPA 架构。

## 开发

在仓库根目录运行 `nix develop`，然后：

```sh
cd web
bun install --frozen-lockfile
bun run dev
bun run typecheck
bun run build
```

首页自动打开默认 Web Vault，显示文件树及代码编辑器。深浅主题通过右下角状态栏的主题菜单切换。

UI 回归测试覆盖输入、弹窗焦点与关闭、菜单键盘操作、主题持久化和 SVG 图标：

```sh
bunx playwright install chromium
bun run test:ui
```

测试自动启动端口 1430 的开发服务。如果使用系统 Chromium，可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定可执行文件路径。

## UI 约定

- **视觉风格**：中性色与少量灰绿色强调，浅色侧栏 / 素色编辑区，不给每一块内容加卡片。工作区顶部直接显示文件树和编辑器，文件树工具栏和标签栏均为 48px；标签以浅底表示当前文件，工具栏和状态栏保持轻量。边框用于面板分隔、输入框与浮层，阴影仅用于浮层。深浅主题共享布局与尺寸。
- **状态表达**：选中、键盘焦点、未保存、错误和拖拽落点各有独立样式；拖拽仍只突出实际目标的整棵子树。常用操作直接可见，详细快捷键说明保留为文件树的无障碍描述。
- **Kobalte** 提供交互行为；通用组件从 `@/components/ui` 导入，在该目录统一封装样式。业务组件放在其他目录。
- **UnoCSS** 使用 `presetWind3`，Vite 插件位于 Solid 插件之前。优先用 `bg-surface`、`text-foreground`、`text-secondary`、`border-border` 等语义颜色；类名需完整出现在源码中，避免动态拼接。
- **CSS 变量** 集中定义在 `src/styles/theme.css`，管理颜色、字号、圆角、控件高度和浮层层级。`uno.config.ts` 的 theme 将变量映射为工具类，shortcuts 定义组件的基础样式；`src/styles/ui.css` 保留状态、子元素和浮层尺寸等选择器，通过 `--uno` 复用工具类。
- **Lucide** 图标从 `@/components/icons` 按名称导入。适配层使用 `lucide` 的框架无关数据渲染 SVG，保留按需打包，避免旧 `lucide-solid` 的 Solid 1 依赖。常用尺寸为 16px，默认线宽为 1.75；纯图标按钮必须提供 `aria-label`，装饰性图标设置 `aria-hidden="true"`。新增图标时在适配层用 `createIcon` 导出。
- **路径别名** `@/` 对应 `src/`，已同时配置 Vite 与 TypeScript。

当前组件包括 Button、IconButton、Tooltip、Dialog、DropdownMenu、ContextMenu 和 TextField。Button 支持 `primary`、`secondary`、`ghost`、`danger` 四种 variant，以及 `sm`、`md` 两种 size。

```tsx
import { Plus } from "@/components/icons";
import {
  Button,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui";

<Dialog>
  <DialogTrigger as={Button} variant="primary">
    <Plus size={16} aria-hidden="true" /> 新建笔记
  </DialogTrigger>
  <DialogContent>
    <DialogTitle>新建笔记</DialogTitle>
    <DialogDescription>选择笔记的名称和位置。</DialogDescription>
  </DialogContent>
</Dialog>;
```

Trigger 和关闭按钮通过 `as={Button}` 或 `as={IconButton}` 组合，避免嵌套按钮。DialogContent、TooltipContent 和两种 MenuContent 已包含 Portal，无需另加。弹窗应提供 DialogTitle，并按需要提供 DialogDescription。

Solid 2 的 DOM 属性使用 `tabindex` 等 HTML 名称；`cx` 接受字符串、条件对象和嵌套数组，返回渲染器支持的 class 数组。组件封装使用 `omit` 保留其余 props 的响应性，异步组件在 `Loading` 边界内加载。

Kobalte alpha 的浮层注册和输入读取时机通过 Bun 补丁适配了 Solid 2 的延迟写入，补丁由 `bun install` 自动应用，详见 [patches/README.md](patches/README.md)。上游仍锁定较早 RC 的 peer 版本，因此安装时会出现 peer 警告；Kobalte / Solid Primitives 在开发模式下也仍会报告未跟踪读取和 effect 派生状态警告。当前组件交互已纳入回归测试，后续升级时需重新验证，不能只放宽版本约束。

## 主题

`src/lib/theme.ts` 提供响应式 `theme()` 和 `setTheme("system" | "light" | "dark")`。默认跟随系统，选择保存在本地；系统模式会监听系统配色变化。

设置快照通过 Solid signal 驱动界面；主题同时订阅设置层更新，将通知携带的生效模式直接应用到 DOM（包括项目覆盖与保存失败后的内存态）。Solid 2 的 signal 写入默认在下一次微任务提交，因此不要在 setter 后立即读取 `theme()` 来更新页面。主题选择先在内存中生效，再保存设置文件；初始化主题的清理函数同时解除设置订阅与系统配色监听。

入口在渲染前初始化主题，将解析后的 `data-theme="light"` 或 `data-theme="dark"` 放在 `<html>` 上，使 Portal 中的弹窗和菜单也继承主题。优先使用语义颜色，确需主题特有样式时可用 UnoCSS 的 `dark:` 变体。

主题值保留在 CSS 变量中，修改变量即可让现有组件和工具类同步更新。UnoCSS 映射包括：

| 用途             | 工具类示例                                                          |
| ---------------- | ------------------------------------------------------------------- |
| 颜色             | `bg-surface`、`text-secondary`、`border-border`、`bg-accent-hover`  |
| 字体、字号和行高 | `font-ui`、`text-ui`、`text-ui-sm`、`text-ui-heading`、`leading-ui` |
| 控件尺寸         | `h-control-md`、`w-control-sm`、`min-h-control-sm`                  |
| 圆角             | `rounded-control`、`rounded-panel`（`rounded-ui` 为兼容别名）       |
| 浮层阴影         | `shadow-floating`                                                   |
| 浮层层级         | `z-overlay`、`z-dialog`、`z-menu`、`z-tooltip`                      |

例如，自定义面板可以写为：

```tsx
<section class="rounded-panel border border-solid border-border bg-surface p-4 font-ui text-ui shadow-floating">
  <h2 class="text-ui-heading font-semibold">笔记信息</h2>
  <p class="text-ui-sm text-secondary">描述</p>
</section>
```

组件继续使用 `ui-button`、`ui-menu` 等名称，这些名称由 shortcuts 展开并按需生成。新增通用样式时优先复用主题工具类；组合重复时再添加 shortcut。CSS 中使用 `--uno: "工具类列表";` 复用工具类，由已配置的 `transformerDirectives` 在开发和构建时展开。这是标准 CSS 自定义属性语法，编辑器可以正常校验。入口按全局主题、UnoCSS、组件状态样式的顺序加载，确保状态选择器和减少动态效果的设置覆盖基础样式。

## Vault 文件后端

`src/lib/vault` 提供平台无关的 `VaultBackend` 接口和 Web 的 OPFS 实现。接口绑定一个根目录，包含直接子项遍历、元数据查询、二进制读取、完整内容保存、目录创建、删除、重命名、外部监听和关闭。缓存、业务变化事件、编辑缓冲区及自动保存由后续的 Vault / 文档运行时负责。

```ts
import { openOpfsVault, ROOT_PATH, vaultPath } from "@/lib/vault";

const backend = await openOpfsVault(); // 恢复或首次创建 OPFS /vaults/default
try {
  await backend.mkdir(vaultPath("notes"), { recursive: true });
  const path = vaultPath("notes/hello.md");
  const existing = await backend.stat(path);
  await backend.writeFile(path, new TextEncoder().encode("# Hello\n"), {
    mode: existing ? "replace" : "create",
  });
  for await (const entry of backend.readDir(ROOT_PATH)) {
    console.log(entry.path, entry.kind);
  }
} finally {
  await backend.close();
}
```

路径使用 `/` 分隔的相对路径，空字符串 `ROOT_PATH` 表示根。通过 `vaultPath()` 校验，不接受绝对路径、`.`、`..`、重复或末尾分隔符、反斜杠和 NUL；后端仍在操作时复核路径。`stat()` 仅在不存在时返回 `null`，其他错误通过 `VaultError.code` 区分。

`writeFile()` 的 `create` 不覆盖已有条目，`replace` 要求文件存在，二者都不隐式创建父目录。输入字节在调用时复制；已有文件通过 `createWritable()` 暂存，关闭流后提交，失败时中止流以保留旧内容。创建期间可能暂时出现空条目，创建失败会尝试删除；清理也失败时返回包含两次错误的 `IO`。多步骤操作没有事务或崩溃恢复保证。

`rename(from, to)` 在同一 Vault 内移动文件或整棵目录树，目标路径必须不存在、父目录必须存在。同路径在源存在时不执行修改；不能移动根目录，也不能把目录移入自己的后代。OPFS 使用流式复制再删除源，包含空文件和空目录；复制完整前不删除任何源条目。整次移动持有同一把 Vault 写锁，复制顺序执行，不将附件完整读入内存，也不依赖实验性移动 API。

移动开始后的失败抛出 `VaultRenameError`，保留原错误码，并提供 `from`、`to`、`phase`、`targetComplete` 和可选的 `cleanupError`。`phase === "copy"` 时源尚未删除，后端会尝试清理本次创建的目标；清理失败会报告残留。`phase === "remove-source"` 时目标已经复制完整，源可能部分删除，因此保留目标供上层处理。预检失败仍是普通 `VaultError`。移动不是事务，读操作可能看到复制中的目录；尚无持久化 journal 或重启自动恢复，复制期间也需要源与目标同时占用存储空间。

OPFS 后端要求安全上下文，以及 `getDirectory()`、`createWritable()` 和 Web Locks 支持。所有修改通过按 Vault ID 命名的同源锁协调，覆盖应用自己的不同会话和标签页；直接绕过后端操作 OPFS 的代码不受此约定保护。`close()` 拒绝新操作并等待已接收操作完成，不删除数据；暂停的目录迭代器不会阻塞关闭，关闭后继续迭代会报 `Closed`。

`openOpfsVault("another-id")` 可打开隔离的另一个目录；当前界面固定提供 `default` 本地 Vault，并支持连接多个远端 Vault。主页通过 `VaultManager` 管理各后端及其生命周期。OPFS 的 `watch()` 不发出任何事件，返回可重复调用的空取消订阅函数；后端关闭后订阅会报 `Closed`。应用操作引起的业务变化由上层发布。浏览器配额与持久存储申请属于平台服务，OPFS 数据也仍需要导出或备份。

移动的内存模拟测试验证路径保护、同路径、目标冲突、流式复制、写入/读取/提交故障、清理失败、部分删除、共享写锁和关闭等待：

```sh
bun run test:vault
```

浏览器测试覆盖刷新恢复、二进制与空目录、路径和根目录保护、创建/替换规则、跨标签页竞争、关闭时等待写入、移动和真实 OPFS 流的故障处理：

```sh
bun run test:ui tests/vault.spec.ts
```

## 文件树

`components/file-tree` 导出可复用的 `FileTree`，接收已经打开的后端。控件不关闭传入后端，父组件负责其生命周期：

```tsx
import { FileTree } from "@/components/file-tree";

<FileTree
  backend={backend}
  label="我的 Vault"
  onOpen={(path) => openDocument(path)}
  onChange={(change) => updateDocuments(change)}
/>;
```

`lib/file-tree/model.ts` 管理目录缓存、展开、焦点、范围锚点、选择、控件内剪贴板及操作状态。目录按需读取，目录优先、名称自然排序；缓存只包含条目，不加载全部正文。同一个控件的修改串行执行；刷新保留仍然存在的展开状态，并剔除不可见或已删除的选择。模型还接收外部变化提示，IO 期间的提示会合并为随后一次刷新；OPFS 的空监听不影响应用自己的更新。

支持文件与文件夹的新建、重命名、确认删除、剪切、复制、粘贴、移动到路径、拖拽批量移动、悬停展开、拖拽滚动、折叠全部、刷新、文件导入和下载。单击打开文件或展开/折叠文件夹；右键已选项保留多选，右键未选项改为选择该项。触屏长按也可打开菜单。“移动到”提供不依赖拖拽的替代操作。

| 交互                      | 行为                                     |
| ------------------------- | ---------------------------------------- |
| 单击（无修饰键、未拖动）  | 打开文件，或展开 / 折叠文件夹            |
| Ctrl / Cmd + 点击         | 增减选择，不打开、不折叠                 |
| Shift + 点击              | 从锚点到当前项连续选择，不打开、不折叠   |
| Ctrl / Cmd + Shift + 点击 | 在现有选择上增加连续范围                 |
| 按住拖动超过 4px 后松手   | 视为拖拽移动，不打开文件、不改变展开状态 |
| 上下方向键、Home、End     | 按可见顺序移动并选择                     |
| Ctrl / Cmd + 方向键       | 只移动焦点，不改变选择                   |
| Shift + 方向键、Home、End | 扩展连续选择                             |
| 左右方向键                | 展开、折叠或移动到父项/第一个子项        |
| Space / Ctrl + Space      | 切换当前项选择；Shift + Space 连选       |
| Ctrl / Cmd + A            | 选择全部可见项                           |
| Ctrl / Cmd + X / C / V    | 控件内剪切 / 复制 / 粘贴                 |
| F2 / Delete               | 重命名 / 确认删除                        |
| Shift + F10               | 当前焦点项的右键菜单                     |
| F5 / Escape               | 刷新 / 清空选择并取消剪贴板              |
| 输入名称前缀              | 跳到匹配项                               |

键盘焦点和选择分别显示，树提供 `tree` / `treeitem` / `group` 语义与层级、顺序、选择、展开状态；交互参考 [W3C Tree View 模式](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/)。

拖到文件夹时移入该文件夹，拖到文件时移入其父目录，拖到 Vault 标题或空白处时移到根。拖拽只接受当前控件的内部载荷；不把其他 Vault 的路径当成本 Vault 文件。源父目录和子项同时选中时，只处理父目录一次。目标冲突、重名批次、自身后代等在开始批量修改前检查，已有内容不被覆盖；后端仍负责每一步的最终竞争检查。批量操作不是事务：中途失败会停止余下操作、重新读取目录并报告已完成数量，保留 `rename` 的复制/源删除阶段提示。

拖拽期间，仅用统一的浅色背景和细边框标出目标目录及其展开子树，区域起点跟随目录缩进。悬停文件时标出其父目录子树，移到根目录时标出整个根目录区域；无效位置不显示落点。离开控件、取消或完成拖拽后清除样式。

复制到同一父目录生成不冲突的“副本”名称；复制到其他目录时遇到已有目标会拒绝。目录复制失败时保留源和可能存在的部分目标，避免通过自动回滚误删另一会话写入的内容。复制、导入及下载使用现有完整文件读写接口，逐文件处理，单个大文件仍可能需要较多临时内存；移动仍使用 OPFS 后端的流式实现。剪贴板仅限此控件当前会话，不与系统文件剪贴板同步。

系统文件可通过多文件选择或拖入导入，二进制内容保持原样；系统目录拖入目前会明确拒绝，不把目录误当成空文件。默认页面使用代码编辑器打开 UTF-8 文本；二进制文件、非 UTF-8 文件及超过 5 MiB 的文件提示下载。移动端打开编辑器后可返回文件树。控件不会自动创建示例文件。

```sh
bun run test:vault                      # 后端与树模型的故障/状态测试
bun run test:ui tests/file-tree.spec.ts  # 真实 OPFS 与浏览器交互测试
```

## 工作区布局

首页为“侧边栏 + 编辑器”两栏，顶部没有应用标题栏，底部为横跨两栏的 32px 状态栏。文件树的操作与选择状态显示在左侧，编辑器的保存状态、编码、语言及光标位置显示在右侧；主题切换入口也放在底部。面板通过 `StatusSlot` 将自己的响应式状态内容挂载到工作区提供的位置，独立使用面板时仍可显示本地状态。`VaultWorkspace` 用 CSS 变量 `--workspace-sidebar-width` 描述侧边栏宽度，宽屏（`sm` 以上）栅格为 `侧边栏 / 5px 分隔条 / 编辑器`，窄屏退化为单列，编辑器覆盖在文件树之上并为底部状态栏留出空间，分隔条隐藏。

| 操作               | 行为                                            |
| ------------------ | ----------------------------------------------- |
| 拖动侧边栏右边界   | 改变侧边栏宽度，拖动期间光标统一为 `col-resize` |
| 聚焦分隔条后 ← / → | 每次 16px                                       |
| Home / End         | 夹到最小 / 最大宽度                             |
| 调整结束           | 写入设置文件里的 `sidebar.width`                |
| 窗口变窄           | 重新夹取宽度，编辑器始终保留空间                |

默认 300px，最小 200px，最大 560px 与 60% 视口宽度中的较小值；分隔条为 `role="separator"` 并带 `aria-orientation`、`aria-valuenow` / `min` / `max`，键盘可用。侧边栏本身暂不支持整体收起，也不引入 Zed 的预览标签页。

```sh
bun run test:ui tests/workspace.spec.ts  # 侧边栏宽度、拖动、键盘与持久化
bun run test:ui tests/settings.spec.ts   # 设置文件、项目级覆盖与迁移
```

## 设置

偏好集中在 `src/lib/settings/`，对标 Zed / VSCode 的"一个 JSON 承担设置"的做法。文件使用**扁平点号键**（VSCode 风格，便于逐键合并与保留未知键）：

- 全局：OPFS `/celestite/settings.json`，与 `/vaults/<id>` 平级，不随 vault 走。
- 项目：打开的 vault 根目录下 `.celestite/settings.json`，**只读**——应用只在打开 vault 时读取，界面上的修改一律写回全局文件。用户手改该文件即可按项目覆盖设置。
- 优先级：默认值（schema） < 全局文件 < 项目文件，逐键生效。

当前键与默认值：

| 键                | 类型 / 范围                 | 默认     |
| ----------------- | --------------------------- | -------- |
| `theme.mode`      | `system` / `light` / `dark` | `system` |
| `sidebar.width`   | 200–560，越界夹取           | 300      |
| `editor.wordWrap` | 布尔                        | `false`  |

`src/lib/settings/schema.ts` 是唯一权威：默认值、取值解析与范围、键说明都在那里；新增设置只需加一项，界面读取 `settings().values[...]`，写入用 `setSetting(...)`。`settings()` 在 JSX 里是响应式的；`src/lib/settings/document.ts` 负责解析、合并与来源标记，`snapshot().source[key]` 说明某个键来自 default / app / project，设置面板据此提示当前 Vault 的覆盖值。

坏配置不会让应用不可用：文件不是合法 JSON、顶层不是对象、某个键类型错误，都只让对应键回退到下一层并记录到 `snapshot().problems`；未知键原样保留，回写时不丢。写入失败时保留用户选择的内存态，`snapshot().saveError` 记录原因，之后任意一次成功写入都会带上这些修改。

启动时序：`src/index.tsx` 先 `initSettings()` 再渲染应用，因此第一帧就是正确主题。首次启动会把旧的 `localStorage` 键（`celestite.theme`、`celestite.workspace.sidebarWidth`）迁移进设置文件并删除旧键；写失败时保留旧键，下次启动再迁移。OPFS `watch()` 不产生事件，项目级文件的外部修改要重新打开 vault 才会读到。项目级提供的值在界面上只读（例如自动换行按钮被禁用并提示来源），与 VSCode 的工作区覆盖一致。`tests/unit/settings.test.ts` 覆盖合并、校验、迁移与失败路径。

## 全局设置界面

从底部状态栏的“全局设置”按钮打开。面板展示全局文档中的主题、侧栏宽度和自动换行，未配置的选项展示 schema 默认值；当前 Vault 的覆盖值另行提示，仍可编辑全局默认值，写入只影响全局文件。

主题和换行选择后自动保存；宽度在按 Enter 或离开输入框时校验并保存，范围取自 schema。每项可独立恢复默认值，保存保留其他设置和未知键。底部显示保存状态，失败保留本次会话的修改并提供重试；存储后端只能使用内存时明确说明不会持久保存。无效全局配置也在面板中提示，修正对应选项后清除其问题记录。面板支持深浅主题、键盘和窄屏滚动。

```sh
bun run test:ui tests/settings-ui.spec.ts
```

## 编辑与保存

首页单击文件或按 Enter 打开 CodeMirror 6 编辑器。支持行号、语法高亮、折叠、自动补全、缩进、撤销重做、多光标、搜索替换和可切换的自动换行。Markdown、JavaScript / JSX、TypeScript / TSX、JSON、CSS、HTML 的语言包按需加载；其他 UTF-8 文本也可以编辑和保存。编辑器颜色跟随应用主题。

打开的文件显示为标签。切换文件保留内容、撤销历史、光标和滚动位置；移动或重命名文件和父目录时，标签同步路径并保留同一个编辑缓冲区。移动端返回文件树不会关闭文档，再次打开同一文件可继续编辑。

读取文件期间，编辑器区域居中显示旋转图标与"正在打开 <路径>…"，不再在标签栏上方插入提示条；打开失败的提示仍以 alert 形式出现在同一位置。编辑器代码块懒加载时的"正在加载编辑器…"是另一条路径，只在首次加载组件时分包时出现。

| 操作                       | 行为                                                        |
| -------------------------- | ----------------------------------------------------------- |
| 保存按钮 / Ctrl 或 Cmd + S | 将当前文档写回 Vault                                        |
| 停止输入 800 ms            | 自动保存；持续输入时最长等待 5 秒                           |
| Ctrl 或 Cmd + Z            | 撤销；恢复到上次保存的内容后清除未保存标记                  |
| Ctrl 或 Cmd + F            | 搜索与替换                                                  |
| Tab / Shift + Tab          | 缩进 / 减少缩进；CodeMirror 支持 Escape 后用 Tab 移出编辑器 |
| 标签上的关闭按钮           | 先保存文档再关闭；保存失败时保留标签与缓冲区                |

`lib/editor/documents.ts` 的 `VaultDocuments` 管理已打开文档与保存队列。编辑器只更新内存缓冲区，保存使用后端的 `writeFile(..., { mode: "replace" })`，不把已删除文件自动重新创建。只有后端成功提交的内容才会标记为已保存；保存期间继续输入，会在同一队列里保存更新后的版本。失败显示原因并保留修改，停止自动重试，可使用保存按钮或“重试保存”恢复。

文件树接收该运行时的 `treeBackend`。移动、重命名、删除以及复制/下载读取会先保存相关缓冲区，相关文档在操作期间短暂禁止编辑；保存失败则拒绝后续文件操作。文件树原有的目录树与 OPFS 后端仍保持独立，OPFS watch 不产生事件。

文本内部使用 LF；保存保留打开时的 UTF-8 BOM 和首个换行符形式（LF / CRLF / CR），混合换行文件编辑后统一为首个形式。隐藏页面和关闭工作区时尝试保存全部缓冲区，存在未保存内容时注册浏览器离开提醒。页面终止事件不能保证异步写入完成，仍以界面的“已保存”为准。当前不合并其他窗口或外部程序对同一文件的并发修改，刷新页面也不会恢复尚未落盘的缓冲区。

`tests/unit/editor-documents.test.ts` 覆盖快速切换、保存期间输入、自动保存、写入失败、路径变更、复制/删除协调、编码与换行、关闭时保存等状态与故障情形；`tests/editor.spec.ts` 验证实际编辑器与 OPFS 的保存、重载及交互。

## 多 Vault 与远端连接

`src/lib/vault/manager.ts` 的 `VaultManager` 持有连接记录和运行时对象。每个 `Vault` 包含 backend、`VaultDocuments`、文件树模型、编辑器视图缓存和树滚动状态。首页固定打开 `opfs:default`（“我的 Vault”），默认 Vault 不提供移除入口，管理器也拒绝移除；内部文件仍正常管理。

底部“当前 Vault”切换器切换视图，“管理 Vault”打开连接面板。填写 `http(s)://<server>/api/v1/vaults/<id>` 与可选访问令牌，校验描述协议后建立 HTTP backend。URL 去除尾部斜杠并作为连接身份，不接受嵌入凭据、查询参数或片段；重复连接复用原运行时。令牌只在当前会话保留，刷新后可通过同一 URL 重新认证。连接记录位于 OPFS `/celestite/connections.json`，不混入全局 `settings.json`，不自动打开或认证所有已保存的远端连接。

切换保留各自的文档、未保存正文、撤销历史、文件树展开/选择和剪贴板；同路径文件属于不同 Vault。后台文档仍可自动保存，离开页面时检查所有已打开 Vault。项目设置随当前 Vault 重新读取，过时的异步结果不能覆盖新 Vault 的设置。移除远端连接先保存该 Vault 的文档，再释放运行时、删除本地连接记录；失败保留连接和缓冲区，不调用远端删除操作。

HTTP backend 使用字节正文和 SSE 变化提示。版本读取 `readFileSnapshot` 把正文与版本一起交给文档，文档保存显式携带 `expectedRevision`，成功后更新为提交版本；其他下载或复制读取不会推进编辑器的保存基线。OPFS 没有版本写入能力，显式传入预期版本时返回 Unsupported；原有 OPFS 编辑保存不变。已打开正文不随监听自动重载；文件树刷新或重连会重新核对目录。

手动保存或关闭标签遇到远端版本冲突时，弹窗提供“覆盖保存”“丢弃编辑”“取消”，默认焦点为取消。覆盖保存重新读取最新版本后提交本地内容，仍带版本检查；期间再次修改会保留编辑和弹窗。保存时丢弃编辑会读取最新正文与编码、重建编辑器并清除旧撤销历史；读取失败或无法编辑的新正文不会清除本地修改。关闭时丢弃编辑直接关闭标签，不修改磁盘。取消保留编辑与标签。自动保存发现冲突只显示提示并停止重试，用户点击“处理冲突”后再弹窗；页面终止时仍使用浏览器离开提醒，不承诺异步操作完成。目前不提供自动合并或差异比较。

单个远端文件上限 64 MiB，文本编辑上限仍为 5 MiB。断线/超时不自动重放写请求，也没有离线缓存同步。客户端存储不可用时，连接面板明确显示本次会话的存储状态；OPFS 默认 Vault 打不开仍可从底部连接远端。

server 配置、启动和 API 见 [server README](../crates/celestite-server/README.md)。真实 server 端到端测试需要先构建二进制：

```sh
cargo build -p celestite-server
bun run --cwd web test:ui tests/multi-vault.spec.ts
```
