// RevisionContentProvider — backs the read-only `liveblame-rev:` scheme used
// by time-travel. The document body is `git show <rev>:<relpath>`, i.e. the
// file's committed content at that revision. Because only a content provider
// (and no FileSystemProvider) is registered for the scheme, VS Code treats the
// document as read-only automatically.
//
// URI layout:
//   liveblame-rev:/<posix-relpath>?<json{root,rev}>
//
// The path carries the relpath (so the editor infers the language from the
// extension). root + rev travel in the query as JSON; we parse defensively
// because VS Code may percent-encode the query string.

import {
  CancellationToken,
  TextDocumentContentProvider,
  Uri,
} from "vscode";
import { GitProcessPool } from "../engine/gitProcessPool.js";

export const REV_SCHEME = "liveblame-rev";

export interface RevTarget {
  /** Repo working-tree root (cwd for git). */
  root: string;
  /** Repo-relative POSIX path. */
  relpath: string;
  /** Commit SHA (or any ref) the content is shown at. */
  rev: string;
}

/** Build a read-only URI for `relpath` at `rev` under repo `root`. */
export function makeRevUri(root: string, relpath: string, rev: string): Uri {
  const posix = relpath.split(/[\\/]/).join("/");
  return Uri.from({
    scheme: REV_SCHEME,
    path: "/" + posix,
    query: JSON.stringify({ root, rev }),
  });
}

/** Parse a `liveblame-rev:` URI back into its target, or null if malformed. */
export function parseRevUri(uri: Uri): RevTarget | null {
  if (uri.scheme !== REV_SCHEME) return null;
  const data = parseQuery(uri.query);
  if (!data || typeof data.root !== "string" || typeof data.rev !== "string") {
    return null;
  }
  const relpath = uri.path.replace(/^\//, "");
  return { root: data.root, relpath, rev: data.rev };
}

function parseQuery(q: string): { root?: unknown; rev?: unknown } | null {
  if (!q) return null;
  try {
    return JSON.parse(q);
  } catch {
    /* maybe percent-encoded */
  }
  try {
    return JSON.parse(decodeURIComponent(q));
  } catch {
    return null;
  }
}

export class RevisionContentProvider implements TextDocumentContentProvider {
  constructor(private pool: GitProcessPool) {}

  async provideTextDocumentContent(
    uri: Uri,
    token: CancellationToken,
  ): Promise<string> {
    const target = parseRevUri(uri);
    if (!target) return "";
    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    try {
      return await this.pool.runGit(
        ["show", `${target.rev}:${target.relpath}`],
        { cwd: target.root, signal: ac.signal },
      );
    } catch {
      const short = target.rev.length >= 7 ? target.rev.slice(0, 7) : target.rev;
      return `// Live Blame: could not load "${target.relpath}" at ${short}.`;
    }
  }
}
