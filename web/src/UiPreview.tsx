import { createSignal } from "solid-js";
import {
  Check,
  ChevronDown,
  FileText,
  Monitor,
  Moon,
  Plus,
  Sun,
} from "@/components/icons";
import {
  Button,
  IconButton,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  TextField,
  TextFieldLabel,
  TextFieldInput,
  TextFieldDescription,
} from "@/components/ui";
import { theme, setTheme } from "@/lib/theme";
import "./styles/preview.css";

function UiPreview() {
  const [noteName, setNoteName] = createSignal("我的第一篇笔记");
  const [status, setStatus] = createSignal("准备就绪");

  return (
    <main class="ui-preview">
      <header class="preview-header">
        <div>
          <h1 class="text-ui font-semibold">Celestite</h1>
          <p class="mt-1 text-ui-sm text-secondary">界面组件</p>
        </div>
        <DropdownMenu placement="bottom-end" gutter={6}>
          <DropdownMenuTrigger as={Button} variant="ghost">
            <Monitor size={16} aria-hidden="true" /> 主题
            <ChevronDown size={14} aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => setTheme("system")}>
              <Monitor size={16} aria-hidden="true" /> 跟随系统
              {theme() === "system" && (
                <Check size={14} class="ml-auto" aria-hidden="true" />
              )}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setTheme("light")}>
              <Sun size={16} aria-hidden="true" /> 浅色
              {theme() === "light" && (
                <Check size={14} class="ml-auto" aria-hidden="true" />
              )}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setTheme("dark")}>
              <Moon size={16} aria-hidden="true" /> 深色
              {theme() === "dark" && (
                <Check size={14} class="ml-auto" aria-hidden="true" />
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div class="preview-intro">
        <h2 class="text-2xl font-medium tracking-tight">组件预览</h2>
        <p class="mt-3 text-ui-sm text-secondary">
          工作区使用的基础控件与交互状态。
        </p>
        <a href="/" class="preview-back">
          返回工作区 <span aria-hidden="true">↗</span>
        </a>
      </div>

      <section aria-label="基础组件" class="preview-section">
        <div class="preview-section-label">
          <span aria-hidden="true">01</span>
          <h2>按钮与提示</h2>
        </div>
        <div class="preview-section-content">
          <div class="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              onClick={() => setStatus("点击了新建笔记")}
            >
              <Plus size={16} aria-hidden="true" /> 新建笔记
            </Button>
            <Button onClick={() => setStatus("点击了普通按钮")}>
              普通按钮
            </Button>
            <Button variant="ghost" onClick={() => setStatus("点击了轻量按钮")}>
              轻量按钮
            </Button>
            <Button
              variant="danger"
              onClick={() => setStatus("点击了危险操作示例")}
            >
              危险操作
            </Button>
            <Button disabled>不可用</Button>
            <Tooltip openDelay={300} gutter={6}>
              <TooltipTrigger
                as={IconButton}
                aria-label="添加笔记"
                onClick={() => setStatus("点击了图标按钮")}
              >
                <Plus size={16} aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>添加笔记</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </section>

      <section aria-label="输入与弹窗" class="preview-section">
        <div class="preview-section-label">
          <span aria-hidden="true">02</span>
          <h2>输入与操作</h2>
        </div>
        <div class="preview-section-content">
          <TextField value={noteName()} onChange={setNoteName}>
            <TextFieldLabel>笔记名称</TextFieldLabel>
            <TextFieldInput placeholder="输入笔记名称" />
            <TextFieldDescription>
              为笔记取一个容易找到的名字。
            </TextFieldDescription>
          </TextField>

          <div class="mt-5 flex flex-wrap gap-2">
            <Dialog>
              <DialogTrigger as={Button}>打开弹窗</DialogTrigger>
              <DialogContent>
                <DialogTitle>笔记信息</DialogTitle>
                <DialogDescription>
                  当前笔记：{noteName() || "未命名笔记"}
                </DialogDescription>
                <div class="mt-6 flex justify-end">
                  <DialogClose as={Button} variant="primary">
                    完成
                  </DialogClose>
                </div>
              </DialogContent>
            </Dialog>

            <DropdownMenu gutter={6}>
              <DropdownMenuTrigger as={Button}>
                笔记操作 <ChevronDown size={14} aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setStatus("点击了重命名")}>
                  重命名
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setStatus("点击了复制链接")}>
                  复制链接
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled>导出（暂不可用）</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </section>

      <section aria-label="右键菜单" class="preview-section">
        <div class="preview-section-label">
          <span aria-hidden="true">03</span>
          <h2>上下文菜单</h2>
        </div>
        <div class="preview-section-content">
          <ContextMenu>
            <ContextMenuTrigger
              as="div"
              tabindex={0}
              aria-label="笔记，右键或按 Shift+F10 打开操作菜单"
              class="preview-context"
            >
              <FileText size={18} aria-hidden="true" />
              <span>我的第一篇笔记</span>
              <span class="ml-auto text-ui-sm text-secondary">
                右键查看操作
              </span>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => setStatus("点击了打开笔记")}>
                打开笔记
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => setStatus("点击了在新标签页打开")}
              >
                在新标签页打开
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>
      </section>

      <p role="status" class="preview-status">
        {status()}
      </p>
    </main>
  );
}

export default UiPreview;
