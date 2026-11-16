// Bounded pool of `git blame` processes. Limits concurrency so a flood of
// blame requests doesn't fork-bomb git on monorepos.
//
// Spawning is the only way to talk to git for blame (libgit2 bindings in JS
// are unmaintained or feature-incomplete; see R&D notes). We pay the spawn
// cost but cache aggressively upstream so a given (file, content-hash) is
// only ever blamed once.

import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { IncrementalBlameParser, BlameSnapshot } from "./incrementalParser.js";

export interface BlameRequest {
  /** Repo working-tree root. cwd for the spawned process. */
  cwd: string;
  /** Path *relative* to `cwd` (POSIX-style preferred, but git accepts native). */
  relpath: string;
  /** If set, pipe this content via `--contents -` (buffer-blame mode). */
  bufferContent?: string;
  /** If set, restrict to a single line range via `-L N,N`. 1-based. */
  lineRange?: { start: number; end: number };
  /** Blame against this ref instead of HEAD (time-travel). Default HEAD. */
  ref?: string;
  /** Additional path to ignore-revs file, if any. */
  ignoreRevsFile?: string;
  /** AbortSignal to cancel an in-flight blame. */
  signal?: AbortSignal;
}

export class GitProcessPool {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private maxConcurrent: number) {}

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, n);
    this.drain();
  }

  async run(req: BlameRequest): Promise<BlameSnapshot> {
    await this.acquire();
    try {
      return await spawnBlame(req);
    } finally {
      this.release();
    }
  }

  /**
   * Generic git runner behind the same concurrency gate. Used for commit
   * detail / diff lookups (show, log -L) so they can't fork-bomb either.
   * Returns stdout as a string; rejects GitBlameError on failure, AbortError
   * when the signal fires.
   */
  async runGit(
    args: string[],
    opts: { cwd: string; signal?: AbortSignal; input?: string },
  ): Promise<string> {
    await this.acquire();
    try {
      return await spawnGit(args, opts);
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    this.drain();
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    }
  }
}

function spawnBlame(req: BlameRequest): Promise<BlameSnapshot> {
  const args = ["blame", "--incremental", "--root", "-w"];
  if (req.lineRange) {
    args.push("-L", `${req.lineRange.start},${req.lineRange.end}`);
  }
  if (req.ignoreRevsFile) {
    args.push("--ignore-revs-file", req.ignoreRevsFile);
  }
  if (req.bufferContent !== undefined) {
    args.push("--contents", "-");
  }
  args.push(req.ref ?? "HEAD", "--", req.relpath);

  return new Promise<BlameSnapshot>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn("git", args, {
        cwd: req.cwd,
        env: { ...process.env, LC_ALL: "C", GIT_PAGER: "cat" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      reject(new GitBlameError(-1, (err as Error).message));
      return;
    }

    const parser = new IncrementalBlameParser();
    let stderrBuf = "";
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    if (req.signal) {
      if (req.signal.aborted) {
        onAbort();
      } else {
        req.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => parser.feed(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Cap stderr capture; some failures (binary file, etc.) can produce noise.
      if (stderrBuf.length < 4096) stderrBuf += chunk;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (req.signal) req.signal.removeEventListener("abort", onAbort);
      // Spawn errors (e.g. ENOENT when git isn't on PATH) get normalized to
      // GitBlameError so callers don't have to special-case them.
      reject(new GitBlameError(-1, (err as Error).message));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (req.signal) req.signal.removeEventListener("abort", onAbort);
      parser.finish();
      if (code === 0) {
        resolve(parser.snapshot);
      } else if (signal === "SIGTERM" || req.signal?.aborted) {
        reject(new AbortError());
      } else {
        reject(new GitBlameError(code ?? -1, stderrBuf.trim()));
      }
    });

    if (req.bufferContent !== undefined) {
      child.stdin.on("error", () => {
        /* swallow EPIPE — happens if blame fails fast */
      });
      child.stdin.end(req.bufferContent, "utf8");
    } else {
      child.stdin.end();
    }
  });
}

// Generic git invocation that buffers stdout into a string. Mirrors
// spawnBlame's error normalization (ENOENT/abort) but isn't blame-specific.
function spawnGit(
  args: string[],
  opts: { cwd: string; signal?: AbortSignal; input?: string },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn("git", args, {
        cwd: opts.cwd,
        env: { ...process.env, LC_ALL: "C", GIT_PAGER: "cat" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      reject(new GitBlameError(-1, (err as Error).message));
      return;
    }

    let out = "";
    let errBuf = "";
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (errBuf.length < 4096) errBuf += chunk;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      reject(new GitBlameError(-1, (err as Error).message));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      if (code === 0) {
        resolve(out);
      } else if (signal === "SIGTERM" || opts.signal?.aborted) {
        reject(new AbortError());
      } else {
        reject(new GitBlameError(code ?? -1, errBuf.trim()));
      }
    });

    if (opts.input !== undefined) {
      child.stdin.on("error", () => {
        /* swallow EPIPE */
      });
      child.stdin.end(opts.input, "utf8");
    } else {
      child.stdin.end();
    }
  });
}

export class GitBlameError extends Error {
  constructor(public exitCode: number, public stderr: string) {
    super(`git blame exited ${exitCode}: ${stderr}`);
    this.name = "GitBlameError";
  }
}

export class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}
