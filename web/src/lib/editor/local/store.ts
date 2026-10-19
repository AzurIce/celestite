import { VaultError } from "../../vault/errors";
import { DirectoryHandleVaultBackend } from "../../vault/directory-handle";
import type { VaultBackend } from "../../vault/types";
import type { InstanceIdentity } from "../contract";

/** Private text recovery is outside /vaults/<id>; its format belongs to Rust. */
export class OpfsInstanceStore {
  private constructor(
    readonly files: VaultBackend,
    readonly identity: InstanceIdentity,
  ) {}
  static async open(id = "default") {
    const opfs = await navigator.storage.getDirectory();
    const instances = await opfs.getDirectoryHandle("editor-instances", {
      create: true,
    });
    const root = await instances.getDirectoryHandle(id, { create: true });
    type Profile = { schema: 2; instanceId: string; vaultId: string };
    let publishProfile = false;
    const readProfile = async (name: string): Promise<Profile | null> => {
      try {
        const file = await root.getFileHandle(name);
        const text = await (await file.getFile()).text();
        // Empty files can exist when the first create was interrupted before close.
        if (!text) return null;
        const value = JSON.parse(text);
        if (value.schema === 1) publishProfile = true;
        const profile =
          value.schema === 1
            ? {
                schema: 2 as const,
                instanceId: value.identity?.instanceId,
                vaultId: value.identity?.vault?.vaultId,
              }
            : value;
        if (
          profile.schema !== 2 ||
          typeof profile.instanceId !== "string" ||
          !profile.instanceId ||
          typeof profile.vaultId !== "string" ||
          !profile.vaultId
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
      publishProfile = true;
      profile = await readProfile("profile-intent.json");
      if (!profile) {
        for await (const [name] of root.entries()) {
          if (name !== "profile.json" && name !== "profile-intent.json")
            throw new VaultError(
              "IO",
              "已有恢复数据但缺少实例身份，未重建身份。",
            );
        }
        profile = {
          schema: 2,
          instanceId: crypto.randomUUID(),
          vaultId: crypto.randomUUID(),
        };
        // Publish the seed before creating the authoritative profile file.
        await write(
          await root.getFileHandle("profile-intent.json", { create: true }),
          new TextEncoder().encode(JSON.stringify(profile)),
        );
      }
    }
    if (publishProfile)
      await write(
        await root.getFileHandle("profile.json", { create: true }),
        new TextEncoder().encode(JSON.stringify(profile)),
      );
    return new OpfsInstanceStore(
      new DirectoryHandleVaultBackend(
        root,
        navigator.locks,
        `celestite.editor.recovery:${id}`,
      ),
      {
        instanceId: profile.instanceId,
        vault: { vaultId: profile.vaultId, historyId: crypto.randomUUID() },
      },
    );
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
