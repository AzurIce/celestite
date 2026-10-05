import { VaultError } from "../../vault/errors";
import { vaultPath } from "../../vault/path";
import type { VaultBackend } from "../../vault/types";
import { OpfsInstanceStore } from "./store";
import { encodeError } from "../rpc";

/** Browser primitives for the Rust Backend. No editing or recovery policy here. */
export function createOpfsIo(store: OpfsInstanceStore, backend: VaultBackend) {
  return (request: string): string | Promise<string> => {
    const { method, params: p } = JSON.parse(request);
    if (method === "newId") return crypto.randomUUID();
    const execute = async () => {
      switch (method) {
        case "readJson":
          return store.json(p.path);
        case "writeJson":
          return store.putJson(p.path, p.data);
        case "readHistory": {
          const data = await store.bytes(p.path);
          return data ? Array.from(data) : null;
        }
        case "writeHistory":
          return store.put(p.path, new Uint8Array(p.data));
        case "stat":
          return backend.stat(vaultPath(p.path));
        case "readDir": {
          const entries = [];
          for await (const entry of backend.readDir(vaultPath(p.path)))
            entries.push(entry);
          return entries;
        }
        case "readFile": {
          const path = vaultPath(p.path);
          if (p.limit !== null) {
            const stat = await backend.stat(path);
            if (stat?.size !== undefined && stat.size > p.limit)
              throw new VaultError(
                "Unsupported",
                "文件超过 5 MiB，请通过文件树下载后编辑。",
                path,
              );
          }
          const file = await backend.readFileSnapshot!(path);
          if (p.limit !== null && file.data.byteLength > p.limit)
            throw new VaultError(
              "Unsupported",
              "文件超过 5 MiB，请通过文件树下载后编辑。",
              path,
            );
          return { data: Array.from(file.data), revision: file.revision };
        }
        case "writeFile":
          return backend.writeFile(vaultPath(p.path), new Uint8Array(p.data), {
            mode: p.mode,
            ...(p.expected !== null ? { expectedRevision: p.expected } : {}),
          });
        case "mkdir":
          return backend.mkdir(vaultPath(p.path), { recursive: p.recursive });
        case "rename":
          return backend.rename(vaultPath(p.from), vaultPath(p.to));
        case "remove":
          return backend.remove(vaultPath(p.path), { recursive: p.recursive });
        default:
          throw new VaultError("Unsupported", `未知 OPFS 操作：${method}`);
      }
    };
    return execute().then(
      (result) => JSON.stringify({ result: result ?? null }),
      (error) => JSON.stringify({ error: encodeError(error) }),
    );
  };
}
