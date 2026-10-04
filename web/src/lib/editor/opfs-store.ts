import { VaultError, opfsError } from "../vault/errors";
import { vaultPath } from "../vault/path";
import type { InstanceIdentity } from "./contract";

/** Private state is outside /vaults/<id>; file tree never sees CRDT internals. */
export class OpfsInstanceStore {
  private constructor(
    private root: FileSystemDirectoryHandle,
    readonly identity: InstanceIdentity,
  ) {}
  static async open(id = "default") {
    const opfs = await navigator.storage.getDirectory();
    const instances = await opfs.getDirectoryHandle("editor-instances", {
      create: true,
    });
    const root = await instances.getDirectoryHandle(id, { create: true });
    type Profile = { schema: number; identity: InstanceIdentity };
    const readProfile = async (name: string): Promise<Profile | null> => {
      try {
        const file = await root.getFileHandle(name);
        const text = await (await file.getFile()).text();
        // Empty files can exist when the first create was interrupted before close.
        if (!text) return null;
        const profile = JSON.parse(text) as Profile;
        if (
          profile.schema !== 1 ||
          typeof profile.identity?.instanceId !== "string" ||
          !profile.identity.instanceId ||
          typeof profile.identity.vault?.vaultId !== "string" ||
          !profile.identity.vault.vaultId ||
          typeof profile.identity.vault.historyId !== "string" ||
          !profile.identity.vault.historyId
        )
          throw new VaultError("IO", "实例身份记录无效，未覆盖已有数据。");
        return profile;
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError")
          return null;
        throw error;
      }
    };
    let profile = await readProfile("profile.json");
    if (!profile) {
      profile = await readProfile("profile-intent.json");
      if (!profile) {
        try {
          const catalog = await root.getFileHandle("catalog.json");
          if ((await catalog.getFile()).size)
            throw new VaultError(
              "IO",
              "已有文档历史但缺少实例身份，未重建身份。",
            );
        } catch (error) {
          if (!(
            error instanceof DOMException && error.name === "NotFoundError"
          ))
            throw error;
        }
        profile = {
          schema: 1,
          identity: {
            instanceId: crypto.randomUUID(),
            vault: {
              vaultId: crypto.randomUUID(),
              historyId: crypto.randomUUID(),
            },
          },
        };
        // Publish the seed before creating the authoritative profile file.
        await write(
          await root.getFileHandle("profile-intent.json", { create: true }),
          new TextEncoder().encode(JSON.stringify(profile)),
        );
      }
      await write(
        await root.getFileHandle("profile.json", { create: true }),
        new TextEncoder().encode(JSON.stringify(profile)),
      );
    }
    return new OpfsInstanceStore(root, profile.identity);
  }
  async bytes(path: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(
        await (await (await this.file(path, false)).getFile()).arrayBuffer(),
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError")
        return null;
      throw opfsError(error, "readHistory", path);
    }
  }
  async json<T>(path: string): Promise<T | null> {
    const data = await this.bytes(path);
    return data?.byteLength
      ? (JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(data),
        ) as T)
      : null;
  }
  async put(path: string, data: Uint8Array) {
    try {
      await write(await this.file(path, true), data);
    } catch (error) {
      throw opfsError(error, "commitHistory", path);
    }
  }
  async putJson(path: string, value: unknown) {
    await this.put(path, new TextEncoder().encode(JSON.stringify(value)));
  }
  private async file(path: string, create: boolean) {
    const parts = vaultPath(path).split("/");
    let directory = this.root;
    for (const part of parts.slice(0, -1))
      directory = await directory.getDirectoryHandle(part, { create });
    return directory.getFileHandle(parts[parts.length - 1]!, { create });
  }
}
async function write(file: FileSystemFileHandle, data: Uint8Array) {
  const stream = await file.createWritable();
  try {
    await stream.write(new Uint8Array(data));
    await stream.close();
  } catch (error) {
    await stream.abort().catch(() => {});
    throw error;
  }
}
