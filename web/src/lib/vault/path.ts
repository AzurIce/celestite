import { VaultError } from "./errors";

declare const vaultPathBrand: unique symbol;

/** 经校验的相对路径。空字符串表示根，分隔符固定为 /。 */
export type VaultPath = string & { readonly [vaultPathBrand]: true };

export const ROOT_PATH = "" as VaultPath;

/** 不静默折叠 .、.. 或重复分隔符，避免含糊的路径与越界访问。 */
export function vaultPath(value: string): VaultPath {
  if (
    typeof value !== "string" ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[a-zA-Z]:/.test(value) ||
    (value !== "" && value.split("/").some((part) => part === "" || part === "." || part === ".."))
  ) {
    throw new VaultError("InvalidPath", "Expected a Vault-relative path", value);
  }
  return value as VaultPath;
}

export function childPath(parent: VaultPath, name: string): VaultPath {
  if (name.includes("/") || name === "") {
    throw new VaultError("InvalidPath", "Expected a single entry name", name);
  }
  return vaultPath(parent ? `${parent}/${name}` : name);
}

export function splitPath(path: VaultPath): { parent: VaultPath; name: string } {
  vaultPath(path);
  if (path === ROOT_PATH) {
    throw new VaultError("InvalidPath", "This operation requires a non-root path", path);
  }
  const separator = path.lastIndexOf("/");
  return {
    parent: vaultPath(separator < 0 ? "" : path.slice(0, separator)),
    name: path.slice(separator + 1),
  };
}
