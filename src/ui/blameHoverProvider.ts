// BlameHoverProvider — a registered HoverProvider that produces the rich
// blame hover lazily (only when the user actually hovers), so the expensive
// commit-detail / diff lookups never touch the cursor-move hot path.
//
// Works for live files (file / vscode-remote) and historical time-travel docs
// (liveblame-rev). Hover fires on ANY line, not just the cursor line. The
// hover's CancellationToken is linked to an AbortController so moving the mouse
// away kills any in-flight git processes.

import {
  CancellationToken,
  Hover,
  HoverProvider,
  Position,
  ProviderResult,
  TextDocument,
  Uri,
} from "vscode";
import * as path from "node:path";
import { BlameEngine, ResolvedBlame } from "../engine/blameEngine.js";
import { CommitDetailService, IntroHunk } from "../engine/commitDetails.js";
import { isUncommitted } from "../engine/incrementalParser.js";
import { RepoSubscriber } from "../repo/repoSubscriber.js";
import { parseRemote, resolveLinks } from "../pr/prResolver.js";
import { REV_SCHEME, parseRevUri } from "../timetravel/revisionProvider.js";
import { buildHover } from "./hoverProvider.js";

export interface HoverSettings {
  enabled: boolean;
  hoverEnabled: boolean;
  showDiff: boolean;
  diffMaxLines: number;
  showPR: boolean;
}

export interface HoverDeps {
  engine: BlameEngine;
  repoSub: RepoSubscriber;
  details: CommitDetailService;
  getSettings(): HoverSettings;
}

export class BlameHoverProvider implements HoverProvider {
  constructor(private deps: HoverDeps) {}

  provideHover(
    document: TextDocument,
    position: Position,
    token: CancellationToken,
  ): ProviderResult<Hover> {
    return this.compute(document, position, token);
  }

  private async compute(
    document: TextDocument,
    position: Position,
    token: CancellationToken,
  ): Promise<Hover | undefined> {
    const s = this.deps.getSettings();
    if (!s.enabled || !s.hoverEnabled) return undefined;

    try {
      const resolved = await this.resolveTarget(document, position.line);
      if (!resolved) return undefined;
      if (token.isCancellationRequested) return undefined;
      const { blame, repoRoot, remoteUrl } = resolved;

      const range = document.lineAt(position.line).range;

      if (blame.uncommitted || isUncommitted(blame.commit.sha)) {
        return new Hover(
          buildHover(blame, { commitUrl: null, prUrl: null, prLabel: null }),
          range,
        );
      }

      const ac = new AbortController();
      const reg = token.onCancellationRequested(() => ac.abort());
      try {
        const detail = await this.deps.details.getDetail(
          repoRoot,
          blame.commit.sha,
          ac.signal,
        );
        let hunk: IntroHunk | null = null;
        if (s.showDiff && blame.commit.filename) {
          hunk = await this.deps.details.getIntroHunk(
            repoRoot,
            blame.commit.sha,
            blame.commit.filename,
            blame.line.sourceLine,
            s.diffMaxLines,
            ac.signal,
          );
        }
        if (token.isCancellationRequested) return undefined;

        const remote = parseRemote(remoteUrl);
        const links = resolveLinks(remote, blame.commit.sha, blame.commit.summary);
        return new Hover(
          buildHover(blame, {
            commitUrl: links.commitUrl,
            prUrl: s.showPR ? links.prUrl : null,
            prLabel: s.showPR ? links.prLabel : null,
            detail,
            hunk,
            showDiff: s.showDiff,
          }),
          range,
        );
      } finally {
        reg.dispose();
      }
    } catch {
      return undefined;
    }
  }

  /** Resolve blame + repo context for the hovered line (live or historical). */
  private async resolveTarget(
    document: TextDocument,
    line0: number,
  ): Promise<{ blame: ResolvedBlame; repoRoot: string; remoteUrl?: string } | null> {
    const scheme = document.uri.scheme;

    if (scheme === REV_SCHEME) {
      const t = parseRevUri(document.uri);
      if (!t) return null;
      const blame = await this.deps.engine.resolveAtRevision(
        document,
        t.root,
        t.relpath,
        t.rev,
        line0,
      );
      if (!blame) return null;
      const repo = await this.deps.repoSub.repoFor(
        Uri.file(path.join(t.root, t.relpath)),
      );
      return { blame, repoRoot: t.root, remoteUrl: repo?.remoteUrl };
    }

    if (scheme === "file" || scheme === "vscode-remote") {
      if (document.isUntitled) return null;
      const repo = await this.deps.repoSub.repoFor(document.uri);
      if (!repo) return null;
      const blame = await this.deps.engine.resolve(document, repo, line0);
      if (!blame) return null;
      return { blame, repoRoot: repo.workingTreeRoot, remoteUrl: repo.remoteUrl };
    }

    return null;
  }
}
