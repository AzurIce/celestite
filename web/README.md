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

开发时访问 `http://localhost:1420/ui` 查看基础组件及深浅主题。首页留空，供后续应用 UI 使用；组件预览仅在开发模式启用。

UI 回归测试覆盖输入、弹窗焦点与关闭、菜单键盘操作、主题持久化和 SVG 图标：

```sh
bunx playwright install chromium
bun run test:ui
```

测试自动启动端口 1430 的开发服务。如果使用系统 Chromium，可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定可执行文件路径。

## UI 约定

- **Kobalte** 提供交互行为；通用组件从 `@/components/ui` 导入，在该目录统一封装样式。业务组件放在其他目录。
- **UnoCSS** 使用 `presetWind3`，Vite 插件位于 Solid 插件之前。优先用 `bg-surface`、`text-foreground`、`text-secondary`、`border-border` 等语义颜色；类名需完整出现在源码中，避免动态拼接。
- **CSS 变量** 集中定义在 `src/styles/theme.css`，管理颜色、字号、圆角、控件高度和浮层层级。`uno.config.ts` 的 theme 将变量映射为工具类，shortcuts 定义组件的基础样式；`src/styles/ui.css` 保留状态、子元素和浮层尺寸等选择器，通过 `--uno` 复用工具类。
- **Lucide** 图标从 `@/components/icons` 按名称导入。适配层使用 `lucide` 的框架无关数据渲染 SVG，保留按需打包，避免旧 `lucide-solid` 的 Solid 1 依赖。常用尺寸为 16px，默认线宽为 2；纯图标按钮必须提供 `aria-label`，装饰性图标设置 `aria-hidden="true"`。新增图标时在适配层用 `createIcon` 导出。
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

Trigger 和关闭按钮通过 `as={Button}` 或 `as={IconButton}` 组合，避免嵌套按钮。DialogContent、TooltipContent 和两种 MenuContent 已包含 Portal，无需另加。弹窗应提供 DialogTitle，并按需要提供 DialogDescription。更多示例见 `src/UiPreview.tsx`。

Solid 2 的 DOM 属性使用 `tabindex` 等 HTML 名称；`cx` 接受字符串、条件对象和嵌套数组，返回渲染器支持的 class 数组。组件封装使用 `omit` 保留其余 props 的响应性，异步组件在 `Loading` 边界内加载。

Kobalte alpha 的浮层注册和输入读取时机通过 Bun 补丁适配了 Solid 2 的延迟写入，补丁由 `bun install` 自动应用，详见 [patches/README.md](patches/README.md)。上游仍锁定较早 RC 的 peer 版本，因此安装时会出现 peer 警告；Kobalte / Solid Primitives 在开发模式下也仍会报告未跟踪读取和 effect 派生状态警告。当前组件交互已纳入回归测试，后续升级时需重新验证，不能只放宽版本约束。

## 主题

`src/lib/theme.ts` 提供响应式 `theme()` 和 `setTheme("system" | "light" | "dark")`。默认跟随系统，选择保存在本地；系统模式会监听系统配色变化。

Solid 2 的 signal 写入默认在下一次微任务提交，因此设置主题时直接将传入模式应用到 DOM；不要在 setter 后立即读取 `theme()` 来更新页面。

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
