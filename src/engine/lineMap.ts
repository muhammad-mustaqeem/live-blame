// LineMap — for the *large-file* mode only.
//
// In buffer-blame mode (small files), we pipe the buffer to `git blame
// --contents -` and the result lines are buffer-aligned by construction.
// No translation needed.
//
// In single-line mode (large files), we run `git blame -L N,N HEAD --
// <file>` against the on-disk content, NOT the buffer. If the buffer has
// uncommitted edits, the line number we pass to `-L` must be the
// corresponding line in the on-disk content — not the buffer line.
//
// We track edits since the last "synced" point (file save) using a simple
// running offset table. For each contiguous edit, we record:
//   { bufferStart, bufferLines, diskLines }
// derived from `TextDocumentChangeEvent.contentChanges`. The map is rebuilt
// whenever the document is saved (the disk content catches up to the buffer).
//
// For lines inside an edited range, we cannot translate to a single disk
// line — they're new. We mark those lines as "uncommitted" without spawning
// blame.

import { TextDocumentContentChangeEvent } from "vscode";

interface Hunk {
  /** First buffer line affected by this hunk, 0-based. */
  bufferStart: number;
  /** Number of lines this hunk currently occupies in the buffer. */
  bufferLines: number;
  /** Number of lines this hunk replaces from the disk content. */
  diskLines: number;
}

export class LineMap {
  /** Hunks sorted by bufferStart, non-overlapping. */
  private hunks: Hunk[] = [];

  /** Reset to an in-sync state (e.g. after save). */
  reset(): void {
    this.hunks = [];
  }

  /** Apply text changes from `onDidChangeTextDocument`. */
  applyChanges(changes: readonly TextDocumentContentChangeEvent[]): void {
    // VS Code provides changes in reverse document order so applying them
    // sequentially without re-indexing is safe. To stay agnostic we sort
    // descending by start line and apply.
    const sorted = [...changes].sort(
      (a, b) => b.range.start.line - a.range.start.line,
    );
    for (const ch of sorted) {
      this.applyOne(ch);
    }
  }

  private applyOne(ch: TextDocumentContentChangeEvent): void {
    const startLine = ch.range.start.line;
    const endLine = ch.range.end.line;
    const removedLines = endLine - startLine + 1;
    const addedLines = countLines(ch.text);

    // Treat this single change as one hunk and merge into existing hunks.
    const newHunk: Hunk = {
      bufferStart: startLine,
      bufferLines: addedLines,
      diskLines: removedLines,
    };

    // Merge with any overlapping/adjacent existing hunks.
    const merged: Hunk[] = [];
    let placed = false;
    for (const h of this.hunks) {
      const hEnd = h.bufferStart + h.bufferLines;
      const newEnd = newHunk.bufferStart + newHunk.bufferLines;
      // Hunks above the new edit (no overlap) — keep as-is.
      if (hEnd <= newHunk.bufferStart) {
        merged.push(h);
        continue;
      }
      // Hunks below the new edit — shift bufferStart by the delta.
      if (h.bufferStart >= newEnd) {
        if (!placed) {
          merged.push(newHunk);
          placed = true;
        }
        const delta = newHunk.bufferLines - newHunk.diskLines;
        merged.push({
          bufferStart: h.bufferStart + delta,
          bufferLines: h.bufferLines,
          diskLines: h.diskLines,
        });
        continue;
      }
      // Overlap — fold into the new hunk.
      newHunk.bufferStart = Math.min(newHunk.bufferStart, h.bufferStart);
      const combinedEnd = Math.max(hEnd, newEnd);
      newHunk.bufferLines = combinedEnd - newHunk.bufferStart;
      newHunk.diskLines += h.diskLines;
    }
    if (!placed) merged.push(newHunk);
    this.hunks = merged.sort((a, b) => a.bufferStart - b.bufferStart);
  }

  /**
   * Translate a buffer line to a disk line. Returns null if the buffer line
   * is inside an edited region (no corresponding disk line — should be
   * rendered as "uncommitted").
   *
   * `bufferLine` and the return value are 0-based.
   */
  translate(bufferLine: number): number | null {
    let diskLine = bufferLine;
    for (const h of this.hunks) {
      if (bufferLine < h.bufferStart) break;
      if (bufferLine < h.bufferStart + h.bufferLines) return null;
      diskLine += h.diskLines - h.bufferLines;
    }
    return diskLine;
  }

  /** True if no edits are pending. */
  get isClean(): boolean {
    return this.hunks.length === 0;
  }
}

function countLines(text: string): number {
  if (text === "") return 1; // a deletion still occupies "one line" in the buffer (the merged line)
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}
