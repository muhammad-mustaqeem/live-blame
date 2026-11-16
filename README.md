# Live Blame

Inline git blame for VS Code that stays correct under uncommitted edits, branch switches, rebases, and large files. Built to fix the four failure modes that plague every other inline-blame extension.

## Why

Existing extensions (GitLens current-line blame, Wader/Sertion Git Blame, Blamer VS) suffer from one or more of:

- **Blame disappears** after a while — global trackers get suspended, watchers miss git events.
- **Editor lag** on large files — they spawn `git blame` per keystroke or invalidate cache on every save.
- **Stale info** after rebase / fetch / stash — cache invalidation isn't wired to actual git state.
- **Wrong author on edited lines** — they cache blame computed from disk content, then index it with current buffer line numbers, so as soon as you type a line in the middle, every line below is misattributed by one.

Live Blame fixes all four:

- Per-editor decoration lifecycle, no global suspension.
- Cache keyed by `(filePath, sha1(bufferContent))` — the same content never re-spawns a process. Trailing debounce. Bounded process pool.
- Subscribes to the built-in `vscode.git` extension API (`Repository.state.onDidChange`, `onDidCommit`, `onDidCheckout`) so commits / fetches / branch switches / rebases / stashes invalidate exactly the right cache entries. Falls back to a `.git/` filesystem watcher.
- Uses `git blame --incremental --contents -` and pipes the live editor buffer to stdin. Result lines are **already aligned to the buffer**, so uncommitted edits never break attribution. Modified lines come back with SHA `0000…0000` and render as "You, uncommitted".

## Rich hover & time-travel

**Rich hover** — hover any line to see the full commit message body, co-authors (`Co-authored-by:`), file / insertion / deletion stats, and the **diff hunk that introduced that exact line**. It's computed lazily (only when you hover) and cancelled the moment you move away, so it never slows cursor movement. Results are cached per commit SHA.

**Time-travel** — view a file as of any past revision and blame it there:

- **Blame at Revision…** — pick from the file's recent commits (or enter a ref) to open a read-only snapshot with inline blame as of that point.
- **Blame Previous Revision** — jump to the parent of the current line's commit to see who wrote it before the latest change.
- **Step Older / Newer** walk the file's history; a status-bar item shows which revision you're viewing. Exit returns to the live file.

## Build & install

```bash
npm install
npm run package
code --install-extension live-blame-0.2.0.vsix
```

That's it. Reload VS Code and click into any line in a file in a git repo — you'll see the blame at the end of the line.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `liveBlame.enabled` | `true` | Master switch. |
| `liveBlame.format` | `"${author}, ${ago} • ${summary}"` | Inline template. Tokens: `${author}`, `${authorEmail}`, `${ago}`, `${date}`, `${summary}`, `${hash}`, `${pr}`. |
| `liveBlame.uncommittedFormat` | `"You, uncommitted"` | Text for lines you've changed but not committed. |
| `liveBlame.delay` | `500` | Trailing debounce in ms after edits before re-blaming. |
| `liveBlame.maxLines` | `50000` | Skip blame above this line count. |
| `liveBlame.maxFileSizeBytes` | `5242880` | Skip blame above this file size (default 5 MB). |
| `liveBlame.largeFileLines` | `10000` | Files larger than this use single-line blame mode. |
| `liveBlame.showOnAllLines` | `false` | Show blame on every line, not just the cursor line. |
| `liveBlame.showPRLink` | `true` | Detect and link pull requests in hovers. |
| `liveBlame.processPoolSize` | `4` | Max concurrent `git blame` processes. |
| `liveBlame.hover.enabled` | `true` | Show the rich hover (body, co-authors, stats, introducing diff). |
| `liveBlame.hover.showDiff` | `true` | Include the diff hunk that introduced the hovered line. |
| `liveBlame.hover.diffMaxLines` | `40` | Truncate the hover diff to this many lines (0 = no limit). |
| `liveBlame.timeTravel.commitPickerLimit` | `50` | Commits listed in "Blame at Revision…". |

## Commands

| Command | What it does |
|---|---|
| `Live Blame: Toggle` | Toggle inline blame. |
| `Live Blame: Open Commit` | Open the commit on the remote (GitHub/GitLab/Bitbucket/Azure). |
| `Live Blame: Copy Commit Hash` | Copy the full SHA to clipboard. |
| `Live Blame: Open Pull Request` | Open the detected PR. |
| `Live Blame: Clear Cache` | Drop all cached blame data. |
| `Live Blame: Blame at Revision…` | Open this file as of a chosen commit/ref (read-only) and blame it there. |
| `Live Blame: Blame Previous Revision` | Open the parent of the current line's commit. |
| `Live Blame: Time-Travel — Step Older` | Move to the previous revision that touched this file. |
| `Live Blame: Time-Travel — Step Newer` | Step back toward the revision you started from. |
| `Live Blame: Exit Time-Travel` | Close the historical view. |

## Architecture

```
extension.ts (activation, glue, disposables)
  ├── BlameEngine (cache + dispatch; live + at-revision)
  │     ├── GitProcessPool (bounded spawn pool; blame + generic runGit)
  │     ├── IncrementalParser (streaming)
  │     └── LineMap (large-file mode)
  ├── CommitDetailService (per-SHA body / co-authors / stats / intro hunk)
  ├── RepoSubscriber (vscode.git API + fallback watcher)
  ├── Renderer (inline decoration lifecycle)
  ├── BlameHoverProvider (lazy rich markdown hover)
  ├── TimeTravel (RevisionContentProvider + TimeTravelController)
  └── PRResolver (commit → PR URL)
```

### Two blame modes

- **Buffer-blame mode** (default, files ≤ `largeFileLines`): pipes the editor buffer to `git blame --incremental --contents - HEAD -- <relpath>`. Cache key is `(filePath, sha1(bufferText))`. Same content = same blame, no re-spawn.
- **Single-line mode** (files > `largeFileLines`): on cursor move, runs `git blame -L N,N --incremental HEAD -- <relpath>` for the current line only. Constant time wrt file size. Edited lines short-circuit to "uncommitted" via a per-document `LineMap`.

### Cache invalidation

The cache is invalidated on:

1. Buffer content hash change (per file, automatic).
2. `Repository.state.onDidChange` from the `vscode.git` API (covers stage/unstage, fetch, branch switch, rebase, stash, cherry-pick).
3. `Repository.onDidCommit` (hard-clear for that repo).
4. Fallback FS watcher signals on `.git/{HEAD,refs/**,packed-refs,index}`.

## License

MIT.
