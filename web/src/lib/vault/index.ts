export type {
  ChangeHint,
  Entry,
  EntryStat,
  VaultBackend,
  WriteFileOptions,
} from "./types";
export type { RenamePhase, VaultErrorCode } from "./errors";
export { VaultError, VaultRenameError } from "./errors";
export type { VaultPath } from "./path";
export { childPath, ROOT_PATH, vaultPath } from "./path";
export { openOpfsVault } from "./opfs";
export { openHttpVault, normalizeVaultUrl } from "./http";
