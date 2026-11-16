// Pure formatters. No vscode imports — keeps this trivially testable.

import { CommitMeta } from "../engine/incrementalParser.js";

const SECONDS = 1;
const MINUTE = 60 * SECONDS;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

export function relativeTime(epochSeconds: number, nowSeconds: number = Math.floor(Date.now() / 1000)): string {
  const delta = Math.max(0, nowSeconds - epochSeconds);
  if (delta < 5) return "just now";
  if (delta < MINUTE) return `${delta} seconds ago`;
  if (delta < 2 * MINUTE) return "a minute ago";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} minutes ago`;
  if (delta < 2 * HOUR) return "an hour ago";
  if (delta < DAY) return `${Math.floor(delta / HOUR)} hours ago`;
  if (delta < 2 * DAY) return "yesterday";
  if (delta < WEEK) return `${Math.floor(delta / DAY)} days ago`;
  if (delta < 2 * WEEK) return "a week ago";
  if (delta < MONTH) return `${Math.floor(delta / WEEK)} weeks ago`;
  if (delta < 2 * MONTH) return "a month ago";
  if (delta < YEAR) return `${Math.floor(delta / MONTH)} months ago`;
  if (delta < 2 * YEAR) return "a year ago";
  return `${Math.floor(delta / YEAR)} years ago`;
}

export function shortHash(sha: string): string {
  return sha.length >= 7 ? sha.slice(0, 7) : sha;
}

export function formatAbsoluteDate(epochSeconds: number): string {
  // ISO date in UTC; we don't try to be locale-aware to keep behavior stable.
  const d = new Date(epochSeconds * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export interface FormatContext {
  template: string;
  uncommittedTemplate: string;
  prText?: string; // already-built "PR #123" string from PRResolver
}

/**
 * Apply the user's template to a commit. Tokens:
 *   ${author}, ${authorEmail}, ${ago}, ${date}, ${summary}, ${hash}, ${pr}
 */
export function renderInline(
  meta: CommitMeta,
  uncommitted: boolean,
  ctx: FormatContext,
): string {
  if (uncommitted) return ctx.uncommittedTemplate;
  const tokens: Record<string, string> = {
    author: meta.author,
    authorEmail: meta.authorEmail,
    ago: relativeTime(meta.authorTime),
    date: formatAbsoluteDate(meta.authorTime),
    summary: truncate(meta.summary, 80),
    hash: shortHash(meta.sha),
    pr: ctx.prText ?? "",
  };
  return ctx.template.replace(/\$\{(\w+)\}/g, (_, k: string) =>
    Object.prototype.hasOwnProperty.call(tokens, k) ? tokens[k] : "",
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
