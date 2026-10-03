import {
  childPath,
  ROOT_PATH,
  vaultPath,
  VaultError,
  VaultRenameError,
} from "../vault";
import type { Entry, VaultBackend, VaultPath } from "../vault";

export const entryName = (path: VaultPath) =>
  path.slice(path.lastIndexOf("/") + 1);
export const parentPath = (path: VaultPath) =>
  vaultPath(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const isWithin = (path: VaultPath, parent: VaultPath) =>
  path === parent || path.startsWith(`${parent}/`);
export function topLevelPaths(paths: Iterable<VaultPath>): VaultPath[] {
  const unique = [...new Set(paths)].filter((path) => path !== ROOT_PATH);
  return unique.filter(
    (path) =>
      !unique.some((parent) => path !== parent && isWithin(path, parent)),
  );
}

export interface TreeRow extends Entry {
  parent: VaultPath;
  level: number;
  position: number;
  siblings: number;
}
export type TreeChange =
  | { kind: "create" | "remove"; path: VaultPath }
  | { kind: "rename"; from: VaultPath; to: VaultPath };
export interface TreeSnapshot {
  rows: TreeRow[];
  byPath: ReadonlyMap<VaultPath, TreeRow>;
  groups: ReadonlyMap<VaultPath, readonly VaultPath[]>;
  expanded: ReadonlySet<VaultPath>;
  selected: ReadonlySet<VaultPath>;
  cut: ReadonlySet<VaultPath>;
  clipboard: { mode: "cut" | "copy"; count: number };
  focused: VaultPath | null;
  busy: boolean;
  status: string;
  error: string | null;
}
export interface SelectionModifiers {
  toggle?: boolean;
  range?: boolean;
  focusOnly?: boolean;
}
class TreeCopyError extends Error {
  constructor(readonly cause: unknown) {
    super("Copy did not complete");
  }
}

export function describeTreeError(error: unknown): string {
  if (error instanceof TreeCopyError)
    return `${describeTreeError(error.cause)}源未修改；目标可能有未完成的内容，请检查后重试。`;
  if (error instanceof VaultRenameError) {
    if (error.targetComplete)
      return "目标已复制完整，但源未能完全删除。请检查源和目标，完整目标已保留。";
    if (error.cleanupError)
      return "复制失败，源已保留，但目标还有未清理的内容。请检查两处文件。";
  }
  if (error instanceof VaultError) {
    const messages: Record<string, string> = {
      AlreadyExists: "目标名称已存在，没有覆盖已有内容。",
      InvalidPath:
        "名称无效，或正在将文件夹移入自身。名称不能含路径分隔符、. 或 ..。",
      NotFound: "文件或目标文件夹已不存在，请刷新后重试。",
      NotDirectory: "目标不是文件夹。",
      QuotaExceeded: "存储空间不足，操作未能完成。",
      PermissionDenied: "无法访问这些文件，请检查存储权限。",
      Busy: "文件正在被占用，请稍后重试。",
      Closed: "Vault 已关闭。",
      Conflict:
        "文件已被其他客户端或程序修改。你的编辑仍保留，请核对远端内容后再保存。",
    };
    return messages[error.code] ?? "文件操作失败，请刷新后检查文件状态。";
  }
  return "无法完成操作，请重试。";
}

/** UI 无关的树状态。IO 单次执行；批量操作不冒充后端事务。 */
export class FileTreeModel {
  private children = new Map<VaultPath, Entry[]>();
  private expanded = new Set<VaultPath>();
  private selected = new Set<VaultPath>();
  private cut = new Set<VaultPath>();
  private clipboardMode: "cut" | "copy" = "cut";
  private focused: VaultPath | null = null;
  private anchor: VaultPath | null = null;
  private busy = false;
  private status = "准备就绪";
  private error: string | null = null;
  private disposed = false;
  private invalidated = false;
  private cached?: TreeSnapshot;
  private readonly listeners = new Set<(state: TreeSnapshot) => void>();

  constructor(
    readonly backend: VaultBackend,
    private readonly onChange?: (change: TreeChange) => void,
  ) {}

  snapshot(): TreeSnapshot {
    if (this.cached) return this.cached;
    const rows = this.rows();
    const groups = new Map<VaultPath, VaultPath[]>();
    for (const row of rows) {
      const group = groups.get(row.parent) ?? [];
      group.push(row.path);
      groups.set(row.parent, group);
    }
    return (this.cached = {
      rows,
      byPath: new Map(rows.map((row) => [row.path, row])),
      groups,
      expanded: new Set(this.expanded),
      selected: new Set(this.selected),
      cut: this.clipboardMode === "cut" ? new Set(this.cut) : new Set(),
      clipboard: { mode: this.clipboardMode, count: this.cut.size },
      focused: this.focused,
      busy: this.busy,
      status: this.status,
      error: this.error,
    });
  }
  subscribe(listener: (state: TreeSnapshot) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
  private notify() {
    this.cached = undefined;
    if (!this.disposed) {
      const state = this.snapshot();
      this.listeners.forEach((listener) => listener(state));
    }
  }
  private rows(): TreeRow[] {
    const result: TreeRow[] = [];
    const walk = (parent: VaultPath, level: number) => {
      const entries = this.children.get(parent) ?? [];
      entries.forEach((entry, index) => {
        result.push({
          ...entry,
          parent,
          level,
          position: index + 1,
          siblings: entries.length,
        });
        if (entry.kind === "directory" && this.expanded.has(entry.path))
          walk(entry.path, level + 1);
      });
    };
    walk(ROOT_PATH, 1);
    return result;
  }
  private known(path: VaultPath): Entry | undefined {
    if (path === ROOT_PATH) return { path, kind: "directory" };
    return this.children
      .get(parentPath(path))
      ?.find((entry) => entry.path === path);
  }
  private async readDirectory(path: VaultPath) {
    const entries: Entry[] = [];
    for await (const entry of this.backend.readDir(path)) entries.push(entry);
    return entries.sort(
      (a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        entryName(a.path).localeCompare(entryName(b.path), undefined, {
          numeric: true,
          sensitivity: "base",
        }) ||
        a.path.localeCompare(b.path),
    );
  }
  private reconcile() {
    const visible = this.rows().map((row) => row.path);
    const available = new Set(visible);
    this.selected = new Set(
      [...this.selected].filter((path) => available.has(path)),
    );
    if (!this.focused || !available.has(this.focused))
      this.focused = visible[0] ?? null;
    if (!this.anchor || !available.has(this.anchor)) this.anchor = this.focused;
  }
  private async reload() {
    const next = new Map<VaultPath, Entry[]>();
    const expanded = new Set<VaultPath>();
    const walk = async (path: VaultPath) => {
      const entries = await this.readDirectory(path);
      next.set(path, entries);
      for (const entry of entries) {
        if (entry.kind === "directory" && this.expanded.has(entry.path)) {
          expanded.add(entry.path);
          await walk(entry.path);
        }
      }
    };
    try {
      await walk(ROOT_PATH);
    } finally {
      // 读取某个子目录失败时仍提交已读到的目录，避免继续展示已删除的旧条目。
      if (next.has(ROOT_PATH)) {
        this.children = next;
        this.expanded = expanded;
        this.reconcile();
      }
    }
  }
  private async perform(
    label: string,
    task: (completed: () => void) => Promise<void>,
    reload = true,
    clearError = true,
  ): Promise<boolean> {
    if (this.busy || this.disposed) return false;
    this.busy = true;
    if (clearError) this.error = null;
    this.status = label;
    this.notify();
    let completed = 0;
    let success = false;
    try {
      await task(() => {
        completed++;
      });
      success = true;
    } catch (error) {
      this.error = `${completed ? `已完成 ${completed} 项，其余操作已停止。` : ""}${describeTreeError(error)}`;
    }
    if (reload) {
      try {
        await this.reload();
      } catch {
        this.error = `${this.error ?? "操作已完成。"}文件列表读取失败，请刷新。`;
        success = false;
      }
    }
    this.busy = false;
    this.status = this.error ? "操作未完全完成" : "准备就绪";
    this.notify();
    if (this.invalidated && !this.disposed) {
      this.invalidated = false;
      void this.refresh(true);
    }
    return success;
  }
  refresh(preserveError = false) {
    return this.perform(
      "正在读取文件…",
      async () => {
        await this.reload();
      },
      false,
      !preserveError,
    );
  }
  invalidate() {
    if (this.busy) this.invalidated = true;
    else void this.refresh(true);
  }
  clearError() {
    this.error = null;
    this.notify();
  }

  select(path: VaultPath, modifiers: SelectionModifiers = {}) {
    const visible = this.rows().map((row) => row.path);
    const index = visible.indexOf(path);
    if (index < 0) return;
    const previousFocus = this.focused;
    this.focused = path;
    if (!modifiers.focusOnly) {
      if (modifiers.range) {
        const start = Math.max(
          0,
          visible.indexOf(this.anchor ?? previousFocus ?? path),
        );
        const range = visible.slice(
          Math.min(start, index),
          Math.max(start, index) + 1,
        );
        this.selected = new Set(
          modifiers.toggle ? [...this.selected, ...range] : range,
        );
      } else if (modifiers.toggle) {
        if (this.selected.has(path)) this.selected.delete(path);
        else this.selected.add(path);
        this.anchor = path;
      } else {
        this.selected = new Set([path]);
        this.anchor = path;
      }
    }
    this.notify();
  }
  contextSelect(path: VaultPath) {
    if (!this.selected.has(path)) this.select(path);
    else {
      this.focused = path;
      this.notify();
    }
  }
  clearSelection(clearFocus = false) {
    this.selected.clear();
    if (clearFocus) this.focused = null;
    this.anchor = this.focused;
    this.notify();
  }
  selectAll() {
    this.selected = new Set(this.rows().map((row) => row.path));
    this.notify();
  }
  selection() {
    return topLevelPaths(this.selected);
  }
  directoryFor(path = this.focused): VaultPath {
    return path && this.known(path)?.kind === "directory"
      ? path
      : path
        ? parentPath(path)
        : ROOT_PATH;
  }
  async toggle(path: VaultPath) {
    if (this.busy || this.known(path)?.kind !== "directory") return false;
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
      if (
        [...this.selected].some(
          (selected) => selected !== path && isWithin(selected, path),
        )
      )
        this.selected.add(path);
      if (this.focused && isWithin(this.focused, path)) this.focused = path;
      this.reconcile();
      this.notify();
      return true;
    }
    return this.perform(
      "正在读取文件夹…",
      async () => {
        this.children.set(path, await this.readDirectory(path));
        this.expanded.add(path);
      },
      false,
    );
  }
  collapseAll() {
    if (this.busy) return;
    this.expanded.clear();
    this.reconcile();
    this.notify();
  }
  cutSelection() {
    const paths = this.selection();
    if (!paths.length) return;
    this.clipboardMode = "cut";
    this.cut = new Set(paths);
    this.status = `已剪切 ${this.cut.size} 项，选择目标文件夹后粘贴`;
    this.notify();
  }
  copySelection() {
    const paths = this.selection();
    if (!paths.length) return;
    this.clipboardMode = "copy";
    this.cut = new Set(paths);
    this.status = `已复制 ${this.cut.size} 项，选择目标文件夹后粘贴`;
    this.notify();
  }
  cancelCut() {
    this.cut.clear();
    this.status = "准备就绪";
    this.notify();
  }
  paste(parent: VaultPath) {
    return this.cut.size
      ? this.clipboardMode === "cut"
        ? this.move([...this.cut], parent)
        : this.copy([...this.cut], parent)
      : Promise.resolve(false);
  }
  canMove(paths: Iterable<VaultPath>, parent: VaultPath): boolean {
    const sources = topLevelPaths(paths);
    return (
      sources.length > 0 &&
      this.known(parent)?.kind === "directory" &&
      !sources.some((from) => isWithin(parent, from)) &&
      sources.some((from) => parentPath(from) !== parent)
    );
  }
  private reveal(parent: VaultPath) {
    for (let path = parent; path !== ROOT_PATH; path = parentPath(path))
      this.expanded.add(path);
  }
  private repath(from: VaultPath, to: VaultPath) {
    const map = (path: VaultPath) =>
      isWithin(path, from) ? vaultPath(to + path.slice(from.length)) : path;
    this.expanded = new Set([...this.expanded].map(map));
    this.selected = new Set([...this.selected].map(map));
    this.cut =
      this.clipboardMode === "copy"
        ? new Set([...this.cut].map(map))
        : new Set([...this.cut].filter((path) => !isWithin(path, from)));
    if (this.focused) this.focused = map(this.focused);
    if (this.anchor) this.anchor = map(this.anchor);
  }
  private changed(change: TreeChange) {
    if (!this.disposed) this.onChange?.(change);
  }

  create(parent: VaultPath, name: string, kind: "file" | "directory") {
    return this.perform("正在创建…", async (completed) => {
      const path = childPath(parent, name);
      if (kind === "directory") await this.backend.mkdir(path);
      else
        await this.backend.writeFile(path, new Uint8Array(), {
          mode: "create",
        });
      completed();
      this.reveal(parent);
      this.selected = new Set([path]);
      this.focused = path;
      this.anchor = path;
      this.changed({ kind: "create", path });
    });
  }
  rename(from: VaultPath, name: string) {
    return this.perform("正在重命名…", async (completed) => {
      const to = childPath(parentPath(from), name);
      await this.backend.rename(from, to);
      completed();
      this.repath(from, to);
      this.changed({ kind: "rename", from, to });
    });
  }
  move(paths: Iterable<VaultPath>, parent: VaultPath) {
    const sources = topLevelPaths(paths);
    return this.perform("正在移动…", async (completed) => {
      if ((await this.backend.stat(parent))?.kind !== "directory")
        throw new VaultError(
          "NotDirectory",
          "Target must be a directory",
          parent,
        );
      const plans: { from: VaultPath; to: VaultPath }[] = [];
      const targets = new Set<VaultPath>();
      // 整批预检后才开始写入。后端仍各自负责同源竞争中的最终检查。
      for (const from of sources) {
        if (!(await this.backend.stat(from)))
          throw new VaultError("NotFound", "Source missing", from);
        if (isWithin(parent, from))
          throw new VaultError(
            "InvalidPath",
            "Cannot move into source",
            parent,
          );
        const to = childPath(parent, entryName(from));
        if (to === from) continue;
        if (targets.has(to) || (await this.backend.stat(to)))
          throw new VaultError("AlreadyExists", "Target already exists", to);
        targets.add(to);
        plans.push({ from, to });
      }
      for (const { from, to } of plans) {
        await this.backend.rename(from, to);
        completed();
        this.repath(from, to);
        this.reveal(parent);
        this.changed({ kind: "rename", from, to });
      }
      if (this.clipboardMode === "cut")
        for (const from of sources)
          if (parentPath(from) === parent) this.cut.delete(from);
    });
  }
  copy(paths: Iterable<VaultPath>, parent: VaultPath) {
    const sources = topLevelPaths(paths);
    return this.perform("正在复制…", async (completed) => {
      if ((await this.backend.stat(parent))?.kind !== "directory")
        throw new VaultError(
          "NotDirectory",
          "Target must be a directory",
          parent,
        );
      const plans: { from: VaultPath; to: VaultPath }[] = [];
      const targets = new Set<VaultPath>();
      for (const from of sources) {
        const source = await this.backend.stat(from);
        if (!source) throw new VaultError("NotFound", "Source missing", from);
        if (isWithin(parent, from))
          throw new VaultError(
            "InvalidPath",
            "Cannot copy into source",
            parent,
          );
        let to = childPath(parent, entryName(from));
        if (to === from) {
          const name = entryName(from);
          const dot =
            source.kind === "file" && name.lastIndexOf(".") > 0
              ? name.lastIndexOf(".")
              : name.length;
          let number = 1;
          do {
            to = childPath(
              parent,
              `${name.slice(0, dot)} 副本${number === 1 ? "" : ` ${number}`}${name.slice(dot)}`,
            );
            number++;
          } while (targets.has(to) || (await this.backend.stat(to)));
        } else if (targets.has(to) || (await this.backend.stat(to)))
          throw new VaultError("AlreadyExists", "Target already exists", to);
        targets.add(to);
        plans.push({ from, to });
      }
      const copied: VaultPath[] = [];
      for (const { from, to } of plans) {
        try {
          await this.copyContents(from, to);
        } catch (error) {
          throw new TreeCopyError(error);
        }
        completed();
        copied.push(to);
        this.reveal(parent);
        this.selected = new Set(copied);
        this.focused = to;
        this.anchor = to;
        this.changed({ kind: "create", path: to });
      }
    });
  }
  private async copyContents(from: VaultPath, to: VaultPath): Promise<void> {
    const source = await this.backend.stat(from);
    if (!source) throw new VaultError("NotFound", "Source missing", from);
    if (source.kind === "file") {
      await this.backend.writeFile(to, await this.backend.readFile(from), {
        mode: "create",
      });
    } else if (source.kind === "directory") {
      await this.backend.mkdir(to);
      for await (const child of this.backend.readDir(from))
        await this.copyContents(
          child.path,
          childPath(to, entryName(child.path)),
        );
    } else
      throw new VaultError("Unsupported", "Cannot copy this entry kind", from);
  }
  remove(paths: Iterable<VaultPath>) {
    const sources = topLevelPaths(paths);
    return this.perform("正在删除…", async (completed) => {
      for (const path of sources) {
        await this.backend.remove(path, { recursive: true });
        completed();
        this.cut = new Set(
          [...this.cut].filter((item) => !isWithin(item, path)),
        );
        this.changed({ kind: "remove", path });
      }
    });
  }
  importFiles(files: readonly File[], parent: VaultPath) {
    return this.perform("正在导入…", async (completed) => {
      const paths = files.map((file) => childPath(parent, file.name));
      if (new Set(paths).size !== paths.length)
        throw new VaultError("AlreadyExists", "Duplicate import names");
      for (const path of paths)
        if (await this.backend.stat(path))
          throw new VaultError("AlreadyExists", "Target already exists", path);
      const imported: VaultPath[] = [];
      for (let i = 0; i < files.length; i++) {
        await this.backend.writeFile(
          paths[i],
          new Uint8Array(await files[i].arrayBuffer()),
          { mode: "create" },
        );
        completed();
        imported.push(paths[i]);
        this.changed({ kind: "create", path: paths[i] });
        this.selected = new Set(imported);
        this.focused = paths[i];
        this.reveal(parent);
      }
    });
  }
}
