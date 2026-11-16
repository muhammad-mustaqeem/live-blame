// Composes the rich hover MarkdownString for a blame line.
//
// Pure composition: given a ResolvedBlame plus optional commit detail and the
// introducing diff hunk, returns the markdown. The async fetching lives in
// BlameHoverProvider — this file has no I/O so it stays easy to reason about.

import { MarkdownString, Uri } from "vscode";
import { ResolvedBlame } from "../engine/blameEngine.js";
import { CommitDetail, IntroHunk } from "../engine/commitDetails.js";
import { formatAbsoluteDate, relativeTime, shortHash } from "./format.js";
import { isUncommitted } from "../engine/incrementalParser.js";

export interface HoverContext {
  /** Commit URL on the remote, or null. */
  commitUrl: string | null;
  /** Full PR/MR URL, or null. */
  prUrl: string | null;
  /** Display label like "PR #123", or null. */
  prLabel: string | null;
  /** Commit body / co-authors / stats. Null/undefined when unavailable. */
  detail?: CommitDetail | null;
  /** The diff hunk that introduced this line. Null/undefined when unavailable. */
  hunk?: IntroHunk | null;
  /** Whether to render the diff hunk at all. */
  showDiff?: boolean;
}

export function buildHover(
  blame: ResolvedBlame,
  ctx: HoverContext,
): MarkdownString {
  const md = new MarkdownString();
  md.isTrusted = true;
  md.supportHtml = false;

  if (isUncommitted(blame.commit.sha) || blame.uncommitted) {
    md.appendMarkdown(
      `**Uncommitted changes**\n\n_You haven't committed this line yet._`,
    );
    return md;
  }

  const c = blame.commit;
  const ago = relativeTime(c.authorTime);
  const date = formatAbsoluteDate(c.authorTime);
  const hash = shortHash(c.sha);

  // Header: author + email + relative time.
  md.appendMarkdown(
    `**${escapeMd(c.author)}**${
      c.authorEmail ? ` &lt;${escapeMd(c.authorEmail)}&gt;` : ""
    } · ${ago}\n\n`,
  );

  // Subject (first line of the commit message).
  const subject = ctx.detail?.subject || c.summary;
  if (subject) {
    md.appendMarkdown(`**${escapeMd(subject)}**\n\n`);
  }

  // Body, rendered as a blockquote so it reads as prose.
  if (ctx.detail?.body) {
    const quoted = ctx.detail.body
      .split("\n")
      .map((l) => `> ${escapeMd(l)}`)
      .join("\n");
    md.appendMarkdown(`${quoted}\n\n`);
  }

  // Co-authors.
  if (ctx.detail?.coAuthors && ctx.detail.coAuthors.length > 0) {
    const names = ctx.detail.coAuthors.map((a) => escapeMd(a)).join(", ");
    md.appendMarkdown(`_Co-authored by ${names}_\n\n`);
  }

  // Stats.
  if (ctx.detail && ctx.detail.filesChanged > 0) {
    const fileWord = ctx.detail.filesChanged === 1 ? "file" : "files";
    md.appendMarkdown(
      `${ctx.detail.filesChanged} ${fileWord} changed · +${ctx.detail.insertions} -${ctx.detail.deletions}\n\n`,
    );
  }

  // Introducing diff hunk.
  if (ctx.showDiff && ctx.hunk && ctx.hunk.diff) {
    md.appendCodeblock(ctx.hunk.diff, "diff");
    if (ctx.hunk.truncated) md.appendMarkdown(`\n_…diff truncated_\n`);
    md.appendMarkdown("\n");
  }

  md.appendMarkdown("\n---\n\n");

  // Action row: hash, copy, open, optional PR, date.
  const copyArgs = encodeURIComponent(JSON.stringify([c.sha]));
  const openCommitArgs = encodeURIComponent(JSON.stringify([c.sha]));
  const parts: string[] = [];
  if (ctx.commitUrl) {
    parts.push(`[\`${hash}\`](${ctx.commitUrl} "Open commit on remote")`);
  } else {
    parts.push(`\`${hash}\``);
  }
  parts.push(`[Copy](command:liveBlame.copyHash?${copyArgs} "Copy full hash")`);
  parts.push(
    `[Open](command:liveBlame.openCommit?${openCommitArgs} "Open commit")`,
  );
  if (ctx.prLabel && ctx.prUrl) {
    parts.push(`[${ctx.prLabel}](${ctx.prUrl} "Open pull request")`);
  }
  parts.push(date);
  md.appendMarkdown(parts.join(" · "));

  return md;
}

function escapeMd(s: string): string {
  return s.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}

export function uriOrNull(s: string | null): Uri | null {
  if (!s) return null;
  try {
    return Uri.parse(s);
  } catch {
    return null;
  }
}
