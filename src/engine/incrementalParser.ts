// Streaming parser for `git blame --incremental` output.
//
// Format reference: https://git-scm.com/docs/git-blame#_the_porcelain_format
//
// Each entry begins with a header line:
//   <40-hex-sha> <sourceLine> <resultLine> <numLines>
// followed by zero or more metadata lines (author, author-mail, author-time,
// author-tz, committer, ..., summary, previous, filename), and terminates
// with a "filename <path>" line.
//
// Subsequent entries for an already-seen commit print just the header and
// the filename terminator — metadata is omitted. We dedupe by sha.

export interface CommitMeta {
  sha: string;
  author: string;
  authorEmail: string;
  authorTime: number; // unix seconds
  authorTz: string;
  committer: string;
  committerEmail: string;
  committerTime: number;
  committerTz: string;
  summary: string;
  filename: string;
  previous?: { sha: string; filename: string };
}

export interface BlameLine {
  sha: string;
  /** 1-based line in the file the blame ran against (the buffer, in our case). */
  resultLine: number;
  /** 1-based line in the originating commit. */
  sourceLine: number;
}

export interface BlameSnapshot {
  /** lineNumber (1-based) -> BlameLine */
  lines: Map<number, BlameLine>;
  /** sha -> commit metadata */
  commits: Map<string, CommitMeta>;
}

interface PendingEntry {
  sha: string;
  resultLine: number;
  sourceLine: number;
  numLines: number;
}

const HEADER_RE = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;

/**
 * Streaming parser. Feed `feed(chunk)` with stdout bytes/strings. Call
 * `finish()` once stdout closes. The accumulated snapshot is in `snapshot`.
 *
 * Buffers a partial trailing line across chunks; safe for arbitrary chunk
 * boundaries.
 */
export class IncrementalBlameParser {
  readonly snapshot: BlameSnapshot = {
    lines: new Map(),
    commits: new Map(),
  };

  private remainder = "";
  private pending: PendingEntry | null = null;
  /** Metadata accumulator for the *current* commit being read. */
  private currentMeta: Partial<CommitMeta> | null = null;
  /** Set of commit shas whose metadata we've already captured. */
  private seenCommits = new Set<string>();

  feed(chunk: string): void {
    const text = this.remainder + chunk;
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) {
      this.remainder = text;
      return;
    }
    const complete = text.slice(0, lastNl);
    this.remainder = text.slice(lastNl + 1);
    for (const line of complete.split("\n")) {
      this.consumeLine(line);
    }
  }

  finish(): void {
    if (this.remainder.length > 0) {
      this.consumeLine(this.remainder);
      this.remainder = "";
    }
  }

  private consumeLine(line: string): void {
    if (line.length === 0) return;

    if (this.pending === null) {
      const m = HEADER_RE.exec(line);
      if (!m) return; // unknown line (e.g. boundary marker on first chunk)
      const sha = m[1];
      const sourceLine = parseInt(m[2], 10);
      const resultLine = parseInt(m[3], 10);
      const numLines = m[4] ? parseInt(m[4], 10) : 1;
      this.pending = { sha, sourceLine, resultLine, numLines };
      // Start metadata accumulator only for first sighting of this sha.
      if (!this.seenCommits.has(sha)) {
        this.currentMeta = { sha };
      } else {
        this.currentMeta = null;
      }
      return;
    }

    // Inside an entry. Look for "filename" terminator first.
    if (line.startsWith("filename ")) {
      const filename = line.slice("filename ".length);
      const { sha, sourceLine, resultLine, numLines } = this.pending;
      // Commit metadata (only first time we saw this sha).
      if (this.currentMeta) {
        this.currentMeta.filename = filename;
        this.snapshot.commits.set(sha, completeCommit(this.currentMeta));
        this.seenCommits.add(sha);
      }
      // Per-line entries: this header covers `numLines` consecutive result lines.
      for (let i = 0; i < numLines; i++) {
        this.snapshot.lines.set(resultLine + i, {
          sha,
          resultLine: resultLine + i,
          sourceLine: sourceLine + i,
        });
      }
      this.pending = null;
      this.currentMeta = null;
      return;
    }

    if (this.currentMeta) {
      this.parseMetaLine(line);
    }
  }

  private parseMetaLine(line: string): void {
    if (!this.currentMeta) return;
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? "" : line.slice(space + 1);
    switch (key) {
      case "author":
        this.currentMeta.author = value;
        break;
      case "author-mail":
        this.currentMeta.authorEmail = stripAngles(value);
        break;
      case "author-time":
        this.currentMeta.authorTime = parseInt(value, 10);
        break;
      case "author-tz":
        this.currentMeta.authorTz = value;
        break;
      case "committer":
        this.currentMeta.committer = value;
        break;
      case "committer-mail":
        this.currentMeta.committerEmail = stripAngles(value);
        break;
      case "committer-time":
        this.currentMeta.committerTime = parseInt(value, 10);
        break;
      case "committer-tz":
        this.currentMeta.committerTz = value;
        break;
      case "summary":
        this.currentMeta.summary = value;
        break;
      case "previous": {
        // "previous <sha> <filename>"
        const sp = value.indexOf(" ");
        if (sp > 0) {
          this.currentMeta.previous = {
            sha: value.slice(0, sp),
            filename: value.slice(sp + 1),
          };
        }
        break;
      }
      // boundary: "boundary" — no value; we ignore it.
      default:
        break;
    }
  }
}

function stripAngles(s: string): string {
  // "<email@example.com>" -> "email@example.com"
  if (s.startsWith("<") && s.endsWith(">")) {
    return s.slice(1, -1);
  }
  return s;
}

function completeCommit(p: Partial<CommitMeta>): CommitMeta {
  return {
    sha: p.sha ?? "0".repeat(40),
    author: p.author ?? "Unknown",
    authorEmail: p.authorEmail ?? "",
    authorTime: p.authorTime ?? 0,
    authorTz: p.authorTz ?? "+0000",
    committer: p.committer ?? p.author ?? "Unknown",
    committerEmail: p.committerEmail ?? p.authorEmail ?? "",
    committerTime: p.committerTime ?? p.authorTime ?? 0,
    committerTz: p.committerTz ?? p.authorTz ?? "+0000",
    summary: p.summary ?? "",
    filename: p.filename ?? "",
    previous: p.previous,
  };
}

export const UNCOMMITTED_SHA = "0000000000000000000000000000000000000000";

export function isUncommitted(sha: string): boolean {
  return sha === UNCOMMITTED_SHA;
}
