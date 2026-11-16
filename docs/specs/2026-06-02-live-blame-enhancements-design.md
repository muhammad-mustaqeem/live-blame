# Live Blame v0.2 — Enhancements Design

- **Date:** 2026-06-02
- **Status:** Approved (round one), implementing

## Scope

Two features layered on the existing reliability-focused engine, without
changing the live-blame hot path or its four guarantees (no disappear, no lag,
no stale, correct on uncommitted edits):

1. **Rich hover** — full commit message body, co-authors, file/insertion/
   deletion stats, and the *introducing diff hunk* for the hovered line.
2. **Time-travel blame (full mode)** — open a file as of any revision
   (read-only), blamed against that revision, with step Older/Newer and a
   status-bar indicator.

**Out of scope (later rounds):** avatars, permalinks, selection author
breakdown, true-origin rename following, live status-bar blame, full-file
annotate, issue-link templates.

## Components

| Unit | File | Responsibility |
|---|---|---|
| `CommitDetailService` | `src/engine/commitDetails.ts` | Fetch + cache (per-SHA, immutable) commit body, co-authors, stats, and the line's intro hunk. |
| `BlameHoverProvider` | `src/ui/blameHoverProvider.ts` | Registered `HoverProvider`; resolves blame for the hovered line and composes markdown lazily. Reuses `buildHover`. |
| `RevisionContentProvider` | `src/timetravel/revisionProvider.ts` | `TextDocumentContentProvider` for scheme `liveblame-rev:` → `git show <rev>:<path>`. |
| `TimeTravelController` | `src/timetravel/timeTravelController.ts` | Owns the time-travel session (rev chain, commands, status bar, context key). |

## Shared engine changes

- `GitProcessPool.runGit(args, {cwd, signal, input})` — generic git runner
  behind the same concurrency gate. `spawnBlame` stays as-is (streaming).
- `BlameRequest.ref` — blame against a ref instead of `HEAD` (no buffer pipe).
- `BlameEngine.resolveAtRevision(doc, root, relpath, rev, line)` — whole-file
  blame against `rev`, cached by `(root, relpath, rev)`; historical content is
  the doc content, so lines map 1:1.
- `BlameEngine.getProcessPool()` — share the pool with `CommitDetailService`.

## Feature A — Rich hover (data flow)

Registered for schemes `file`, `vscode-remote`, and `liveblame-rev`. On hover
over line *L*:

1. Gate on `enabled` + `hover.enabled`; skip untitled/binary. Link the hover
   `CancellationToken` to an `AbortController`.
2. Resolve blame for *L* (live → `resolve`; historical → `resolveAtRevision`).
   Works on **any** hovered line, not just the cursor line.
3. Uncommitted → minimal hover, no git calls.
4. Committed → `CommitDetailService`:
   - `git show -s --format=%B <sha>` → body; parse `Co-authored-by:` trailers.
   - `git show -s --numstat --format= <sha>` → files / +/−.
   - `git log -1 -p --format= -L<srcLine>,<srcLine>:<histPath> <sha>` → the
     hunk that introduced the line (uses blame's historical filename → rename
     safe). Truncated to `hover.diffMaxLines`.
5. Compose one trusted `MarkdownString`: header → body → co-authors → stats →
   ` ```diff ` block → existing action links (Open Commit / Copy Hash / PR).

The decoration's static `hoverMessage` is removed; the provider owns hovers.
Detail/hunk lookups are cached by immutable SHA — computed once, never
invalidated.

## Feature B — Time-travel (full mode)

Historical blame cannot be overlaid on the live buffer (line numbers diverge),
so time-travel opens the file's content as of `rev` in a read-only
`liveblame-rev:` document and blames against `rev`. That virtual editor gets
the same inline annotations + rich hovers.

- **URI:** `liveblame-rev:/<relpath>?root=<enc(root)>&rev=<sha>` — path carries
  the extension (for syntax highlighting); query carries root + rev. Distinct
  query ⇒ distinct doc identity, so each rev is its own editor. Read-only
  because only a content provider backs the scheme.
- **Commands:**
  - `blameAtRevision` — quickpick of the file's recent commits
    (`git log`, limited to `timeTravel.commitPickerLimit`) or "Enter ref…".
  - `blamePreviousRevision` — from the active line's commit `C`, open `C^` and
    jump to the line.
  - `stepOlder` — `git log -1 --format=%H <rev>^ -- <relpath>` (previous rev
    that touched the file).
  - `stepNewer` — walk back along the visited-rev stack.
  - `exitTimeTravel` — close the historical view.
- **Status bar:** `$(history) @ <shortSha>` shown only when a `liveblame-rev:`
  editor is active; tooltip shows subject + "N revisions back"; click opens a
  quickpick (Older / Newer / Exit / Open Commit). Context key
  `liveBlame.inTimeTravel` gates command-palette visibility.

## New settings & commands

- Settings: `liveBlame.hover.enabled` (true), `liveBlame.hover.showDiff`
  (true), `liveBlame.hover.diffMaxLines` (40), `liveBlame.timeTravel.commitPickerLimit` (50).
- Commands: `liveBlame.blameAtRevision`, `.blamePreviousRevision`,
  `.stepOlder`, `.stepNewer`, `.exitTimeTravel`. No default keybindings.

## Edge cases

- Merge commit → first parent + note. Root commit → "reached initial commit".
- File absent at rev → notify, don't open. Historical file shorter → clamp.
- Binary/oversized historical content → skip blame via `pickMode`.
- Shallow clone → swallow `git log -L`/parent errors, show what's available.
- Hover cancellation → abort in-flight detail/hunk git calls.

## Manual verification (no automated tests, per project preference)

1. Hover a committed line → body + co-authors + stats + diff hunk.
2. Hover an uncommitted line → minimal message, no git spawned.
3. Move mouse off mid-hover → no zombie `git` process.
4. `Blame at Revision…` → historical content opens read-only with inline blame.
5. Step Older / Newer / Exit; status bar reflects current rev.
6. Merge & root-commit navigation show the expected notices.
7. Large file (> `largeFileLines`) → hover still works (line-mode), no lag.
