import { absoluteResourcePath } from "./path";
import { VaultError } from "../vault/errors";
import { vaultPath } from "../vault/path";
import type { VaultBackend } from "../vault/types";
import type {
  PreviewAssets,
  PreviewComponent,
  PreviewResource,
  PreviewResourceRequest,
  PreviewTask,
  PackageResourceProvider,
} from "./contract";

import { assetDigest } from "./asset-digest";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 2048;

/** Reads immutable task inputs directly from IO; never uses editor download/save. */
export class PreviewResources {
  constructor(
    private backend: VaultBackend,
    private packages?: PackageResourceProvider,
  ) {}
  get root() {
    return this.packages?.root ?? "/vault";
  }
  setPackages(packages: PackageResourceProvider) {
    this.packages = packages;
  }
  private async *entries(
    path: string,
    task: PreviewTask,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (absoluteResourcePath(path)) {
      if (!this.packages)
        throw new Error("此存储后端没有外部 package 资源通道。");
      for (const entry of await this.packages.readDir(path, task)) {
        signal?.throwIfAborted();
        yield entry;
      }
    } else {
      for await (const entry of this.backend.readDir(vaultPath(path))) {
        signal?.throwIfAborted();
        yield entry;
        signal?.throwIfAborted();
      }
    }
  }
  async read(
    request: PreviewResourceRequest,
    task: PreviewTask,
    signal?: AbortSignal,
  ): Promise<PreviewResource> {
    try {
      signal?.throwIfAborted();
      if (absoluteResourcePath(request.path)) {
        if (!this.packages)
          throw new Error("此存储后端没有外部 package 资源通道。");
        const resource = await this.packages.read(request, task);
        signal?.throwIfAborted();
        return resource;
      }
      const path = vaultPath(request.path);
      const stat = await this.backend.stat(path);
      signal?.throwIfAborted();
      if (!stat) return { kind: null, data: null, error: null };
      if (stat.kind !== "file" && stat.kind !== "directory")
        throw new Error("预览资源必须是普通文件或目录。");
      if (!request.read || stat.kind === "directory")
        return { kind: stat.kind, data: null, error: null };
      if ((stat.size ?? 0) > MAX_FILE_BYTES)
        throw new Error("预览资源超过 16 MiB。");
      const data = (await this.backend.readFileSnapshot(path)).data;
      signal?.throwIfAborted();
      if (data.byteLength > MAX_FILE_BYTES)
        throw new Error("预览资源超过 16 MiB。");
      return { kind: "file", data: Array.from(data), error: null };
    } catch (error) {
      signal?.throwIfAborted();
      return {
        kind: null,
        data: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  async assets(
    task: PreviewTask,
    components: PreviewComponent[],
    signal?: AbortSignal,
  ): Promise<PreviewAssets> {
    signal?.throwIfAborted();
    const roots = [
      ...new Set(
        components.map((component) =>
          component.packageRoot
            ? `${component.packageRoot}/components`
            : "components",
        ),
      ),
    ];
    const files = new Map<string, Uint8Array>();
    let bytes = 0;
    const insert = (path: string, data: Uint8Array) => {
      if (files.has(path)) return;
      bytes += data.byteLength;
      if (bytes > MAX_ASSET_BYTES || files.size >= MAX_FILES)
        throw new Error("组件资源超过容量，请缩小 package。");
      files.set(path, data);
    };
    for (const root of roots) {
      const pending = [root];
      const visited = new Set<string>();
      while (pending.length) {
        signal?.throwIfAborted();
        const directory = pending.pop()!;
        if (visited.has(directory)) continue;
        visited.add(directory);
        if (visited.size > MAX_FILES) throw new Error("组件目录超过容量。");
        try {
          for await (const entry of this.entries(directory, task, signal)) {
            signal?.throwIfAborted();
            // Backend entries must remain in the requested subtree.
            if (!entry.path.startsWith(directory + "/"))
              throw new Error("组件资源路径越界。");
            if (entry.kind === "directory") pending.push(entry.path);
            else if (entry.kind === "file") {
              const overlay = task.overlays?.[entry.path];
              if (overlay !== undefined)
                insert(entry.path, new TextEncoder().encode(overlay));
              else {
                const resource = await this.read(
                  {
                    path: entry.path,
                    read: true,
                  },
                  task,
                  signal,
                );
                if (resource.error || !resource.data)
                  throw new Error(
                    resource.error ?? `组件资源已消失：${entry.path}`,
                  );
                insert(entry.path, new Uint8Array(resource.data));
              }
            } else throw new Error("组件资源必须是普通文件或目录。");
          }
        } catch (error) {
          if (!(error instanceof VaultError) || error.code !== "NotFound")
            throw error;
        }
      }
      for (const [path, source] of Object.entries(task.overlays ?? {}))
        if (path.startsWith(root + "/"))
          insert(path, new TextEncoder().encode(source));
    }
    for (const component of components)
      if (!files.has(component.path))
        throw new Error(`找不到组件入口：${component.path}`);
    const entries = [...files].map(([path, data]) => ({ path, data }));
    const digest = await assetDigest(entries);
    signal?.throwIfAborted();
    return { digest, files: entries };
  }
}
