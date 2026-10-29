import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeGitStatus } from "../../src/lib/git/status";
import { vaultPath } from "../../src/lib/vault";
import type {
  GitStatusEntry,
  GitStatusSnapshot,
} from "../../src/lib/editor/generated/celestite_core";

function entry(
  path: string,
  patch: Partial<GitStatusEntry> = {},
): GitStatusEntry {
  return {
    path,
    index: "unmodified",
    worktree: "unmodified",
    ...patch,
  };
}

function snapshot(entries: GitStatusEntry[]): GitStatusSnapshot {
  return { entries };
}

test("maps file statuses with Zed precedence", () => {
  const view = summarizeGitStatus(
    snapshot([
      entry("added.md", { index: "added" }),
      entry("new.md", { untracked: true }),
      entry("modified.md", { worktree: "modified" }),
      entry("deleted.md", { index: "deleted" }),
      entry("both.md", { index: "added", worktree: "modified" }),
      entry("conflict.md", {
        index: "unmerged",
        worktree: "unmerged",
        conflict: true,
      }),
    ]),
  );
  assert.equal(view.files.get(vaultPath("added.md")), "added");
  assert.equal(view.files.get(vaultPath("new.md")), "untracked");
  assert.equal(view.files.get(vaultPath("modified.md")), "modified");
  assert.equal(view.files.get(vaultPath("deleted.md")), "deleted");
  assert.equal(view.files.get(vaultPath("both.md")), "modified");
  assert.equal(view.files.get(vaultPath("conflict.md")), "conflict");
});

test("aggregates directory status by highest priority", () => {
  const view = summarizeGitStatus(
    snapshot([
      entry("src/a.md", { worktree: "modified" }),
      entry("src/deep/b.md", { untracked: true }),
      entry("docs/old.md", { worktree: "deleted" }),
      entry("other/new.md", { index: "added" }),
    ]),
  );
  assert.equal(view.directories.get(vaultPath("src")), "modified");
  assert.equal(view.directories.get(vaultPath("src/deep")), "untracked");
  assert.equal(view.directories.get(vaultPath("docs")), "deleted");
  assert.equal(view.directories.get(vaultPath("other")), "added");
  assert.equal(view.directories.get(vaultPath("")), undefined);
});

test("empty and malformed snapshots produce no decoration", () => {
  assert.equal(summarizeGitStatus(null).files.size, 0);
  const view = summarizeGitStatus(
    snapshot([
      entry("a.md", { index: "unmodified", worktree: "unmodified" }),
      entry("", { untracked: true }),
    ]),
  );
  assert.equal(view.files.size, 0);
});
