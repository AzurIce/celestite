---
name: land
description: >-
  Land this thread's changes into the user's local Celestite checkout. Invoke
  only when the user has explicitly requested landing (e.g. pressed Land
  Changes or asked to merge/land the changes) — not for review, preparation,
  passing checks, or after skill installation.
disable-model-invocation: true
metadata:
  delta-action: land
---

# Land changes into the local checkout

Apply this thread's changes to the user's primary checkout (`local` remote at
the repository root). Never push to `origin` — the user publishes to GitHub
themselves.

An invocation of this skill is the landing request. Do not ask whether the user
wants to land; proceed. Stop only for genuine blockers (failed required
verification, ambiguous conflicts, rejected push).

## 1. Establish the change set

- Run `git --no-optional-locks status --porcelain` to see modified, deleted,
  and untracked files.
- If the working tree is clean, verify whether the thread's `main` already has
  commits not yet on `local/main` (`git log local/main..HEAD --oneline`). If
  there is nothing to push either, report that there are no changes to land.
- Untracked files that are part of the change are included; leave gitignored
  paths alone.

## 2. Verify before landing (proportional to the change)

Web code (`.ts .tsx .js .jsx .css .html .json .md` under `web/`) — required by
`AGENTS.md` and exercised by `.github/workflows/pages.yml` (see its
"Check Web formatting" and "Check types" steps; commands defined in
`web/package.json` scripts):

- `bun run --cwd web format` — must be run after any web-code edit before
  delivery; then `bun run --cwd web format:check` must pass.
- `bun run --cwd web typecheck` must pass.

Rust code (`.rs`, `Cargo.toml`) — toolchain is pinned by `flake.nix`
(nightly-2026-10-01):

- `cargo check --workspace` must pass. Formatting is not yet enforced
  (see `AGENTS.md`); do not fail on it.

If any required check fails, stop and report that the changes have **not**
landed, including the failing command and output summary. Do not skip or
weaken checks to force a landing.

## 3. Commit

- Stage the change set and create one commit (or a small number of clearly
  separated commits if the change set has unrelated concerns).
- Follow the repository's conventional-commit style seen in history, e.g.
  `feat(web): ...`, `fix(server): ...`, `refactor(editor): ...`,
  `chore(deps): ...`.

## 4. Push to `local`

- Fetch first: `git fetch local`.
- If `local/main` has moved ahead of the merge base, integrate it: rebase or
  merge the thread's commits onto `local/main`.
  - Conflict preference: resolve simple conflicts automatically when the
    intended result is clear, preserving unrelated work; pause and ask the
    user for serious or ambiguous conflicts instead of guessing.
- Re-run any verification invalidated by the integration (at minimum
  `bun run --cwd web format:check` if web code was touched).
- Push: `git push local main`.
  - The `local` remote is configured with
    `receive.denyCurrentBranch=updateInstead`, so a push to the checked-out
    `main` updates the user's working checkout in place.
  - If the push is rejected because the user's checkout has uncommitted
    changes or untracked conflicts, do **not** force-push and do not touch the
    user's working tree. Stop and report: the changes are committed on the
    thread's `main` but not landed; the user should clean their local checkout
    (commit, stash, or discard) and re-run Land Changes.

## 5. Verify and report

- Confirm `git rev-parse local/main` equals the landed commit after the push.
- Report: landed or not, the commit subject and hash, the verification results,
  and any caveats (e.g. `origin` intentionally not updated).
