export type VaultErrorCode =
  | "InvalidPath"
  | "InvalidEdit"
  | "StaleVersion"
  | "NotFound"
  | "AlreadyExists"
  | "NotDirectory"
  | "NotFile"
  | "DirectoryNotEmpty"
  | "PermissionDenied"
  | "QuotaExceeded"
  | "Busy"
  | "FilesystemDiffTimeout"
  | "FilesystemReconciliationPending"
  | "Unsupported"
  | "Closed"
  | "Conflict"
  | "IO";

export class VaultError extends Error {
  readonly name = "VaultError";

  constructor(
    readonly code: VaultErrorCode,
    message: string,
    readonly path?: string,
    readonly cause?: unknown,
    /** Platform proof that a failed write never changed the projected file. */
    readonly writeNotStarted = false,
  ) {
    super(message);
  }
}

export type RenamePhase = "copy" | "remove-source";

/** 移动已开始后的失败；源删除阶段可能部分完成，完整目标必须保留。 */
export class VaultRenameError extends VaultError {
  /** true 表示复制全部完成；false 表示目标完整性尚未确认。 */
  readonly targetComplete: boolean;

  constructor(
    error: VaultError,
    readonly from: string,
    readonly to: string,
    readonly phase: RenamePhase,
    readonly cleanupError?: VaultError,
  ) {
    super(
      error.code,
      `rename failed during ${phase}: ${from} -> ${to}`,
      from,
      error,
    );
    this.targetComplete = phase === "remove-source";
  }
}

export function isDomError(error: unknown, name: string): boolean {
  return error instanceof DOMException && error.name === name;
}

/** 平台错误保留在 cause 中；业务层只需处理统一的 code。 */
export function opfsError(
  error: unknown,
  operation: string,
  path?: string,
): VaultError {
  if (error instanceof VaultError) return error;

  let code: VaultErrorCode = "IO";
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotFoundError":
        code = "NotFound";
        break;
      case "NotAllowedError":
      case "SecurityError":
        code = "PermissionDenied";
        break;
      case "QuotaExceededError":
        code = "QuotaExceeded";
        break;
      case "NoModificationAllowedError":
        code = "Busy";
        break;
      case "NotSupportedError":
        code = "Unsupported";
        break;
      case "InvalidModificationError":
        if (operation === "remove") code = "DirectoryNotEmpty";
        break;
    }
  } else if (error instanceof TypeError) {
    // 路径已做结构校验；这里通常是浏览器拒绝条目名称。
    code = "InvalidPath";
  }

  return new VaultError(
    code,
    `${operation} failed${path ? `: ${path}` : ""}`,
    path,
    error,
  );
}
