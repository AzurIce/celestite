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

`dev`、`build` 和 `typecheck` 会先构建 Rust WASM 内核。需要 Rust 的 `wasm32-unknown-unknown` target（仓库 flake 已提供）。构建脚本使用 wasm-bindgen CLI 0.2.129；系统版本不一致时自动安装到 `web/.cache/wasm-tools`，首次安装需要网络。也可以通过 `WASM_BINDGEN` 指定匹配的 CLI，`CARGO_TARGET_DIR` 指定编译缓存。

WASM 构建启用 core 的 `preview` feature，Notist 与 notist-html 通过 Cargo git 依赖自动获取，使用工作区 `Cargo.toml` 固定的提交；不需要单独检出 Notist 仓库。构建使用 `--locked`，升级依赖时同步更新提交与 `Cargo.lock`。预览计算与任务契约见 [core README](../crates/celestite-core/README.md#预览计算与会话)。

首页自动打开默认 Web Vault，显示文件树及代码编辑器。深浅主题通过右下角状态栏的主题菜单切换。

UI 回归测试覆盖输入、弹窗焦点与关闭、菜单键盘操作、主题持久化和 SVG 图标：

```sh
bunx playwright install chromium
bun run test:ui
```

测试自动启动端口 1430 的开发服务。如果使用系统 Chromium，可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定可执行文件路径。

## GitHub Pages

仓库的 [.github/workflows/pages.yml](../.github/workflows/pages.yml) 在推送到 `main` 或手动运行时构建 Web，部署默认分支到 GitHub Pages。首次使用需在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。

CI 只检出 Celestite，Cargo 按固定提交获取 Notist。Bun 使用 1.4.2，Node 使用 24，Rust 使用与 flake 相同的 `nightly-2026-10-01` 及 WASM target；构建脚本自动安装匹配的 wasm-bindgen CLI。安装使用冻结的 Bun lockfile，Rust 构建核对 `Cargo.lock`，类型与格式检查通过后上传 `web/dist`，由独立部署 job 发布。

构建的 `base` 使用 Pages 返回的路径，兼容仓库子路径、用户主页与自定义域名。`/debug/sync/` 有独立静态入口，可以直接访问或刷新；返回编辑器链接使用同一站点路径。本地可用 `bun run build --base /celestite/` 验证子路径构建。

Pages 部署浏览器应用，默认 Vault 存于访问者浏览器的 OPFS。远端 Vault 仍需独立运行 celestite-server；从 Pages 连接时使用 HTTPS，并将 Pages 的来源（如 `https://azurice.github.io`，不含仓库路径）加入服务端 `allowed_origins`。

## UI 约定

- **视觉风格**：采用[霜瓷视觉规范](../docs/visual-design.md)，明亮白面、清蓝强调、蓝灰侧栏；深浅主题共享布局与尺寸。阅读正文为 16px、行高 1.9，控件 / 浮层圆角为 8px / 12px。工作区顶部直接显示文件树和编辑器，文件树工具栏和标签栏均为 48px；标签以浅底表示当前文件，工具栏和状态栏保持轻量。分隔线使用 `border`，输入框与常规按钮使用更清晰的 `control-border`；阴影仅用于浮层。
- **状态表达**：选中、键盘焦点、未保存、错误和拖拽落点各有独立样式；拖拽仍只突出实际目标的整棵子树。常用操作直接可见，详细快捷键说明保留为文件树的无障碍描述。
- **Kobalte** 提供交互行为；通用组件从 `@/components/ui` 导入，在该目录统一封装样式。业务组件放在其他目录。
- **UnoCSS** 使用 `presetWind3`，Vite 插件位于 Solid 插件之前。优先用 `bg-surface`、`text-foreground`、`text-secondary`、`border-border` 等语义颜色；类名需完整出现在源码中，避免动态拼接。
- **CSS 变量** 集中定义在 `src/styles/theme.css`，管理颜色、语法色、界面与阅读字号、正文间距、圆角、控件高度和浮层层级。`uno.config.ts` 的 theme 将变量映射为工具类，shortcuts 定义组件的基础样式；`src/styles/ui.css` 保留状态、子元素和浮层尺寸等选择器，通过 `--uno` 复用工具类。
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

`src/lib/vault` 提供平台无关的 `VaultBackend` 接口，以及 OPFS、本机目录与 HTTP 实现。接口绑定一个根目录，包含直接子项遍历、元数据查询、二进制读取、完整内容保存、目录创建、删除、重命名、外部监听和关闭。缓存、业务变化事件、编辑缓冲区及自动保存由后续的 Vault / 文档运行时负责。

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

`openOpfsVault("another-id")` 可打开隔离的另一个目录；当前界面提供 `default` 本地 Vault，并支持打开多个本机目录及连接多个远端 Vault。主页通过 `VaultManager` 管理各后端及其生命周期。OPFS 的 `watch()` 不发出任何事件，返回可重复调用的空取消订阅函数；后端关闭后订阅会报 `Closed`。应用操作引起的业务变化由上层发布。浏览器配额与持久存储申请属于平台服务，OPFS 数据也仍需要导出或备份。

移动的内存模拟测试验证路径保护、同路径、目标冲突、流式复制、写入/读取/提交故障、清理失败、部分删除、共享写锁和关闭等待：

```sh
bun run test:vault
```

浏览器测试覆盖刷新恢复、二进制与空目录、路径和根目录保护、创建/替换规则、跨标签页竞争、关闭时等待写入、移动和真实 OPFS 流的故障处理：

```sh
bun run test:ui tests/vault.spec.ts
```

## File System Access API 本机目录

支持 `showDirectoryPicker` 的安全上下文中，“管理 Vault”提供“打开本机目录”。主线程在用户点击时选择目录并申请读写权限，将 handle 通过 structured clone 传给独立编辑 Worker；文件树、编辑、撤销、项目设置和预览共用现有接口。

`directory-handle.ts` 共用 OPFS 与本机目录的文件操作；`file-system-access.ts` 管理选择、授权和后端构造。目录连接及 handle 存在 IndexedDB `celestite-local-directories`，登记时通过 `isSameEntry()` 去重，并用 Web Locks 协调跨标签页登记。不同位置的同名目录分别登记。刷新只恢复连接列表，点击打开时直接申请权限；权限失效保留正文，可从“管理 Vault”再次打开并授权。

连接列表在另行授权共同父目录后显示从该目录开始的路径，例如 `notist/docs`，刷新后重新解析目录关系。浏览器 API 不提供完整系统路径；仅选择 Vault 时只能取得其名称。

普通文件直接写回所选目录；实例身份和历史存于 OPFS `/editor-instances/directory-<uuid>`，不在本机目录里创建私有历史文件。每个目录实例独占打开，不允许另一标签页同时写入同一份私有历史。移除连接先保存正文、释放 Worker，再删除 IndexedDB handle 记录；普通文件和 OPFS 私有历史保留。重新登记已移除的目录会分配新的实例。

预览的“授权依赖目录”允许手动选择包含当前 Vault 与依赖的共同父目录，仅申请读取权限。通过 `scope.resolve(vaultHandle)` 验证包含关系，以 `/workspace` 作为授权范围的虚拟根，Vault 的编译资源根由其实际相对位置确定；`../packages` 等相对依赖据此解析。文件树、保存和历史继续使用原来的 Vault 根与身份，外部 package 由 `local/package-resources.ts` 独立只读加载，包括相对 JS 与 WASM。取消或选择无关目录保留原授权；授权 handle 与目录连接一同存于 IndexedDB，重新打开时请求恢复读取权限，资源授权失效不阻止 Vault 编辑。浏览器不会提供操作系统绝对路径，也不能从 Vault handle 自动取得父目录；配置中的绝对路径属于虚拟资源命名空间，不能直接对应本机绝对路径。

本机目录没有后台轮询或目录监听，外部修改只在保存时核对：Rust core 从磁盘基线合并外部变化，保留本地编辑与个人撤销，再以内容 revision 条件写入；合并或权限失败在界面可见，保留历史与编辑正文。组合输入期间拒绝保存，结束后下一次保存再合并外部修改。文件树通过“刷新文件树”与重新打开从磁盘重建；不依赖实验性 `FileSystemObserver`，不会捕获每个瞬间状态，也不预先把整库正文加入历史。

文件树刷新不触发预览重算，失败后也不定时重试。正文或已打开的项目配置、声明实际变化时正常更新；浏览器侧未打开的配置与外部 package 更新通过“刷新预览”读取，失败时点击“重试预览”。手动刷新重新取得声明及组件资源快照；组件实现变化仍需刷新页面加载。

本机程序不受 Web Locks 约束，浏览器无法提供与外部程序之间的原子 compare-and-swap。暂存写入提交前再次校验 revision；移动在复制后检查源树的大小与修改时间，发现变化保留源和完整目标。写入或复制失败可能留下新建条目或部分目标，本机后端不自动删除这些条目，以免删除外部程序刚写入的数据。元数据检查不能识别所有替换，也不能消除最终核对与提交／删除之间的竞争；本机目录多步骤操作不提供事务性保证。

`tests/file-system-access.spec.ts` 以注入 chooser 返回真实浏览器目录 handle 的方式验证 Worker / WASM、IndexedDB 恢复、跨标签页身份与占用、外部修改合并及权限失败恢复；操作系统原生选择器与真实权限弹窗仍需人工验证。

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

| 键                   | 类型 / 范围                            | 默认     |
| -------------------- | -------------------------------------- | -------- |
| `theme.mode`         | `system` / `light` / `dark`            | `system` |
| `sidebar.width`      | 200–560，越界夹取                      | 300      |
| `editor.wordWrap`    | 布尔                                   | `false`  |
| `editor.vimMode`     | 布尔                                   | `false`  |
| `editor.previewMode` | `source` / `split` / `preview`，仅全局 | `source` |

`src/lib/settings/schema.ts` 是唯一权威：默认值、取值解析与范围、键说明都在那里；新增设置只需加一项，界面读取 `settings().values[...]`，写入用 `setSetting(...)`。`settings()` 在 JSX 里是响应式的；`src/lib/settings/document.ts` 负责解析、合并与来源标记，`snapshot().source[key]` 说明某个键来自 default / app / project，设置面板据此提示当前 Vault 的覆盖值。

坏配置不会让应用不可用：文件不是合法 JSON、顶层不是对象、某个键类型错误，都只让对应键回退到下一层并记录到 `snapshot().problems`；未知键原样保留，回写时不丢。写入失败时保留用户选择的内存态，`snapshot().saveError` 记录原因，之后任意一次成功写入都会带上这些修改。

启动时序：`src/index.tsx` 先 `initSettings()` 再渲染应用，因此第一帧就是正确主题。首次启动会把旧的 `localStorage` 键（`celestite.theme`、`celestite.workspace.sidebarWidth`）迁移进设置文件并删除旧键；写失败时保留旧键，下次启动再迁移。OPFS `watch()` 不产生事件，项目级文件的外部修改要重新打开 vault 才会读到。项目级提供的值在界面上只读（例如自动换行按钮被禁用并提示来源），与 VSCode 的工作区覆盖一致。`tests/unit/settings.test.ts` 覆盖合并、校验、迁移与失败路径。

## 全局设置界面

从底部状态栏的“全局设置”按钮打开。面板展示全局文档中的主题、侧栏宽度、自动换行、Vim 模式和文档显示模式，未配置的选项展示 schema 默认值；当前 Vault 的覆盖值另行提示，仍可编辑全局默认值，写入只影响全局文件。文档显示模式由所有文件与 Vault 共用，工具栏和设置面板同步修改同一偏好，刷新后恢复；该键不接受项目级覆盖。不支持预览的文件显示源码，窄屏将分栏呈现为单独预览，两者均保留全局偏好。各文件的预览滚动位置独立保留。

主题和换行选择后自动保存；宽度在按 Enter 或离开输入框时校验并保存，范围取自 schema。每项可独立恢复默认值，保存保留其他设置和未知键。底部显示保存状态，失败保留本次会话的修改并提供重试；存储后端只能使用内存时明确说明不会持久保存。无效全局配置也在面板中提示，修正对应选项后清除其问题记录。面板支持深浅主题、键盘和窄屏滚动。

```sh
bun run test:ui tests/settings-ui.spec.ts
```

## 编辑与保存

首页单击文件或按 Enter 打开 CodeMirror 6 编辑器。支持行号、语法高亮、折叠、自动补全、缩进、撤销重做、多光标、搜索替换和可切换的自动换行。`.md`、`.markdown`、`.nmd`、`.notmd` 使用 Notist Markdown 语法，`.not` 使用原生正文语法，`.notc` 使用声明语法；高亮与折叠由独立 Tree-sitter Worker 执行，包含 Notist 调用中的递归 Markdown 内容。JavaScript / JSX、TypeScript / TSX、JSON、CSS、HTML 的 CodeMirror 语言包按需加载；其他 UTF-8 文本也可以编辑和保存。编辑器颜色跟随应用主题。

Tree-sitter runtime 与编译 CLI 固定为 `0.26.11`。语法 WASM、queries 与来源指纹快照位于 `src/lib/syntax/grammars/`，许可证位于 `public/tree-sitter-notist-LICENSE.txt`，一起随前端发布；正常开发、构建和 CI 不需要语法仓库。更新相邻的 `../tree-sitter-notist` 后，在根目录运行 `bun run --cwd web syntax:update`，再运行格式化与测试；也可传入相对于 `web/` 的语法仓库路径。此命令编译仓库中已生成的 C parser，不修改来源仓库；Tree-sitter CLI 首次构建会自动下载 WASI SDK，需要网络。

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

本地与远端都使用 Worker 内的 Rust `EditorCore` 管理正文、个人撤销和预览；`WorkerDocuments` 管理 UI 视图和待确认输入。本地的 OPFS 与本机目录均注入 `BrowserBackend`，远端注入 `MemoryBackend`，从 host 快照加入同一文档历史。远端输入实时发送 CRDT 增量；显式保存将因果版本交给 host core 条件写回，成功回执更新已保存正文。已删除文件不会被延迟保存重新创建。失败显示原因并保留修改，停止自动重试，可使用保存按钮或“重试保存”恢复。

`MemoryBackend` 是 core 的内存历史存储后端，通过 `MemoryEditorBinding` 接入远端 Worker；它保存文档快照与增量，不提供内存文件系统，也不写入 OPFS。远端文件和目录由 HTTP 适配器访问 host。关闭标签释放 UI buffer，Worker 历史继续保留和同步；刷新后从 host 重建会话，未确认输入没有本机持久化副本。后端实现见 [core README](../crates/celestite-core/README.md#backend-与服务接口)，加载范围与请求流程见 [Web 当前状态与请求交互](../docs/state/web.md)。

文件树接收该运行时的 `treeBackend`。移动、重命名、删除以及复制/下载读取会先保存相关缓冲区，相关文档在操作期间短暂禁止编辑；保存失败则拒绝后续文件操作。文件树原有的目录树与 OPFS 后端仍保持独立，OPFS watch 不产生事件。

文本内部使用 LF；保存保留打开时的 UTF-8 BOM 和首个换行符形式（LF / CRLF / CR），混合换行文件编辑后统一为首个形式。隐藏页面和关闭工作区时尝试保存全部缓冲区，存在未保存内容时注册浏览器离开提醒。页面终止事件不能保证异步写入完成，仍以界面的“已保存”为准。当前不合并其他窗口或外部程序对同一文件的并发修改，默认 OPFS 刷新可恢复已提交到私有历史、尚未写回普通文件的草稿；尚未提交的输入仍需保持页面打开。

`tests/unit/editor-documents.test.ts` 覆盖快速切换、保存期间输入、自动保存、写入失败、路径变更、复制/删除协调、编码与换行、关闭时保存等状态与故障情形；`tests/editor.spec.ts` 验证实际编辑器与 OPFS 的保存、重载及交互。

## 多 Vault 与远端连接

每个 server 进程只托管一个 Vault，客户端可连接多个独立 server；同一 Vault 的 readonly / edit 链接也分别建立实例。集中多库托管留待 SaaS 场景再设计。

`src/lib/vault/manager.ts` 的 `VaultManager` 持有连接记录和运行时对象。每个 `Vault` 包含 backend、编辑文档门面（`EditorDocuments`，由编辑 Worker 提供）、文件树模型、编辑器视图缓存和树滚动状态。首页固定打开 `opfs:default`（“我的 Vault”），默认 Vault 不提供移除入口，管理器也拒绝移除；内部文件仍正常管理。

底部“当前 Vault”切换器切换视图，“管理 Vault”打开连接面板。填写宿主启动日志中的 `http(s)://<server>/<key>` 分享链接，客户端在其后追加 `/api/v1/...`。readonly 使用 `ro-` 前缀且具有独立随机凭证；权限由宿主记录和 Vault 级只读策略共同决定。无需单独的 token 输入。URL 去除尾部斜杠，不接受嵌入用户名 / 密码、查询参数或片段；相同链接复用实例，不同分享保持独立授权、Worker 与个人编辑会话，即使它们指向同一个 Vault。连接身份使用独立 UUID，描述返回 `shareId` 与 `vaultIdentity`，不要求它们等于 URL 的 key。

连接记录位于 OPFS `/celestite/connections.json`，schema 为 2，保存本地连接 ID、完整分享 URL 和显示名称；它是凭证存储，不混入全局 / 项目设置或普通诊断导出。刷新后按需打开并重新验证授权，列表展示服务器和有效权限，通过“复制链接”获取完整地址。旧 schema 的按配置 ID 连接需要重新添加分享链接。

切换保留各自的文档、未保存正文、撤销历史、文件树展开/选择和剪贴板；同路径文件属于不同 Vault。本地后台文档仍可自动保存，协作 Vault 仅显式保存，离开页面时检查所有已打开 Vault。项目设置随当前 Vault 重新读取，过时的异步结果不能覆盖新 Vault 的设置。移除远端连接先保存该 Vault 的文档，再释放运行时、删除本地连接记录；失败保留连接和缓冲区，不调用远端删除操作。

远端协作使用每 VaultInstance 一条 WebSocket：握手核对历史与权限，host 分配会话和 writer，快照补齐后开放编辑。输入和个人撤销发送 CRDT 增量，host 提交历史后确认并广播；客户端 core 导入后增量更新 UI，保留个人撤销、光标与待确认输入，IME 期间延迟导入。文件树失效、保存回执和心跳复用同一条连接，目录查询与附件传输仍使用 HTTP。客户端关闭标签后仍接收其他文档的更新。

协作保存是独立操作，历史确认不代表物理文件已写回。host 的文件系统 bridge 将外部修改合入共享历史并推送；保存时若因果版本过期，客户端先补齐再尝试，不覆盖未见更新。共享历史不能通过客户端“丢弃编辑”整体清除。本地 OPFS 的条件保存冲突仍提供覆盖、丢弃和取消。

外部修改的后台协调状态与连接状态分开显示。计算期间显示同步提示，失败时显示“外部修改尚未同步”和“重试同步”；已提交正文保持可读且在线编辑可继续，保存和自动写回暂停。重试立即重新排队，协调完成后恢复正常状态，用户再显式保存。

单个远端文件上限 64 MiB，文本编辑上限仍为 5 MiB，远端提交的历史快照上限 16 MiB。断线、超时或权限失效时暂停编辑，整个 Vault 工作区（文件树与编辑区）显示断线遮罩及重连按钮。重连直接以 host 历史重建会话和个人撤销，不重放旧操作。未确认输入可导出当前正文，用户明确丢弃后重连；连接失败保留原正文。重连核对分享授权、Vault 与历史身份，身份变化时保留旧正文并拒绝复用。客户端副本只在会话内存中，不提供刷新恢复、离线同步或写请求自动重放。客户端存储不可用时，连接面板明确显示本次会话的存储状态；OPFS 默认 Vault 打不开仍可从底部连接远端。

服务端需报告 `websocketSync: true`；旧服务端显示升级错误。远端 UI 的撤销、预览、点击定位和滚动同步共用本地服务契约。

server 配置、启动和 API 见 [server README](../crates/celestite-server/README.md)。真实 server 端到端测试需要先构建二进制：

```sh
cargo build -p celestite-server
bun run --cwd web test:ui tests/multi-vault.spec.ts
```

## 本地编辑服务

默认库的 Rust 编辑内核在 Dedicated Worker 中运行。`WorkerDocuments` 保留 UI 视图与待确认输入，`EditorClient` 承载异步请求 / 通知，`EditorHost` 只适配消息、视图状态与定时任务；Rust `EditorCore<Backend>` 统一执行文档、保存、冲突与目录恢复逻辑，`BrowserBackend` 通过浏览器 IO 桥访问普通目录与 OPFS 私有历史。server 的 native 后端使用同一个 core。CodeMirror 输入发送 UTF-16 增量，撤销 / 重做使用 Rust 内核。

`src/lib/editor/` 按职责组织，共用的契约、RPC、文档状态和文本工具位于顶层：

| 目录         | 职责                                                  |
| ------------ | ----------------------------------------------------- |
| `client/`    | UI 文档视图、待确认输入与本地 / 远端 Worker 连接      |
| `runtime/`   | 本地与远端共用的 core host、Worker 命令队列与服务入口 |
| `local/`     | OPFS 私有历史、浏览器 IO 桥与本地编辑 Worker          |
| `remote/`    | 远端编辑 host、WebSocket 同步传输与远端编辑 Worker    |
| `preview/`   | 预览契约、任务调度、项目资源与组件运行时              |
| `generated/` | 构建生成的 WASM 绑定                                  |

普通文件位于 `vaults/default`，稳定身份和 CRDT 历史位于 `editor-instances/default`。每次接受编辑先提交私有增量日志，普通文件另行自动保存；文件写回失败后，已提交历史仍可在刷新时恢复。历史提交失败会暂停编辑，重试保存先提交历史。个人撤销栈只保留在本次 Worker 生命周期。

同一默认库目前只允许一个标签页持有内核；另一标签页会显示占用提示。每个远端连接独立持有一个客户端 core Worker，与本地共用请求队列和分析执行器契约；WebSocket 包装负责 host 历史补齐、确认与权限状态。Tauri IPC、Catalog CRDT 和日志压缩另行接入。

## 文档预览

本地或远端 Vault 打开 `.not`、`.md` 或 `.markdown` 后，可在文档工具栏选择“源码”“分栏”“预览”；只读正文也可预览，窄屏使用源码 / 预览切换。切换保留编辑会话、撤销记录和滚动位置，隐藏预览会取消分析订阅。

预览基于 core 已接受的未保存正文，在独立 Worker 中通过 Notist / notist-html 全量分析与渲染。后续编辑以 120 ms 防抖、500 ms 最长合并等待调度；慢任务期间继续编辑和保存，过期结果不会覆盖当前正文的预览。执行器失败或超时保留上一份结果，可点击“重试预览”恢复。

项目配置与 package 声明由 Notist 的 `Vault` 解析。每个 package 提供声明 `[package].name` 的 `Notist.toml` 与 `lib.notc`，依赖键须与包名一致；递归依赖、开发依赖及 package 默认 transforms 都由 Notist 装配。Vault 内资源从 backend 只读取得，Vault 外的 package 从宿主的独立只读接口取得。依赖路径相对于配置文件解析，支持相邻目录与绝对路径，文档根不变；外部 package 不进入文件树、编辑历史或保存流程。已打开的配置、声明与组件源码优先使用 core 中的未保存内容；读取预览资源不会触发文件保存。配置与声明编辑、文件操作以及远端文件变化都会使项目预览更新，外部 package 的清单、声明与组件目录同样接收变化通知。Vault 内的跨文件诊断可打开对应文件，并在源码仍匹配时定位；外部 package 诊断显示带高亮范围的只读源码快照。

package 组件使用与 Cargo 固定提交一致的 Notist 浏览器运行时。组件目录快照通过同源虚拟 URL 提供，相对 JS 导入和 `new URL(..., import.meta.url)` 加载的 WASM 保持目录关系；Service Worker 脚本随 Web 构建输出，支持 GitHub Pages 子路径。package 预览需要浏览器支持 Service Worker 且运行在 HTTPS 或 localhost。正文和声明更新可直接预览，组件 JS / WASM 实现变化需刷新页面加载。

HTML 在 ShadowRoot 中继承应用主题。展开底部诊断可跳转源码；更新中的诊断暂不可定位。文档链接相对于当前文件目录解析，支持 Vault 内文件和片段，越出 Vault 或不存在的目标显示错误；外部链接在新窗口打开。

分栏默认开启双向滚动同步，可通过工具栏的“滚动同步”关闭。同步按对应内容块对齐，只移动视口，保留选区和焦点；调整宽度、切换自动换行或折叠源码后重新测量。两侧不同的排版高度会使同一视口内其他内容出现位置差异。

点击源码可使预览短暂高亮对应内容；点击预览正文可选中对应源码，保持分栏模式。目标已可见时不滚动，屏外目标只移动到可见位置；长源码范围显示起点，不滚到选区末尾。点击后继续滚动会从当前两侧视口接续，再逐渐回到内容对齐。单独预览时点击正文会切回源码。链接仍用于导航，拖选文字不触发定位；旧版本或有待确认输入时暂停对应定位。当前精度是节点范围，尚不提供逐字符精确映射。

图片及附件资源、公式排版、代码高亮、增量分析和 DOM 局部更新后续接入。

## 同步调试页

运行 `bun run dev`，打开 `http://localhost:1420/debug/sync`。server 可由仓库根目录的 `just serve-notist "$share_key"` 启动。`share_key` 是需保存并复用的至少 32 字节随机秘密值，可用 `openssl rand -hex 32` 生成。在页面连接宿主启动日志中的完整 URL，选择文本并点击“打开并重建实例”。使用其他 Vault 时填写该 Vault 的启动链接。

默认创建 A / B 两个独立 Worker 与 WASM `EditorCore<MemoryBackend>`，可增加至 6 个。分别修改正文，再点击“同步全部”；也可逐个推送、拉取、暂停传输，以及切换每秒同步。个人撤销由各自 core 产生 CRDT 更新。“保存到文件”只写 host 当前正文，未推送的客户端修改不会被保存。

界面显示 host、实例 / writer 身份、正文版本、历史提交与文件写回版本，以及最近 100 条传输日志。实例只保留在页面内存中，结束会话或重建实例会释放它们。暂停传输允许继续编辑以构造并发测试；这是调试控制，不代表生产客户端离线编辑策略已经实现。

server 的 `--state-dir` 启用 host 历史持久化；未配置时，界面显示 host 历史仅驻留内存。server 配置 `--web-dir web/dist` 后，也可直接打开其 `/debug/sync`。调试页复用已有认证和文档 API，不新增服务端成员注册或调试权限旁路。
