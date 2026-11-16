// RepoSubscriber — single source of truth for "the cache for repo X is now
// stale". Every existing extension we surveyed botches one or more of:
//
//  - Branch switch (HEAD rewrite)
//  - Stage / unstage (.git/index)
//  - Fetch (refs/remotes/* — packed or loose)
//  - Rebase / cherry-pick (HEAD churn + .git/rebase-merge/)
//  - Worktree HEAD changes (.git/worktrees/<name>/HEAD)
//
// We cover them by:
//  1. Subscribing to the built-in `vscode.git` extension API:
//       - api.onDidOpenRepository / onDidCloseRepository
//       - repo.state.onDidChange   (covers all of the above)
//  2. Falling back to a glob FS watcher on
//       .git/{HEAD,refs/**,packed-refs,index,MERGE_HEAD,CHERRY_PICK_HEAD}
//     when the API is missing or disabled.

import {
  Disposable,
  EventEmitter,
  Event,
  extensions,
  RelativePattern,
  workspace,
} from "vscode";
import type { GitExtension, API, Repository } from "../types/git.js";
import { RepoInfo, repoInfoFromVscode, discoverRepoFromFile } from "./repoUtils.js";
import { Uri } from "vscode";

export interface RepoChangeEvent {
  repo: RepoInfo;
  /** True if HEAD itself changed (commit/checkout/rebase advance). */
  headChanged: boolean;
}

export class RepoSubscriber implements Disposable {
  private disposables: Disposable[] = [];
  private repos = new Map<string, RepoInfo>();
  /** Per-repo per-watch fallback disposables. */
  private fallbackWatchers = new Map<string, Disposable>();

  private _onDidChange = new EventEmitter<RepoChangeEvent>();
  readonly onDidChange: Event<RepoChangeEvent> = this._onDidChange.event;

  private _onDidCommit = new EventEmitter<RepoInfo>();
  readonly onDidCommit: Event<RepoInfo> = this._onDidCommit.event;

  start(): void {
    const ext = extensions.getExtension<GitExtension>("vscode.git");
    if (ext) {
      this.attachToGitApi(ext);
    } else {
      this.startFallback();
    }
  }

  private attachToGitApi(ext: import("vscode").Extension<GitExtension>): void {
    const bind = () => {
      try {
        this.bindApi(ext.exports.getAPI(1));
      } catch {
        // The API surface may not be available — fall back to FS watchers.
        this.startFallback();
      }
    };
    if (ext.isActive) {
      bind();
    } else {
      ext.activate().then(bind, () => this.startFallback());
    }
  }

  private bindApi(api: API): void {
    const init = () => {
      for (const r of api.repositories) this.attachRepo(r);
    };
    if (api.state === "initialized") {
      init();
    } else {
      this.disposables.push(api.onDidChangeState((s) => s === "initialized" && init()));
    }
    this.disposables.push(api.onDidOpenRepository((r) => this.attachRepo(r)));
    this.disposables.push(
      api.onDidCloseRepository((r) => this.detachRepo(r.rootUri.fsPath)),
    );
  }

  private attachRepo(repo: Repository): void {
    const root = repo.rootUri.fsPath;
    // If a fallback FS watcher had been started for this root (because we
    // discovered the repo before vscode.git opened it), shut it down — the
    // API gives us better signals.
    const fallback = this.fallbackWatchers.get(root);
    if (fallback) {
      fallback.dispose();
      this.fallbackWatchers.delete(root);
    }
    let priorHead = repo.state.HEAD?.commit;
    const info = repoInfoFromVscode(repo);
    this.repos.set(root, info);

    const sub = repo.state.onDidChange(() => {
      const newHead = repo.state.HEAD?.commit;
      const headChanged = newHead !== priorHead;
      const updated = repoInfoFromVscode(repo);
      this.repos.set(root, updated);
      this._onDidChange.fire({ repo: updated, headChanged });
      if (headChanged) {
        priorHead = newHead;
        this._onDidCommit.fire(updated);
      }
    });
    this.disposables.push(sub);
    // Fire one initial signal so consumers get a known-good baseline.
    this._onDidChange.fire({ repo: info, headChanged: false });
  }

  private detachRepo(root: string): void {
    this.repos.delete(root);
    const w = this.fallbackWatchers.get(root);
    if (w) {
      w.dispose();
      this.fallbackWatchers.delete(root);
    }
  }

  /** Resolve the repo for a file URI; uses the API cache first, walks up if needed. */
  async repoFor(uri: Uri): Promise<RepoInfo | null> {
    let best: RepoInfo | null = null;
    let bestLen = -1;
    for (const repo of this.repos.values()) {
      const root = repo.workingTreeRoot;
      if (
        uri.fsPath === root ||
        uri.fsPath.startsWith(root + sep)
      ) {
        if (root.length > bestLen) {
          best = repo;
          bestLen = root.length;
        }
      }
    }
    if (best) return best;
    // Fallback: discover by walking up. Set up a fallback FS watcher too.
    const discovered = await discoverRepoFromFile(uri);
    if (discovered) {
      this.repos.set(discovered.workingTreeRoot, discovered);
      this.startFallbackForRepo(discovered);
    }
    return discovered;
  }

  /** Start a basic FS watcher when the vscode.git API isn't there at all. */
  private startFallback(): void {
    // Watch every workspace folder root for `.git` appearing/changing.
    const folders = workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      // Try to resolve a repo per folder via discovery on activation.
      void discoverRepoFromFile(folder.uri).then((info) => {
        if (info) {
          this.repos.set(info.workingTreeRoot, info);
          this.startFallbackForRepo(info);
          this._onDidChange.fire({ repo: info, headChanged: false });
        }
      });
    }
    this.disposables.push(
      workspace.onDidChangeWorkspaceFolders(() => {
        for (const folder of workspace.workspaceFolders ?? []) {
          if (!Array.from(this.repos.keys()).some((r) => folder.uri.fsPath.startsWith(r))) {
            void discoverRepoFromFile(folder.uri).then((info) => {
              if (info) {
                this.repos.set(info.workingTreeRoot, info);
                this.startFallbackForRepo(info);
              }
            });
          }
        }
      }),
    );
  }

  private startFallbackForRepo(info: RepoInfo): void {
    if (this.fallbackWatchers.has(info.workingTreeRoot)) return;
    const subs: Disposable[] = [];
    const watch = (rel: string) => {
      const w = workspace.createFileSystemWatcher(
        new RelativePattern(info.workingTreeRoot, rel),
      );
      const fire = () => {
        // Could be HEAD change, ref change, index change. We can't cheaply
        // tell which without reading more, so we report `headChanged: true`
        // conservatively — consumers that only care about HEAD should
        // double-check with `git rev-parse HEAD`.
        this._onDidChange.fire({ repo: info, headChanged: true });
      };
      subs.push(w.onDidChange(fire), w.onDidCreate(fire), w.onDidDelete(fire), w);
    };
    watch(".git/HEAD");
    watch(".git/index");
    watch(".git/packed-refs");
    watch(".git/MERGE_HEAD");
    watch(".git/CHERRY_PICK_HEAD");
    watch(".git/refs/**");
    watch(".git/worktrees/**/HEAD");

    this.fallbackWatchers.set(info.workingTreeRoot, {
      dispose: () => subs.forEach((s) => s.dispose()),
    });
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    for (const w of this.fallbackWatchers.values()) w.dispose();
    this.fallbackWatchers.clear();
    this._onDidChange.dispose();
    this._onDidCommit.dispose();
  }
}

const sep = process.platform === "win32" ? "\\" : "/";
