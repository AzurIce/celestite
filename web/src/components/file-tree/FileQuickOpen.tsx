import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onSettled,
} from "solid-js";
import { FileText, Search } from "@/components/icons";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui";
import { ROOT_PATH, vaultPath } from "@/lib/vault/path";
import type { VaultPath } from "@/lib/vault/path";
import type { Entry, VaultBackend } from "@/lib/vault/types";
import {
  describeTreeError,
  entryName,
  parentPath,
} from "@/lib/file-tree/model";

const RESULT_PAGE_SIZE = 50;
const metadataDirectories = new Set([
  ".celestite",
  ".git",
  ".hg",
  ".svn",
  ".obsidian",
]);

// readDir exposes ordinary Vault entries, including settings. Filename lookup
// deliberately skips application metadata without changing the filesystem API.
function searchable(path: VaultPath) {
  const parts = path.split("/");
  return (
    !parts.some((part) => metadataDirectories.has(part)) &&
    !/^\.celestite-.*\.tmp$/.test(parts[parts.length - 1])
  );
}

interface FileQuickOpenProps {
  backend: VaultBackend;
  entries: readonly Entry[];
  disabled?: boolean;
  onOpen?: (path: VaultPath) => void;
}

/** The directory walk exists only while this dialog is open; it is not an index. */
export function FileQuickOpen(props: FileQuickOpenProps) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [files, setFiles] = createSignal<VaultPath[]>([]);
  const [selected, setSelected] = createSignal<VaultPath | null>(null);
  const [visibleLimit, setVisibleLimit] = createSignal(RESULT_PAGE_SIZE);
  const [scanning, setScanning] = createSignal(false);
  const [directoriesRead, setDirectoriesRead] = createSignal(0);
  const [failures, setFailures] = createSignal<string[]>([]);
  const id = `file-quick-open-${crypto.randomUUID()}`;
  let generation = 0;
  let disposed = false;
  let input!: HTMLInputElement;
  let trigger!: HTMLButtonElement;
  let opener: HTMLElement | undefined;
  let chosen = false;
  let backend = props.backend;

  const matches = createMemo(() => {
    const fragments = query()
      .trim()
      .toLocaleLowerCase()
      .replace(/\\/g, "/")
      .split(/\s+/)
      .filter(Boolean);
    return files()
      .filter((path) =>
        fragments.every((fragment) =>
          path.toLocaleLowerCase().includes(fragment),
        ),
      )
      .sort(
        (left, right) =>
          entryName(left).localeCompare(entryName(right), undefined, {
            numeric: true,
            sensitivity: "base",
          }) || left.localeCompare(right),
      );
  });
  const visible = createMemo(() => matches().slice(0, visibleLimit()));
  const active = createMemo(() => {
    const previous = selected();
    return previous && visible().includes(previous)
      ? previous
      : (visible()[0] ?? null);
  });
  const optionId = (path: VaultPath) => `${id}-${encodeURIComponent(path)}`;

  function cancel() {
    ++generation;
    setScanning(false);
  }

  function startScan() {
    const request = ++generation;
    const source = props.backend;
    const found = new Set(
      props.entries
        .filter((entry) => entry.kind === "file" && searchable(entry.path))
        .map((entry) => entry.path),
    );
    setFiles([...found]);
    setFailures([]);
    setDirectoriesRead(0);
    setScanning(true);
    const valid = () => !disposed && open() && request === generation;
    const yieldToUI = () =>
      new Promise<void>((resolve) => setTimeout(resolve, 0));
    const publish = () => {
      if (valid()) setFiles([...found]);
    };
    void (async () => {
      // Let the dialog paint before asking the backend for more directories.
      await yieldToUI();
      const queue = [ROOT_PATH];
      const queued = new Set(queue);
      let entriesRead = 0;
      for (let index = 0; index < queue.length && valid(); index++) {
        const directory = queue[index];
        try {
          for await (const entry of source.readDir(directory)) {
            if (!valid()) return;
            // Keep lookup inside the same root even if a backend returns a
            // malformed entry. Symlinks and package resource scopes are not walked.
            const path = vaultPath(entry.path);
            if (parentPath(path) !== directory || path === directory)
              throw new Error("Invalid directory entry");
            if (!searchable(path)) continue;
            if (entry.kind === "file") found.add(path);
            else if (entry.kind === "directory" && !queued.has(path)) {
              queued.add(path);
              queue.push(path);
            }
            if (++entriesRead % 64 === 0) {
              publish();
              await yieldToUI();
              if (!valid()) return;
            }
          }
        } catch (error) {
          if (!valid()) return;
          setFailures((previous) => [
            ...previous,
            `${directory || "根目录"}：${describeTreeError(error)}`,
          ]);
        }
        if (!valid()) return;
        setDirectoriesRead((previous) => previous + 1);
        publish();
        await yieldToUI();
      }
      if (valid()) setScanning(false);
    })();
  }

  function changeOpen(value: boolean) {
    if (value && props.disabled) return;
    if (value === open()) return;
    if (value) {
      chosen = false;
      opener =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : undefined;
      setQuery("");
      setSelected(null);
      setVisibleLimit(RESULT_PAGE_SIZE);
      setOpen(true);
      startScan();
    } else {
      cancel();
      setOpen(false);
    }
  }

  function choose(path: VaultPath) {
    if (props.disabled || !open()) return;
    chosen = true;
    changeOpen(false);
    props.onOpen?.(path);
  }

  function moveSelection(direction: number) {
    const options = matches();
    if (!options.length) return;
    const current = active();
    const index = current ? options.indexOf(current) : 0;
    const nextIndex = (index + direction + options.length) % options.length;
    const next = options[nextIndex];
    if (nextIndex >= visibleLimit())
      setVisibleLimit(
        Math.ceil((nextIndex + 1) / RESULT_PAGE_SIZE) * RESULT_PAGE_SIZE,
      );
    setSelected(next);
    queueMicrotask(() => {
      document
        .getElementById(optionId(next))
        ?.scrollIntoView({ block: "nearest" });
    });
  }

  function showMore() {
    const next = matches()[visibleLimit()];
    setVisibleLimit((limit) => limit + RESULT_PAGE_SIZE);
    if (next) {
      setSelected(next);
      queueMicrotask(() => {
        document
          .getElementById(optionId(next))
          ?.scrollIntoView({ block: "nearest" });
      });
    }
    input.focus();
  }

  createEffect(
    () => props.disabled,
    (disabled) => {
      if (disabled) changeOpen(false);
    },
  );
  createEffect(
    () => props.backend,
    (next) => {
      if (next !== backend) {
        backend = next;
        changeOpen(false);
      }
    },
  );
  onSettled(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        props.disabled ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.key.toLowerCase() !== "k"
      )
        return;
      // Do not open a second modal over file operations or connection management.
      if (!open() && document.querySelector(".ui-dialog")) return;
      event.preventDefault();
      if (open()) input?.focus();
      else changeOpen(true);
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });
  onCleanup(() => {
    disposed = true;
    cancel();
  });

  return (
    <>
      <Button
        ref={trigger}
        class="tree-file-finder"
        variant="ghost"
        disabled={props.disabled}
        onClick={() => changeOpen(true)}
        aria-haspopup="dialog"
        aria-label="查找文件"
      >
        <Search size={15} />
        <span>查找文件</span>
        <kbd>Ctrl K</kbd>
      </Button>
      <Dialog open={open()} onOpenChange={changeOpen}>
        <DialogContent
          class="file-quick-open"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (chosen) return;
            const target =
              opener?.isConnected && opener.getClientRects().length
                ? opener
                : trigger;
            if (target?.getClientRects().length) target.focus();
          }}
        >
          <DialogTitle class="sr-only">查找文件</DialogTitle>
          <DialogDescription class="sr-only">
            按文件名或路径查找当前 Vault。用空格组合多个片段，不搜索正文。
          </DialogDescription>
          <div class="quick-open-search">
            <Search size={18} />
            <input
              ref={input}
              value={query()}
              onInput={(event) => {
                setQuery(event.currentTarget.value);
                setSelected(null);
                setVisibleLimit(RESULT_PAGE_SIZE);
              }}
              onKeyDown={(event) => {
                if (event.isComposing) return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  moveSelection(event.key === "ArrowDown" ? 1 : -1);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const path = active();
                  if (path) choose(path);
                }
              }}
              placeholder="输入文件名或路径…"
              aria-label="文件名或路径"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={`${id}-results`}
              aria-activedescendant={active() ? optionId(active()!) : undefined}
              autocomplete="off"
              spellcheck={false}
            />
            <kbd>Esc</kbd>
          </div>
          <div
            class="quick-open-results"
            id={`${id}-results`}
            role="listbox"
            aria-label="匹配文件"
          >
            <For each={visible()}>
              {(path) => (
                <button
                  type="button"
                  role="option"
                  id={optionId(path)}
                  class="quick-open-option"
                  aria-selected={active() === path ? "true" : "false"}
                  tabindex={-1}
                  onPointerMove={() => setSelected(path)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(path)}
                >
                  <FileText size={17} />
                  <span>
                    <strong>{entryName(path)}</strong>
                    <small>{parentPath(path) || "根目录"}</small>
                  </span>
                </button>
              )}
            </For>
            <Show when={!visible().length}>
              <p class="quick-open-empty">
                {scanning() ? "正在查找匹配的文件…" : "没有匹配的文件"}
              </p>
            </Show>
          </div>
          <Show when={visible().length < matches().length}>
            <Button class="quick-open-more" variant="ghost" onClick={showMore}>
              显示更多（剩余 {matches().length - visible().length} 项）
            </Button>
          </Show>
          <Show when={failures().length}>
            <div class="quick-open-errors" role="alert">
              <p>部分目录未能读取，结果可能不完整。</p>
              <For each={failures().slice(0, 3)}>
                {(message) => <p>{message}</p>}
              </For>
              <Show when={failures().length > 3}>
                <p>另有 {failures().length - 3} 个目录读取失败。</p>
              </Show>
              <Button
                size="sm"
                variant="ghost"
                disabled={scanning()}
                onClick={startScan}
              >
                重新查找
              </Button>
            </div>
          </Show>
          <div class="quick-open-footer">
            <span role="status" aria-live="polite">
              {scanning()
                ? `正在查找 · 已读 ${directoriesRead()} 个目录`
                : `${matches().length} 个匹配`}
              <Show when={matches().length > visible().length}>
                {" "}
                · 已显示 {visible().length} 项
              </Show>
            </span>
            <span>↑ ↓ 选择 · Enter 打开</span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
