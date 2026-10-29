import type {
  GitStatusEntry,
  GitStatusSnapshot,
} from "../editor/generated/celestite_core";
import type { VaultPath } from "../vault";

/** Optional read-only Git metadata supplied by a Vault host. */
export interface GitStatusSource {
  /** `null` means the Vault is not a worktree, or the host has no Git. */
  status(): Promise<GitStatusSnapshot | null>;
}

export type GitDisplayStatus =
  "added" | "untracked" | "modified" | "deleted" | "conflict";

export const GIT_STATUS_LABELS: Record<GitDisplayStatus, string> = {
  added: "已添加",
  untracked: "未跟踪",
  modified: "已修改",
  deleted: "已删除",
  conflict: "有冲突",
};

export interface GitStatusView {
  files: ReadonlyMap<VaultPath, GitDisplayStatus>;
  directories: ReadonlyMap<VaultPath, GitDisplayStatus>;
}

export const EMPTY_GIT_STATUS: GitStatusView = {
  files: new Map(),
  directories: new Map(),
};

const priority: Record<GitDisplayStatus, number> = {
  conflict: 4,
  deleted: 3,
  modified: 2,
  untracked: 1,
  added: 1,
};

/** A directory takes the highest-priority state among all descendants. */
function merge(
  map: Map<VaultPath, GitDisplayStatus>,
  path: VaultPath,
  status: GitDisplayStatus,
) {
  const current = map.get(path);
  if (!current || priority[status] > priority[current]) map.set(path, status);
}

function statusOf(entry: GitStatusEntry): GitDisplayStatus | undefined {
  if (entry.conflict) return "conflict";
  const changes = [entry.index, entry.worktree];
  if (changes.includes("deleted")) return "deleted";
  if (
    changes.some(
      (change) =>
        change === "modified" ||
        change === "typeChanged" ||
        change === "renamed" ||
        change === "copied" ||
        change === "unmerged",
    )
  )
    return "modified";
  if (changes.includes("added")) return "added";
  if (entry.untracked) return "untracked";
  return undefined;
}

/** Turn a host snapshot into file and ancestor-directory decorations. */
export function summarizeGitStatus(
  snapshot: GitStatusSnapshot | null | undefined,
): GitStatusView {
  if (!snapshot) return EMPTY_GIT_STATUS;
  const files = new Map<VaultPath, GitDisplayStatus>();
  const directories = new Map<VaultPath, GitDisplayStatus>();
  for (const entry of snapshot.entries) {
    const status = statusOf(entry);
    if (!status || !entry.path) continue;
    const path = entry.path as VaultPath;
    merge(files, path, status);
    for (let index = path.lastIndexOf("/"); index > 0;) {
      const parent = path.slice(0, index) as VaultPath;
      merge(directories, parent, status);
      index = parent.lastIndexOf("/");
    }
  }
  return { files, directories };
}
