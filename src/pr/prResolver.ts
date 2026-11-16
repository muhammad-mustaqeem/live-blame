// PRResolver — turn a remote URL + commit message into a PR/MR/commit URL.
//
// Pure functions. No network calls. We detect the host from the remote URL
// (origin's fetchUrl) and parse the commit message subject for a PR ref:
//
//   - GitHub default merge:   "Merge pull request #123 from foo/bar"
//   - GitHub squash:           "Subject (#123)"
//   - GitLab MR squash:        "Subject (!123)"
//   - Conventional manual:     "fix(#123): subject"  -> we accept "#123"
//
// We pick the *last* such reference in the subject (squash style) so that
// "Revert #100 (#123)" returns 123, the actual revert commit's PR.

export interface RemoteHost {
  kind: "github" | "gitlab" | "bitbucket" | "azure" | "unknown";
  /** Web base URL for browse links, e.g. "https://github.com/o/r". */
  webBase: string;
}

export function parseRemote(remoteUrl: string | undefined): RemoteHost | null {
  if (!remoteUrl) return null;
  const url = remoteUrl.trim();

  // git@host:path  or  ssh://git@host/path  or  https://host/path[.git]
  let host: string;
  let path: string;
  const sshMatch = /^(?:ssh:\/\/)?(?:[^@]+@)?([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(url);
  const httpsMatch = /^https?:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  if (httpsMatch) {
    host = httpsMatch[1];
    path = httpsMatch[2];
  } else if (sshMatch) {
    host = sshMatch[1];
    path = sshMatch[2];
  } else {
    return null;
  }

  const lowerHost = host.toLowerCase();
  if (lowerHost === "github.com" || lowerHost.endsWith(".github.com")) {
    return { kind: "github", webBase: `https://${host}/${path}` };
  }
  if (lowerHost === "gitlab.com" || lowerHost.includes("gitlab")) {
    return { kind: "gitlab", webBase: `https://${host}/${path}` };
  }
  if (lowerHost === "bitbucket.org" || lowerHost.includes("bitbucket")) {
    return { kind: "bitbucket", webBase: `https://${host}/${path}` };
  }
  if (lowerHost.includes("dev.azure.com") || lowerHost.includes("visualstudio.com")) {
    return { kind: "azure", webBase: `https://${host}/${path}` };
  }
  return { kind: "unknown", webBase: `https://${host}/${path}` };
}

export interface ResolvedLinks {
  commitUrl: string | null;
  prUrl: string | null;
  prLabel: string | null;
}

export function resolveLinks(
  remote: RemoteHost | null,
  sha: string,
  commitSummary: string,
): ResolvedLinks {
  if (!remote) return { commitUrl: null, prUrl: null, prLabel: null };

  const commitUrl = buildCommitUrl(remote, sha);
  const prInfo = extractPrRef(commitSummary, remote.kind);
  const prUrl = prInfo ? buildPrUrl(remote, prInfo.kind, prInfo.number) : null;
  const prLabel = prInfo ? prLabelFor(remote.kind, prInfo) : null;
  return { commitUrl, prUrl, prLabel };
}

function buildCommitUrl(remote: RemoteHost, sha: string): string {
  switch (remote.kind) {
    case "github":
    case "gitlab":
      return `${remote.webBase}/commit/${sha}`;
    case "bitbucket":
      return `${remote.webBase}/commits/${sha}`;
    case "azure":
      return `${remote.webBase}/commit/${sha}`;
    default:
      return `${remote.webBase}/commit/${sha}`;
  }
}

interface PrRef {
  /** "pr" for #N (GitHub/Bitbucket/Azure), "mr" for !N (GitLab). */
  kind: "pr" | "mr";
  number: number;
}

function extractPrRef(summary: string, host: RemoteHost["kind"]): PrRef | null {
  // GitLab squash uses "!123"; everywhere else uses "#123".
  // We also accept the GitHub merge-commit form "Merge pull request #123".
  const refs: PrRef[] = [];
  const re = /(?:^|\s|\()(?:#(\d+)|!(\d+))(?=\b|\)|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(summary)) !== null) {
    if (m[1]) refs.push({ kind: "pr", number: parseInt(m[1], 10) });
    if (m[2]) refs.push({ kind: "mr", number: parseInt(m[2], 10) });
  }
  // Prefer the *last* match (squash style: "subject (#123)").
  if (refs.length === 0) return null;
  // For GitHub-style "Merge pull request #N from ..." prefer the first match.
  if (/^Merge pull request #\d+/.test(summary)) {
    return refs[0];
  }
  // Filter by host if it really doesn't match the convention.
  if (host === "gitlab") {
    const mrs = refs.filter((r) => r.kind === "mr");
    if (mrs.length > 0) return mrs[mrs.length - 1];
  }
  if (host === "github" || host === "bitbucket" || host === "azure") {
    const prs = refs.filter((r) => r.kind === "pr");
    if (prs.length > 0) return prs[prs.length - 1];
  }
  return refs[refs.length - 1];
}

function buildPrUrl(remote: RemoteHost, kind: "pr" | "mr", n: number): string {
  switch (remote.kind) {
    case "github":
      return `${remote.webBase}/pull/${n}`;
    case "gitlab":
      return `${remote.webBase}/-/merge_requests/${n}`;
    case "bitbucket":
      return `${remote.webBase}/pull-requests/${n}`;
    case "azure":
      return `${remote.webBase}/pullrequest/${n}`;
    default:
      return `${remote.webBase}/${kind === "mr" ? "merge_requests" : "pull"}/${n}`;
  }
}

function prLabelFor(host: RemoteHost["kind"], ref: PrRef): string {
  if (host === "gitlab" || ref.kind === "mr") return `MR !${ref.number}`;
  return `PR #${ref.number}`;
}
