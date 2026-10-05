/** Stable framing includes logical names, lengths and bytes. */
export async function assetDigest(files: { path: string; data: Uint8Array }[]) {
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const names = sorted.map((file) => new TextEncoder().encode(file.path));
  const size = sorted.reduce(
    (sum, file, index) =>
      sum + file.data.byteLength + names[index].byteLength + 8,
    0,
  );
  const buffer = new Uint8Array(size);
  const lengths = new DataView(buffer.buffer);
  let offset = 0;
  sorted.forEach(({ data }, index) => {
    const name = names[index];
    lengths.setUint32(offset, name.byteLength);
    lengths.setUint32(offset + 4, data.byteLength);
    offset += 8;
    buffer.set(name, offset);
    offset += name.byteLength;
    buffer.set(data, offset);
    offset += data.byteLength;
  });
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
