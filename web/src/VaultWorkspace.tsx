import { Show, createSignal, onCleanup, onSettled } from "solid-js";
import { FileTree } from "@/components/file-tree";
import {
  Button,
  IconButton,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui";
import {
  FolderOpen,
  FileText,
  Moon,
  Sun,
  Monitor,
  Check,
  ChevronDown,
  ChevronLeft,
} from "@/components/icons";
import { openOpfsVault, vaultPath } from "@/lib/vault";
import type { VaultBackend, VaultPath } from "@/lib/vault";
import { isWithin, describeTreeError } from "@/lib/file-tree/model";
import type { TreeChange } from "@/lib/file-tree/model";
import { theme, setTheme } from "@/lib/theme";

interface Preview {
  path: VaultPath;
  content: string;
  size?: number;
  loading?: boolean;
  error?: string;
}

export default function VaultWorkspace() {
  const [backend, setBackend] = createSignal<VaultBackend | null>(null);
  const [opening, setOpening] = createSignal(true);
  const [openError, setOpenError] = createSignal<string | null>(null);
  const [preview, setPreview] = createSignal<Preview | null>(null);
  let currentBackend: VaultBackend | null = null;
  let activePath: VaultPath | null = null;
  let generation = 0;
  let disposed = false;
  let starting = false;

  async function start() {
    if (starting || disposed) return;
    starting = true;
    setOpening(true);
    setOpenError(null);
    try {
      const opened = await openOpfsVault();
      if (disposed) {
        await opened.close();
        return;
      }
      currentBackend = opened;
      setBackend(opened);
    } catch {
      if (!disposed)
        setOpenError(
          "无法打开文件库。请检查浏览器是否允许保存站点数据，然后重试。",
        );
    } finally {
      starting = false;
      if (!disposed) setOpening(false);
    }
  }
  onSettled(() => {
    void start();
  });
  onCleanup(() => {
    disposed = true;
    generation++;
    void currentBackend?.close();
  });

  async function openFile(path: VaultPath) {
    if (!currentBackend) return;
    const request = ++generation;
    activePath = path;
    setPreview({ path, content: "", loading: true });
    try {
      const stat = await currentBackend.stat(path);
      if (!stat) throw new Error("Missing file");
      let content: string;
      if ((stat.size ?? 0) > 1024 * 1024)
        content = "文件较大，请通过右键菜单下载后查看。";
      else {
        const bytes = await currentBackend.readFile(path);
        try {
          content = bytes.includes(0)
            ? "这是一个二进制文件，可通过右键菜单下载。"
            : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          content = "这是一个二进制文件，可通过右键菜单下载。";
        }
      }
      if (!disposed && generation === request)
        setPreview({ path, content, size: stat.size });
    } catch (error) {
      if (!disposed && generation === request)
        setPreview({ path, content: "", error: describeTreeError(error) });
    }
  }
  function changed(change: TreeChange) {
    if (!activePath) return;
    if (change.kind === "rename" && isWithin(activePath, change.from)) {
      void openFile(
        vaultPath(change.to + activePath.slice(change.from.length)),
      );
    } else if (change.kind === "remove" && isWithin(activePath, change.path)) {
      activePath = null;
      generation++;
      setPreview(null);
    }
  }

  return (
    <main class="flex h-dvh min-h-0 flex-col">
      <header class="flex h-14 shrink-0 items-center gap-3 border-b border-solid border-border bg-surface px-4">
        <div class="flex h-8 w-8 items-center justify-center rounded-panel bg-accent text-accent-foreground">
          <FolderOpen size={18} />
        </div>
        <h1 class="text-base font-semibold">Celestite</h1>
        <span class="hidden text-ui-sm text-secondary sm:inline">
          我的 Vault
        </span>
        <div class="ml-auto flex items-center gap-2">
          <Show when={import.meta.env.DEV}>
            <a
              href="/ui"
              class="hidden text-ui-sm text-secondary no-underline hover:text-foreground sm:inline"
            >
              组件预览
            </a>
          </Show>
          <DropdownMenu placement="bottom-end" gutter={6}>
            <DropdownMenuTrigger as={Button} size="sm">
              <Monitor size={15} />
              主题
              <ChevronDown size={13} />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => setTheme("system")}>
                <Monitor size={15} />
                跟随系统
                <Show when={theme() === "system"}>
                  <Check size={14} class="ml-auto" />
                </Show>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTheme("light")}>
                <Sun size={15} />
                浅色
                <Show when={theme() === "light"}>
                  <Check size={14} class="ml-auto" />
                </Show>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTheme("dark")}>
                <Moon size={15} />
                深色
                <Show when={theme() === "dark"}>
                  <Check size={14} class="ml-auto" />
                </Show>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <Show
        when={backend()}
        keyed
        fallback={
          <div class="m-auto max-w-md p-8 text-center">
            <p role={openError() ? "alert" : "status"} class="text-secondary">
              {opening() ? "正在打开文件库…" : openError()}
            </p>
            <Show when={openError()}>
              <Button class="mt-4" onClick={() => void start()}>
                重试
              </Button>
            </Show>
          </div>
        }
      >
        {(opened) => (
          <div class="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[300px_minmax(0,1fr)]">
            <div class="flex min-h-0 flex-col border-r border-solid border-border">
              <FileTree
                backend={opened}
                label="我的 Vault"
                onOpen={(path) => void openFile(path)}
                onChange={changed}
              />
            </div>
            <section
              aria-label="文件预览"
              class={
                preview()
                  ? "fixed inset-x-0 bottom-0 top-14 z-20 flex min-h-0 min-w-0 flex-col bg-background sm:static sm:z-auto"
                  : "hidden min-h-0 min-w-0 flex-col bg-background sm:flex"
              }
            >
              <Show
                when={preview()}
                keyed
                fallback={
                  <div class="m-auto max-w-sm p-8 text-center">
                    <FileText size={36} class="mx-auto mb-4 text-secondary" />
                    <h2 class="text-ui-heading font-medium">从一份文件开始</h2>
                    <p class="mt-3 text-secondary">
                      在左侧新建或导入文件，双击即可预览。
                    </p>
                    <p class="mt-6 text-ui-sm text-secondary">
                      右键打开操作菜单，也可以用键盘选择和移动。
                    </p>
                  </div>
                }
              >
                {(file) => (
                  <>
                    <header class="flex items-center gap-2 border-b border-solid border-border px-5 py-3">
                      <IconButton
                        aria-label="返回文件树"
                        size="sm"
                        class="sm:hidden"
                        onClick={() => {
                          activePath = null;
                          generation++;
                          setPreview(null);
                          onSettled(() =>
                            document
                              .querySelector<HTMLElement>('[role="tree"]')
                              ?.focus(),
                          );
                        }}
                      >
                        <ChevronLeft size={16} />
                      </IconButton>
                      <FileText size={16} class="text-secondary" />
                      <span class="min-w-0 truncate text-ui-sm">
                        {file.path}
                      </span>
                      <span class="ml-auto shrink-0 text-ui-sm text-secondary">
                        {file.size === undefined
                          ? ""
                          : `${file.size.toLocaleString()} 字节`}
                      </span>
                    </header>
                    <Show
                      when={file.error}
                      fallback={
                        <pre class="m-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-6 font-mono text-ui-sm leading-relaxed">
                          {file.loading
                            ? "正在读取…"
                            : file.content || "（空文件）"}
                        </pre>
                      }
                    >
                      <p role="alert" class="p-6 text-danger">
                        {file.error}
                      </p>
                    </Show>
                  </>
                )}
              </Show>
            </section>
          </div>
        )}
      </Show>
    </main>
  );
}
