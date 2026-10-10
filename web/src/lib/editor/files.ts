import { VaultError } from "../vault/errors";
import { vaultPath, type VaultPath } from "../vault/path";
import type {
  Entry,
  EntryStat,
  VaultBackend,
  WriteFileOptions,
} from "../vault/types";

export type FileMethod = Exclude<keyof VaultBackend, "watch" | "close">;

export interface FileParams {
  path?: VaultPath;
  from?: VaultPath;
  to?: VaultPath;
  data?: Uint8Array;
  options?: WriteFileOptions | { recursive?: boolean };
}

export const fileMutation = (method: string) =>
  ["writeFile", "mkdir", "rename", "remove"].includes(method);

export const fileAffectsText = (method: string) =>
  ["writeFile", "rename", "remove", "readFile"].includes(method);

/** One file capability facade. Its owner supplies ordering, locks and lifetime. */
export function fileBackend(
  invoke: (method: FileMethod, params: FileParams) => Promise<unknown>,
  watch: VaultBackend["watch"],
  close: VaultBackend["close"],
): VaultBackend {
  return {
    stat: (path) => invoke("stat", { path }) as Promise<EntryStat | null>,
    async *readDir(path) {
      yield* (await invoke("readDir", { path })) as Entry[];
    },
    readFile: (path) => invoke("readFile", { path }) as Promise<Uint8Array>,
    readFileSnapshot: (path) =>
      invoke("readFileSnapshot", { path }) as Promise<{
        data: Uint8Array;
        revision: string;
      }>,
    writeFile: (path, data, options) =>
      invoke("writeFile", { path, data, options }) as Promise<void | string>,
    mkdir: (path, options) =>
      invoke("mkdir", { path, options }) as Promise<void>,
    rename: (from, to) => invoke("rename", { from, to }) as Promise<void>,
    remove: (path, options) =>
      invoke("remove", { path, options }) as Promise<void>,
    watch,
    close,
  };
}

/** Dispatch only: persistence, confirmation and session policy belong to owner. */
export async function executeFile(
  backend: VaultBackend,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const path = vaultPath(String(params.path ?? params.from ?? ""));
  switch (method) {
    case "stat":
      return backend.stat(path);
    case "readDir": {
      const entries: Entry[] = [];
      for await (const entry of backend.readDir(path)) entries.push(entry);
      return entries;
    }
    case "readFile":
      return backend.readFile(path);
    case "readFileSnapshot":
      if (!backend.readFileSnapshot)
        throw new VaultError("Unsupported", "文件后端不提供版本化读取。", path);
      return backend.readFileSnapshot(path);
    case "writeFile":
      return backend.writeFile(
        path,
        params.data as Uint8Array,
        params.options as WriteFileOptions,
      );
    case "mkdir":
      return backend.mkdir(path, params.options as { recursive?: boolean });
    case "rename":
      return backend.rename(path, vaultPath(String(params.to)));
    case "remove":
      return backend.remove(path, params.options as { recursive?: boolean });
    default:
      throw new VaultError("Unsupported", "未知文件操作。", path);
  }
}
