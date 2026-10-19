import { isDesktop, desktopInvoke } from "./desktop/platform";

/** Desktop saves use the system file dialog; browser downloads retain their normal behavior. */
export async function downloadBytes(
  name: string,
  data: Uint8Array,
  type = "application/octet-stream",
): Promise<void> {
  if (isDesktop()) {
    await desktopInvoke("desktop_export", { name, data: Array.from(data) });
    return;
  }
  const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
