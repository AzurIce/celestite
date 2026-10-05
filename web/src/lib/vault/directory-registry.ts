import { VaultError } from "./errors";
import type { LocalDirectoryHandle } from "./file-system-access";

export interface DirectoryConnection {
  id: string;
  name: string;
  handle: LocalDirectoryHandle;
}
export interface DirectoryRegistry {
  list(): Promise<DirectoryConnection[]>;
  remember(handle: LocalDirectoryHandle): Promise<DirectoryConnection>;
  forget(id: string): Promise<void>;
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("目录记录事务已中止。"));
    transaction.onerror = () => reject(transaction.error);
  });
}

/** Handles require structured cloning; JSON connection records cannot store them. */
export class IndexedDbDirectoryRegistry implements DirectoryRegistry {
  private async database() {
    const request = indexedDB.open("celestite-local-directories", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("directories", { keyPath: "id" });
    const database = await result(request);
    database.onversionchange = () => database.close();
    return database;
  }
  async list(): Promise<DirectoryConnection[]> {
    const database = await this.database();
    try {
      const transaction = database.transaction("directories", "readonly");
      const done = committed(transaction);
      const [records] = await Promise.all([
        result<DirectoryConnection[]>(
          transaction.objectStore("directories").getAll(),
        ),
        done,
      ]);
      for (const record of records)
        if (
          !/^directory:[0-9a-f-]{36}$/.test(record.id) ||
          typeof record.name !== "string" ||
          record.handle?.kind !== "directory"
        )
          throw new VaultError("IO", "本机目录记录无效，未覆盖已有数据。");
      return records;
    } finally {
      database.close();
    }
  }
  async remember(handle: LocalDirectoryHandle): Promise<DirectoryConnection> {
    return navigator.locks.request("celestite.local-directories", async () => {
      // isSameEntry is asynchronous, so comparison happens outside an IDB transaction.
      const records = await this.list();
      let record: DirectoryConnection | undefined;
      for (const candidate of records) {
        if (await candidate.handle.isSameEntry(handle)) {
          record = candidate;
          break;
        }
      }
      record = {
        id: record?.id ?? `directory:${crypto.randomUUID()}`,
        name: handle.name,
        handle,
      };
      await this.write((store) => store.put(record));
      return record;
    });
  }
  async forget(id: string) {
    await navigator.locks.request("celestite.local-directories", () =>
      this.write((store) => store.delete(id)),
    );
  }
  private async write(change: (store: IDBObjectStore) => IDBRequest) {
    const database = await this.database();
    try {
      const transaction = database.transaction("directories", "readwrite");
      const done = committed(transaction);
      change(transaction.objectStore("directories"));
      await done;
    } finally {
      database.close();
    }
  }
}
