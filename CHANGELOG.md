# Changelog

## 0.2.0

- **Rich hover**: full commit message body, co-authors (`Co-authored-by:`), file/+/- stats, and the diff hunk that introduced the hovered line — rendered lazily on hover and cancelled on mouse-away. Now a registered `HoverProvider`, so hovers work on any line, not just the cursor line.
- **Time-travel blame**: view a file as of any revision via read-only `liveblame-rev:` documents with inline blame against that revision. New commands: Blame at Revision…, Blame Previous Revision, Step Older/Newer, Exit Time-Travel, plus a status-bar indicator.
- Generic `GitProcessPool.runGit` so commit-detail / diff lookups share the same concurrency gate as blame.
- New settings: `liveBlame.hover.enabled`, `liveBlame.hover.showDiff`, `liveBlame.hover.diffMaxLines`, `liveBlame.timeTravel.commitPickerLimit`.

## 0.1.0

Initial release.

- Inline end-of-line blame on the current cursor line
- Buffer-content blame mode (`git blame --contents -`) — accurate under uncommitted edits
- Single-line blame mode for very large files
- Per-editor decoration lifecycle (no leaks across editor changes)
- Subscribes to the built-in Git extension API for accurate invalidation on commit / branch switch / fetch / rebase / stash
- Falls back to a `.git/` filesystem watcher when the API is unavailable
- Bounded git process pool, content-hash cache, configurable trailing debounce
- Rich hover with author, date, full message, hash, and pull-request link (GitHub / GitLab / Bitbucket / Azure DevOps)
- "You, uncommitted" rendering for locally-modified lines
- Skips binary files, files above size / line thresholds, and non-git folders
