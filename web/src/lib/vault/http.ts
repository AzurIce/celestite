import type {
  PackageResourceProvider,
  PreviewTask,
} from "../editor/preview/contract";
import { VaultError, type VaultErrorCode } from "./errors";
import { vaultPath, type VaultPath } from "./path";
import type {
  ChangeHint,
  Entry,
  EntryStat,
  VaultBackend,
  WriteFileOptions,
} from "./types";

export interface RemoteVaultDescriptor {
  protocol: "celestite-vault";
  version: 1;
  shareId: string;
  name: string;
  readOnly: boolean;
  previewResourceRoot?: string;
  vaultIdentity?: { id: string; historyId: string };
  capabilities: {
    watch: boolean;
    conditionalWrite: boolean;
    documentEditing?: boolean;
    websocketSync?: boolean;
  };
}
export function normalizeVaultUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new VaultError("InvalidPath", "请输入完整的 Vault URL。");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  ) {
    throw new VaultError(
      "InvalidPath",
      "Vault URL 必须为 HTTP(S) 地址，不包含密码、查询参数或片段。",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  const key = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  const random = key.startsWith("ro-") ? key.slice(3) : key;
  if (!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(random))
    throw new VaultError("InvalidPath", "请输入宿主生成的完整分享链接。");
  return url.href;
}
const codes = new Set<VaultErrorCode>([
  "InvalidPath",
  "NotFound",
  "AlreadyExists",
  "NotDirectory",
  "NotFile",
  "DirectoryNotEmpty",
  "PermissionDenied",
  "QuotaExceeded",
  "Busy",
  "Unsupported",
  "Closed",
  "Conflict",
  "IO",
]);
async function responseError(response: Response): Promise<VaultError> {
  const raw = await response.json().catch(() => null);
  const code = codes.has(raw?.code)
    ? (raw.code as VaultErrorCode)
    : response.status === 401 || response.status === 403
      ? "PermissionDenied"
      : "IO";
  return new VaultError(
    code,
    typeof raw?.message === "string"
      ? raw.message
      : `Server returned HTTP ${response.status}`,
    raw?.path,
  );
}

export async function openHttpVault(value: string) {
  const backend = new HttpVaultBackend(normalizeVaultUrl(value));
  try {
    const descriptor = await backend.describe();
    return { backend, descriptor };
  } catch (error) {
    await backend.close();
    throw error;
  }
}

export class HttpVaultBackend implements VaultBackend {
  private closed = false;
  private closing?: Promise<void>;
  private pending = new Set<Promise<unknown>>();
  private revisions = new Map<VaultPath, string>();
  private listeners = new Set<(hint: ChangeHint) => void>();
  private watcher?: AbortController;
  constructor(readonly url: string) {}
  documentRequest<T>(route: string, body?: unknown): Promise<T> {
    return this.run(async () => {
      const response = await this.request(
        route,
        {},
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      return response.json() as Promise<T>;
    });
  }
  packageResources(
    descriptor: RemoteVaultDescriptor,
  ): PackageResourceProvider | undefined {
    if (!descriptor.previewResourceRoot) return;
    const context = (task: PreviewTask) => {
      const overlays: Record<string, string> = {};
      for (const [path, resource] of Object.entries(task.resources))
        if (
          (path === "Notist.toml" || path.endsWith("/Notist.toml")) &&
          resource.data
        )
          overlays[path] = new TextDecoder().decode(
            new Uint8Array(resource.data),
          );
      for (const [path, source] of Object.entries(task.overlays))
        if (path === "Notist.toml" || path.endsWith("/Notist.toml"))
          overlays[path] = source;
      return { documentPath: task.ticket.path, overlays };
    };
    return {
      root: descriptor.previewResourceRoot,
      read: (request, task) =>
        this.documentRequest("/preview/resources", {
          context: context(task),
          request,
        }),
      readDir: (path, task) =>
        this.documentRequest("/preview/directory", {
          context: context(task),
          path,
        }),
    };
  }
  private async request(
    route: string,
    query: Record<string, string> = {},
    init: RequestInit = {},
  ) {
    const url = new URL(this.url + "/api/v1" + route);
    url.search = new URLSearchParams(query).toString();
    const headers = new Headers(init.headers);
    try {
      const response = await fetch(url, {
        ...init,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw await responseError(response);
      return response;
    } catch (error) {
      if (error instanceof VaultError) throw error;
      // Blob Workers retain the HTTPS page's origin. Let browsers decide local
      // network exceptions; add guidance only after a request actually fails.
      const transportHelp =
        globalThis.location?.origin.startsWith("https://") &&
        url.protocol === "http:"
          ? " 当前页面使用 HTTPS，HTTP 连接可能被浏览器阻止，请检查浏览器提示，或改用 HTTPS 分享链接。"
          : "";
      throw new VaultError(
        "IO",
        (init.method && init.method !== "GET" && !route.startsWith("/preview/")
          ? "远端请求未完成，写操作可能已提交，请刷新核对后再重试。"
          : "远端请求未完成，请检查连接。") + transportHelp,
        undefined,
        error,
      );
    }
  }
  private run<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new VaultError("Closed", "Vault is closed"));
    const promise = task().catch((error) => {
      if (error instanceof VaultError) throw error;
      throw new VaultError(
        "IO",
        "远端响应未能读取，请检查连接。",
        undefined,
        error,
      );
    });
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  describe(): Promise<RemoteVaultDescriptor> {
    return this.run(async () => {
      const raw = await (await this.request("")).json();
      if (
        raw.protocol !== "celestite-vault" ||
        raw.version !== 1 ||
        typeof raw.shareId !== "string" ||
        !raw.shareId ||
        typeof raw.vaultIdentity?.id !== "string" ||
        typeof raw.vaultIdentity?.historyId !== "string" ||
        typeof raw.name !== "string" ||
        !raw.name.trim() ||
        typeof raw.readOnly !== "boolean" ||
        raw.capabilities?.conditionalWrite !== true ||
        typeof raw.capabilities?.watch !== "boolean"
      ) {
        throw new VaultError("Unsupported", "远端 Vault 协议不兼容。");
      }
      return raw as RemoteVaultDescriptor;
    });
  }
  async *readDir(path: VaultPath): AsyncIterable<Entry> {
    const entries = await this.run(
      async () =>
        (
          await this.request("/directory", { path: vaultPath(path) })
        ).json() as Promise<Entry[]>,
    );
    if (!Array.isArray(entries))
      throw new VaultError("IO", "Invalid directory response", path);
    for (const entry of entries) {
      if (this.closed) throw new VaultError("Closed", "Vault is closed");
      vaultPath(entry.path);
      const parent = entry.path.includes("/")
        ? entry.path.slice(0, entry.path.lastIndexOf("/"))
        : "";
      if (
        entry.path === path ||
        parent !== path ||
        !["file", "directory", "symlink", "other"].includes(entry.kind)
      )
        throw new VaultError("IO", "Invalid directory entry", path);
      yield entry;
    }
  }
  stat(path: VaultPath): Promise<EntryStat | null> {
    return this.run(async () => {
      const result = await (
        await this.request("/stat", { path: vaultPath(path) })
      ).json();
      if (
        result !== null &&
        (result.path !== path ||
          !["file", "directory", "symlink", "other"].includes(result.kind))
      )
        throw new VaultError("IO", "Invalid stat response", path);
      return result;
    });
  }
  private async read(path: VaultPath) {
    const response = await this.request("/file", { path: vaultPath(path) });
    const revision = response.headers.get("ETag");
    if (!revision)
      throw new VaultError(
        "Unsupported",
        "Server did not return a file revision",
        path,
      );
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.revisions.set(path, revision);
    return { data: bytes, revision };
  }
  readFile(path: VaultPath): Promise<Uint8Array> {
    return this.run(async () => (await this.read(path)).data);
  }
  readFileSnapshot(path: VaultPath) {
    return this.run(() => this.read(path));
  }
  writeFile(
    path: VaultPath,
    data: Uint8Array,
    options: WriteFileOptions,
  ): Promise<string> {
    vaultPath(path);
    const bytes = data.slice();
    return this.run(async () => {
      if (
        options.mode === "replace" &&
        !options.expectedRevision &&
        !this.revisions.has(path)
      )
        await this.read(path);
      const response = await this.request(
        "/file",
        { path, mode: options.mode },
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            ...(options.mode === "replace"
              ? {
                  "If-Match":
                    options.expectedRevision ?? this.revisions.get(path)!,
                }
              : {}),
          },
          body: bytes.buffer,
        },
      );
      const revision = response.headers.get("ETag");
      if (!revision)
        throw new VaultError(
          "IO",
          "文件可能已提交，但服务器未返回保存版本，请核对远端内容。",
          path,
        );
      this.revisions.set(path, revision);
      return revision;
    });
  }
  mkdir(path: VaultPath, options?: { recursive?: boolean }): Promise<void> {
    return this.run(async () => {
      await this.request(
        "/directory",
        { path: vaultPath(path), recursive: String(!!options?.recursive) },
        { method: "POST" },
      );
    });
  }
  remove(path: VaultPath, options?: { recursive?: boolean }): Promise<void> {
    return this.run(async () => {
      await this.request(
        "/entry",
        { path: vaultPath(path), recursive: String(!!options?.recursive) },
        { method: "DELETE" },
      );
      this.forget(path);
    });
  }
  rename(from: VaultPath, to: VaultPath): Promise<void> {
    return this.run(async () => {
      await this.request(
        "/rename",
        {},
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: vaultPath(from), to: vaultPath(to) }),
        },
      );
      const revisions = [...this.revisions].filter(
        ([path]) => path === from || path.startsWith(from + "/"),
      );
      this.forget(from);
      this.forget(to);
      for (const [path, revision] of revisions)
        this.revisions.set(vaultPath(to + path.slice(from.length)), revision);
    });
  }
  private forget(parent: VaultPath) {
    for (const path of this.revisions.keys())
      if (path === parent || path.startsWith(parent + "/"))
        this.revisions.delete(path);
  }
  async watch(listener: (hint: ChangeHint) => void): Promise<() => void> {
    if (this.closed) throw new VaultError("Closed", "Vault is closed");
    this.listeners.add(listener);
    this.startWatcher();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.watcher?.abort();
        this.watcher = undefined;
      }
    };
  }
  private startWatcher() {
    if (this.closed || !this.listeners.size || this.watcher) return;
    const controller = new AbortController();
    this.watcher = controller;
    void this.watchLoop(controller).catch(() => {
      /* Close and unsubscribe abort the stream. */
    });
  }
  private emit(hint: ChangeHint) {
    for (const listener of this.listeners) listener(hint);
  }
  private async watchLoop(controller: AbortController) {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(this.url + "/api/v1/events", {
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw await responseError(response);
        if (!response.body) throw new Error("Missing event stream");
        this.emit({ paths: [vaultPath("")], recursive: true });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        try {
          while (!controller.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            pending += decoder
              .decode(value, { stream: true })
              .replace(/\r\n/g, "\n");
            let end: number;
            while ((end = pending.indexOf("\n\n")) >= 0) {
              const frame = pending.slice(0, end);
              pending = pending.slice(end + 2);
              const data = frame
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (!data) continue;
              const hint = JSON.parse(data);
              if (
                !Array.isArray(hint.paths) ||
                typeof hint.recursive !== "boolean"
              )
                throw new Error("Invalid event");
              this.emit({
                paths: hint.paths.map(vaultPath),
                recursive: hint.recursive,
              });
            }
            if (pending.length > 1024 * 1024)
              throw new Error("Event frame too large");
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      } catch {
        if (controller.signal.aborted) break;
      }
      if (!controller.signal.aborted)
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 2000);
          controller.signal.addEventListener("abort", done, { once: true });
        });
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.watcher?.abort();
    this.listeners.clear();
    return (this.closing = Promise.allSettled([...this.pending]).then(
      () => {},
    ));
  }
}
