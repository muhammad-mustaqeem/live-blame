// Minimal type surface for the built-in vscode.git extension API.
// Mirrors microsoft/vscode/extensions/git/src/api/git.d.ts (subset we use).

import type { Event, Uri } from "vscode";

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): API;
}

export interface API {
  readonly state: "uninitialized" | "initialized";
  readonly onDidChangeState: Event<"uninitialized" | "initialized">;
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
  readonly ui: { readonly selected: boolean };
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly refs: Ref[];
  readonly remotes: Remote[];
  readonly indexChanges: Change[];
  readonly workingTreeChanges: Change[];
  readonly onDidChange: Event<void>;
}

export interface Branch {
  readonly name?: string;
  readonly commit?: string;
  readonly upstream?: { remote: string; name: string };
  readonly type: number;
}

export interface Ref {
  readonly type: number;
  readonly name?: string;
  readonly commit?: string;
}

export interface Remote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
  readonly isReadOnly: boolean;
}

export interface Change {
  readonly uri: Uri;
  readonly originalUri: Uri;
  readonly renameUri: Uri | undefined;
  readonly status: number;
}

