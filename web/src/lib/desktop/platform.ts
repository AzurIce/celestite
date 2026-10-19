import { invoke } from "@tauri-apps/api/core";
import { decodeError } from "../editor/rpc";
import type { RpcError } from "../editor/contract";

export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
export type DesktopInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/** IPC errors use the same structured contract as the browser editor service. */
export const desktopInvoke: DesktopInvoke = async (command, args) => {
  try {
    return await invoke(command, args);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      "message" in error
    )
      throw decodeError(error as RpcError);
    throw error instanceof Error ? error : new Error(String(error));
  }
};

/** Desktop custom schemes are never a useful base for protocol-relative web links. */
export function nativeExternalUrl(url: string): string {
  return new URL(url.startsWith("//") ? `https:${url}` : url).href;
}
