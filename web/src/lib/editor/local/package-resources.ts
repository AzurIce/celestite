import type {
  PackageResourceProvider,
  PreviewResourceRequest,
} from "../../preview/contract";
import type { LocalDirectoryHandle } from "../../vault/file-system-access";
import { fileSystemError, VaultError } from "../../vault/errors";
import { vaultPath } from "../../vault/path";

const SCOPE_ROOT = "/workspace";
const MAX_FILE_BYTES = 16 * 1024 * 1024;

function resourceError(error: unknown, path: string) {
  if (!(error instanceof DOMException)) return error;
  if (error.name === "NotAllowedError" || error.name === "SecurityError")
    return new VaultError(
      "PermissionDenied",
      "依赖目录读取权限已失效，请重新授权。",
      path,
      error,
    );
  return fileSystemError(error, "读取依赖资源", path);
}

/** A read-only capability. Editable paths continue to use the original Vault handle. */
export class DirectoryPackageResources implements PackageResourceProvider {
  private constructor(
    private scope: LocalDirectoryHandle,
    readonly root: string,
  ) {}

  static async open(
    scope: LocalDirectoryHandle,
    vault: FileSystemDirectoryHandle,
  ) {
    if ((await scope.queryPermission({ mode: "read" })) !== "granted")
      throw new VaultError(
        "PermissionDenied",
        "依赖目录需要读取权限，请重新授权。",
      );
    const relative = await scope.resolve(vault);
    if (relative === null)
      throw new VaultError("InvalidPath", "请选择包含当前 Vault 的目录。");
    const path = vaultPath(relative.join("/"));
    return new DirectoryPackageResources(
      scope,
      path ? `${SCOPE_ROOT}/${path}` : SCOPE_ROOT,
    );
  }

  private relative(path: string) {
    if (path !== SCOPE_ROOT && !path.startsWith(SCOPE_ROOT + "/"))
      throw new VaultError(
        "PermissionDenied",
        "资源路径超出已授权目录，请选择更大范围目录或使用相对依赖路径。",
        path,
      );
    return vaultPath(
      path === SCOPE_ROOT ? "" : path.slice(SCOPE_ROOT.length + 1),
    );
  }
  private async directory(parts: string[]) {
    let handle: FileSystemDirectoryHandle = this.scope;
    for (const part of parts) handle = await handle.getDirectoryHandle(part);
    return handle;
  }
  async read(request: PreviewResourceRequest) {
    const path = this.relative(request.path);
    try {
      if (!path) return { kind: "directory" as const, data: null, error: null };
      const parts = path.split("/");
      const name = parts.pop()!;
      const parent = await this.directory(parts);
      try {
        await parent.getDirectoryHandle(name);
        return { kind: "directory" as const, data: null, error: null };
      } catch (error) {
        if (
          !(error instanceof DOMException) ||
          error.name !== "TypeMismatchError"
        )
          throw error;
      }
      const handle = await parent.getFileHandle(name);
      if (!request.read)
        return { kind: "file" as const, data: null, error: null };
      const file = await handle.getFile();
      if (file.size > MAX_FILE_BYTES) throw new Error("预览资源超过 16 MiB。");
      return {
        kind: "file" as const,
        data: Array.from(new Uint8Array(await file.arrayBuffer())),
        error: null,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError")
        return { kind: null, data: null, error: null };
      throw resourceError(error, request.path);
    }
  }
  async readDir(path: string) {
    const relative = this.relative(path);
    try {
      const directory = await this.directory(
        relative ? relative.split("/") : [],
      );
      const entries: { path: string; kind: string }[] = [];
      for await (const [name, handle] of directory.entries()) {
        vaultPath(name);
        entries.push({ path: `${path}/${name}`, kind: handle.kind });
      }
      return entries;
    } catch (error) {
      throw resourceError(error, path);
    }
  }
}
