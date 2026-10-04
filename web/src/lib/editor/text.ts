import type { DocumentSnapshot } from "./documents";

export const MAX_EDITABLE_BYTES = 5 * 1024 * 1024;

export function decodeText(bytes: Uint8Array) {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(
    bom ? bytes.subarray(3) : bytes,
  );
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw))
    throw new Error("Binary file");
  const lineEnding = (raw.match(/\r\n|\r|\n/)?.[0] ??
    "\n") as DocumentSnapshot["lineEnding"];
  return { content: raw.replace(/\r\n?|\n/g, "\n"), bom, lineEnding };
}
export function encodeText(
  document: Pick<DocumentSnapshot, "content" | "bom" | "lineEnding">,
) {
  return new TextEncoder().encode(
    (document.bom ? "\ufeff" : "") +
      document.content.replace(/\n/g, document.lineEnding),
  );
}
