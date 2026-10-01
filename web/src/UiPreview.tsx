import { createSignal } from "solid-js";
import {
  Check,
  ChevronDown,
  FileText,
  Monitor,
  Moon,
  Plus,
  Sun,
} from "lucide-solid";
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

function UiPreview() {
  const [noteName, setNoteName] = createSignal("我的第一篇笔记");
  const [status, setStatus] = createSignal("准备就绪");

  return (
    <main class="mx-auto max-w-3xl px-6 py-12">
      <header class="mb-8 flex items-center justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold">Celestite</h1>
          <p class="mt-1 text-secondary">UI 组件预览</p>
        </div>
        <DropdownMenu placement="bottom-end" gutter={6}>
          <DropdownMenuTrigger as={Button}>
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

      <section
        aria-label="基础组件"
        class="flex flex-col gap-6 rounded-xl border border-solid border-border bg-surface p-6"
      >
        <div>
          <h2 class="mb-3 text-base font-semibold">按钮与提示</h2>
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

        <TextField value={noteName()} onChange={setNoteName}>
          <TextFieldLabel>笔记名称</TextFieldLabel>
          <TextFieldInput placeholder="输入笔记名称" />
          <TextFieldDescription>
            输入框的标签和说明会自动关联。
          </TextFieldDescription>
        </TextField>

        <div class="flex flex-wrap gap-2">
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

        <ContextMenu>
          <ContextMenuTrigger
            as="div"
            tabIndex={0}
            aria-label="笔记，右键或按 Shift+F10 打开操作菜单"
            class="flex min-h-24 items-center justify-center gap-2 rounded-ui border border-dashed border-border bg-background p-4"
          >
            <FileText size={18} aria-hidden="true" /> 在这里右键打开菜单
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => setStatus("点击了打开笔记")}>
              打开笔记
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => setStatus("点击了在新标签页打开")}>
              在新标签页打开
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </section>

      <p role="status" class="mt-4 text-xs text-secondary">
        {status()}
      </p>
    </main>
  );
}

export default UiPreview;
