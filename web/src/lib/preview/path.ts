import { convertFileSrc } from "@tauri-apps/api/core";

/** Package resource identities retain native roots; Vault paths remain relative. */
export function absoluteResourcePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\")
  );
}
export function previewModulePath(path: string): string {
  return absoluteResourcePath(path)
    ? `packages/${path.replace(/\\/g, "/").replace(/^\/+/, "")}`
    : `vault/${path}`;
}

/** convertFileSrc encodes a whole filename; ESM requires real directory separators. */
export function nativeComponentUrl(
  scope: string,
  digest: string,
  path: string,
  convert: typeof convertFileSrc = convertFileSrc,
): string {
  const origin = new URL("/", convert("", "celestite-preview"));
  return new URL(
    [scope, digest, ...previewModulePath(path).split("/")]
      .map(encodeURIComponent)
      .join("/"),
    origin,
  ).href;
}
