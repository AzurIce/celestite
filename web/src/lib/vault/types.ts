import type { VaultPath } from "./path";

export interface Entry {
  path: VaultPath;
  kind: "file" | "directory" | "symlink" | "other";
}

export interface EntryStat extends Entry {
  /** 文件的字节数；目录不要求提供。 */
  size?: number;
  /** Unix 毫秒时间戳；后端不支持时缺省。 */
  modifiedAt?: number;
}

export interface ChangeHint {
  paths: VaultPath[];
  recursive: boolean;
}

export interface WriteFileOptions {
  /** create 不覆盖已有条目；replace 要求文件已经存在。 */
  mode: "create" | "replace";
  /** Version-capable backends reject a replacement whose baseline has changed. */
  expectedRevision?: string;
}

/**
 * 绑定一个 Vault 根目录的文件后端。所有路径均为 Vault 内相对路径。
 * 多步骤操作不保证事务性，读目录也不保证一致性快照。
 * 上层负责缓存、业务变化事件、编辑缓冲区和自动保存。
 */
export interface VaultBackend {
  /** 仅列直接子项，不保证顺序，不读取正文或完整元数据。 */
  readDir(path: VaultPath): AsyncIterable<Entry>;
  /** 只有条目不存在时返回 null；其他错误抛出 VaultError。 */
  stat(path: VaultPath): Promise<EntryStat | null>;
  readFile(path: VaultPath): Promise<Uint8Array>;
  /** Bytes and version from one read, so unrelated reads cannot advance an editor's baseline. */
  readFileSnapshot?(
    path: VaultPath,
  ): Promise<{ data: Uint8Array; revision: string }>;
  /**
   * 保存调用时的完整内容，不隐式创建父目录。
   * 已有文件在提交前保留旧内容；成功不等于断电持久性保证。
   * 返回提交版本（如支持）；传入预期版本而后端不支持时应拒绝。
   */
  writeFile(
    path: VaultPath,
    data: Uint8Array,
    options: WriteFileOptions,
  ): Promise<void | string>;
  /** 默认只创建一级；recursive 可以部分完成，不提供回滚。 */
  mkdir(path: VaultPath, options?: { recursive?: boolean }): Promise<void>;
  /** 不允许删除 Vault 根；非空目录需要 recursive。 */
  remove(path: VaultPath, options?: { recursive?: boolean }): Promise<void>;
  /**
   * 在同一 Vault 内移动文件或目录，不覆盖目标，不隐式创建父目录。
   * 不允许移动根或将目录移入自身；同路径要求源存在。
   * 成功时目标完整且源已删除；多步骤实现不保证原子性或崩溃恢复。
   * 复制完整前不删除源；修改开始后的失败通过 VaultRenameError 报告阶段。
   */
  rename(from: VaultPath, to: VaultPath): Promise<void>;
  /**
   * 订阅外部变化提示，不保证完整、有序，也不保证后端会发出事件。
   * OPFS 不发出任何事件。返回可重复调用的取消订阅函数。
   */
  watch(listener: (hint: ChangeHint) => void): Promise<() => void>;
  /** 拒绝新操作，等待已经接收的操作结束；不删除持久化数据。 */
  close(): Promise<void>;
}
