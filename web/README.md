# Celestite 前端

使用 SolidJS + TypeScript + Vite，桌面容器为 Tauri。

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

## UI 约定

- **Kobalte** 提供交互行为；通用组件从 `@/components/ui` 导入，在该目录统一封装样式。业务组件放在其他目录。
- **UnoCSS** 使用 `presetWind3`，Vite 插件位于 Solid 插件之前。优先用 `bg-surface`、`text-foreground`、`text-secondary`、`border-border` 等语义颜色；类名需完整出现在源码中，避免动态拼接。
- **CSS 变量** 集中定义在 `src/styles/theme.css`，管理颜色、字号、圆角、控件高度和浮层层级。`uno.config.ts` 的 theme 将变量映射为工具类，shortcuts 定义组件的基础样式；`src/styles/ui.css` 保留状态、子元素和浮层尺寸等选择器，通过 `--uno` 复用工具类。
- **Lucide** 图标直接从 `lucide-solid` 按名称导入。常用尺寸为 16px，默认线宽为 2；纯图标按钮必须提供 `aria-label`，装饰性图标设置 `aria-hidden="true"`。
- **路径别名** `@/` 对应 `src/`，已同时配置 Vite 与 TypeScript。

当前组件包括 Button、IconButton、Tooltip、Dialog、DropdownMenu、ContextMenu 和 TextField。Button 支持 `primary`、`secondary`、`ghost`、`danger` 四种 variant，以及 `sm`、`md` 两种 size。

```tsx
import { Plus } from "lucide-solid";
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

## 主题

`src/lib/theme.ts` 提供响应式 `theme()` 和 `setTheme("system" | "light" | "dark")`。默认跟随系统，选择保存在本地；系统模式会监听系统配色变化。

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
