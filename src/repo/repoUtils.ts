// Repo discovery + small helpers. Wraps a `vscode.git` Repository when
// available; otherwise we fall back to `git rev-parse` once and cache.

import { Uri } from "vscode";
import type { Repository } from "../types/git.js";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";

export interface RepoInfo {
  /** Working-tree root (absolute, native separators). cwd for git calls. */
  workingTreeRoot: string;
  /** Path to the actual `.git` directory (handles worktrees / submodules). */
  gitDir: string;
  /** Current HEAD commit SHA, or undefined when not yet known. */
  headSha?: string;
  /** Remote `origin` URL if available (used by PRResolver). */
  remoteUrl?: string;
  /** The vscode.git Repository if we have it. */
  vscodeRepo?: Repository;
  /** Translate a file URI to a relpath under workingTreeRoot. */
  relpath(uri: Uri): string;
}

/** Build a RepoInfo from a vscode.git Repository. */
export function repoInfoFromVscode(repo: Repository): RepoInfo {
  const root = repo.rootUri.fsPath;
  const gitDir = path.join(root, ".git"); // resolved lazily on first FS-watcher use
  const remote =
    repo.state.remotes.find((r) => r.name === "origin")?.fetchUrl ??
    repo.state.remotes[0]?.fetchUrl;
  return {
    workingTreeRoot: root,
    gitDir,
    headSha: repo.state.HEAD?.commit,
    remoteUrl: remote,
    vscodeRepo: repo,
    relpath(uri: Uri): string {
      return path.relative(root, uri.fsPath);
    },
  };
}

/** Discover the repo for a file by walking up to find `.git`. Used as fallback. */
export async function discoverRepoFromFile(
  fileUri: Uri,
): Promise<RepoInfo | null> {
  let dir = path.dirname(fileUri.fsPath);
  // Walk up at most 64 levels (safety cap).
  for (let i = 0; i < 64; i++) {
    const candidate = path.join(dir, ".git");
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        const headSha = await tryReadHead(candidate);
        return makeStandaloneInfo(dir, candidate, headSha);
      }
      if (stat.isFile()) {
        // Submodule or worktree: `.git` is a file with a `gitdir:` line.
        const text = await fs.readFile(candidate, "utf8");
        const m = /^gitdir:\s*(.+)$/m.exec(text.trim());
        if (m) {
          const gitDir = path.isAbsolute(m[1]) ? m[1] : path.join(dir, m[1]);
          const headSha = await tryReadHead(gitDir);
          return makeStandaloneInfo(dir, gitDir, headSha);
        }
      }
    } catch {
      // ENOENT — keep walking.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function makeStandaloneInfo(
  root: string,
  gitDir: string,
  headSha?: string,
): RepoInfo {
  return {
    workingTreeRoot: root,
    gitDir,
    headSha,
    relpath(uri: Uri): string {
      return path.relative(root, uri.fsPath);
    },
  };
}

async function tryReadHead(gitDir: string): Promise<string | undefined> {
  try {
    const headFile = path.join(gitDir, "HEAD");
    const content = (await fs.readFile(headFile, "utf8")).trim();
    if (content.startsWith("ref: ")) {
      const ref = content.slice("ref: ".length).trim();
      const refFile = path.join(gitDir, ref);
      try {
        return (await fs.readFile(refFile, "utf8")).trim();
      } catch {
        // Packed refs.
        try {
          const packed = await fs.readFile(
            path.join(gitDir, "packed-refs"),
            "utf8",
          );
          for (const line of packed.split("\n")) {
            if (line.startsWith("#") || line.startsWith("^")) continue;
            const sp = line.indexOf(" ");
            if (sp > 0 && line.slice(sp + 1).trim() === ref) {
              return line.slice(0, sp);
            }
          }
        } catch {
          /* fallthrough */
        }
      }
    } else {
      // Detached HEAD: file contains the SHA directly.
      return content;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Quick "is this a binary file" heuristic so we don't try to blame e.g.
 * compiled artifacts. Reads first 8 KB; if any NUL byte, it's binary.
 */
export async function isBinaryFile(uri: Uri): Promise<boolean> {
  try {
    const fh = await fs.open(uri.fsPath, "r");
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0) return true;
      }
      return false;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/** Run `git rev-parse HEAD` in cwd. Returns null on any error. */
export function readHeadSha(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn("git", ["rev-parse", "HEAD"], {
      cwd,
      env: { ...process.env, LC_ALL: "C", GIT_PAGER: "cat" },
    });
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      resolve(code === 0 ? out.trim() || null : null);
    });
  });
}
