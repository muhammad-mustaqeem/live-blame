// Live Blame — entry point. Wires the engine, repo subscriber, renderer,
// hover provider, time-travel controller, and commands together. All
// disposables go on context.subscriptions so the host cleans up correctly on
// uninstall / reload.

import {
  ConfigurationChangeEvent,
  Disposable,
  ExtensionContext,
  TextDocument,
  TextDocumentChangeEvent,
  TextEditor,
  TextEditorSelectionChangeEvent,
  Uri,
  commands,
  env,
  languages,
  window,
  workspace,
} from "vscode";
import { BlameEngine, EngineConfig, ResolvedBlame } from "./engine/blameEngine.js";
import { CommitDetailService } from "./engine/commitDetails.js";
import { isUncommitted } from "./engine/incrementalParser.js";
import { RepoSubscriber } from "./repo/repoSubscriber.js";
import { RepoInfo, isBinaryFile } from "./repo/repoUtils.js";
import { Renderer } from "./ui/renderer.js";
import { BlameHoverProvider } from "./ui/blameHoverProvider.js";
import { renderInline } from "./ui/format.js";
import { parseRemote, resolveLinks } from "./pr/prResolver.js";
import {
  REV_SCHEME,
  RevisionContentProvider,
  parseRevUri,
} from "./timetravel/revisionProvider.js";
import { TimeTravelController } from "./timetravel/timeTravelController.js";

const CONFIG_NS = "liveBlame";
const SEP = process.platform === "win32" ? "\\" : "/";

interface Settings {
  enabled: boolean;
  format: string;
  uncommittedFormat: string;
  delay: number;
  maxLines: number;
  maxFileSizeBytes: number;
  largeFileLines: number;
  showOnAllLines: boolean;
  showPRLink: boolean;
  processPoolSize: number;
  hoverEnabled: boolean;
  hoverShowDiff: boolean;
  hoverDiffMaxLines: number;
  commitPickerLimit: number;
}

function readSettings(): Settings {
  const c = workspace.getConfiguration(CONFIG_NS);
  return {
    enabled: c.get<boolean>("enabled", true),
    format: c.get<string>("format", "${author}, ${ago} • ${summary}"),
    uncommittedFormat: c.get<string>("uncommittedFormat", "You, uncommitted"),
    delay: c.get<number>("delay", 500),
    maxLines: c.get<number>("maxLines", 50000),
    maxFileSizeBytes: c.get<number>("maxFileSizeBytes", 5_242_880),
    largeFileLines: c.get<number>("largeFileLines", 10000),
    showOnAllLines: c.get<boolean>("showOnAllLines", false),
    showPRLink: c.get<boolean>("showPRLink", true),
    processPoolSize: c.get<number>("processPoolSize", 4),
    hoverEnabled: c.get<boolean>("hover.enabled", true),
    hoverShowDiff: c.get<boolean>("hover.showDiff", true),
    hoverDiffMaxLines: c.get<number>("hover.diffMaxLines", 40),
    commitPickerLimit: c.get<number>("timeTravel.commitPickerLimit", 50),
  };
}

/** A blame target: a live working-tree file, or a historical revision view. */
type Target =
  | { kind: "live"; repo: RepoInfo }
  | { kind: "rev"; root: string; relpath: string; rev: string };

export function activate(context: ExtensionContext): void {
  const subs: Disposable[] = [];
  let settings = readSettings();

  const engineConfig: EngineConfig = {
    largeFileLines: settings.largeFileLines,
    maxLines: settings.maxLines,
    maxFileSizeBytes: settings.maxFileSizeBytes,
    poolSize: settings.processPoolSize,
  };
  const engine = new BlameEngine(engineConfig);
  const pool = engine.getProcessPool();
  const details = new CommitDetailService(pool);

  const repoSub = new RepoSubscriber();
  subs.push(repoSub);

  const renderer = new Renderer({
    buildInlineText(blame) {
      const editor = window.activeTextEditor;
      const remote = editor ? parseRemote(remoteUrlForEditor(editor)) : null;
      const links = resolveLinks(remote, blame.commit.sha, blame.commit.summary);
      return renderInline(blame.commit, blame.uncommitted, {
        template: settings.format,
        uncommittedTemplate: settings.uncommittedFormat,
        prText: settings.showPRLink ? links.prLabel ?? "" : "",
      });
    },
  });
  subs.push(renderer);

  // Historical content provider + rich hover provider.
  subs.push(
    workspace.registerTextDocumentContentProvider(
      REV_SCHEME,
      new RevisionContentProvider(pool),
    ),
  );
  const hoverProvider = new BlameHoverProvider({
    engine,
    repoSub,
    details,
    getSettings: () => ({
      enabled: settings.enabled,
      hoverEnabled: settings.hoverEnabled,
      showDiff: settings.hoverShowDiff,
      diffMaxLines: settings.hoverDiffMaxLines,
      showPR: settings.showPRLink,
    }),
  });
  subs.push(
    languages.registerHoverProvider(
      [{ scheme: "file" }, { scheme: "vscode-remote" }, { scheme: REV_SCHEME }],
      hoverProvider,
    ),
  );

  // Time-travel controller (commands + status bar + context key).
  const timeTravel = new TimeTravelController({
    engine,
    repoSub,
    pool,
    getCommitPickerLimit: () => settings.commitPickerLimit,
  });
  subs.push(timeTravel);
  subs.push(...timeTravel.register());

  // Per-doc request id. Bump on any trigger so async results from outdated
  // requests are dropped.
  const requestIds = new Map<string, number>();
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  // Cache of (rootPath -> remote URL) so we don't shell out per render.
  const remoteUrlCache = new Map<string, string | undefined>();

  // ----- Helpers ---------------------------------------------------------

  function remoteUrlForEditor(editor: TextEditor): string | undefined {
    const uri = editor.document.uri;
    if (uri.scheme === REV_SCHEME) {
      const t = parseRevUri(uri);
      return t ? remoteUrlCache.get(t.root) : undefined;
    }
    for (const [root, url] of remoteUrlCache) {
      if (uri.fsPath === root || uri.fsPath.startsWith(root + SEP)) {
        return url;
      }
    }
    return undefined;
  }

  function stableKey(doc: TextDocument): string {
    return doc.uri.toString();
  }

  function cancel(key: string): void {
    const t = debounceTimers.get(key);
    if (t) {
      clearTimeout(t);
      debounceTimers.delete(key);
    }
  }

  async function shouldSkip(doc: TextDocument): Promise<boolean> {
    if (!settings.enabled) return true;
    const scheme = doc.uri.scheme;
    // Historical docs are text produced by git — always blame-able.
    if (scheme === REV_SCHEME) return false;
    if (scheme !== "file" && scheme !== "vscode-remote") return true;
    if (doc.isUntitled) return true;
    if (await isBinaryFile(doc.uri)) return true;
    return false;
  }

  async function resolveTarget(doc: TextDocument): Promise<Target | null> {
    if (doc.uri.scheme === REV_SCHEME) {
      const t = parseRevUri(doc.uri);
      return t
        ? { kind: "rev", root: t.root, relpath: t.relpath, rev: t.rev }
        : null;
    }
    const repo = await repoSub.repoFor(doc.uri);
    if (!repo) return null;
    if (repo.remoteUrl !== undefined) {
      remoteUrlCache.set(repo.workingTreeRoot, repo.remoteUrl);
    }
    return { kind: "live", repo };
  }

  function resolveAt(
    doc: TextDocument,
    target: Target,
    line0: number,
  ): Promise<ResolvedBlame | null> {
    if (target.kind === "live") {
      return engine.resolve(doc, target.repo, line0);
    }
    return engine.resolveAtRevision(
      doc,
      target.root,
      target.relpath,
      target.rev,
      line0,
    );
  }

  function scheduleRender(editor: TextEditor, opts: { immediate?: boolean } = {}): void {
    const key = stableKey(editor.document);
    cancel(key);
    const id = (requestIds.get(key) ?? 0) + 1;
    requestIds.set(key, id);

    const run = () => doRender(editor, id).catch(() => {});
    if (opts.immediate) {
      run();
    } else {
      debounceTimers.set(key, setTimeout(run, settings.delay));
    }
  }

  async function doRender(editor: TextEditor, requestId: number): Promise<void> {
    const doc = editor.document;
    const key = stableKey(doc);
    if (requestIds.get(key) !== requestId) return;
    if (await shouldSkip(doc)) {
      renderer.clear(editor);
      return;
    }
    if (requestIds.get(key) !== requestId) return;

    const target = await resolveTarget(doc);
    if (!target) {
      renderer.clear(editor);
      return;
    }
    if (requestIds.get(key) !== requestId) return;

    // showOnAllLines uses one spawn (buffer mode) to produce N lines of
    // decorations from cache. For single-line mode we fall back to the cursor
    // line — running N spawns would thrash git.
    if (settings.showOnAllLines && engine.pickMode(doc) === "buffer") {
      const visible = editor.visibleRanges[0];
      if (!visible) return;
      const items: Array<{ line0: number; blame: ResolvedBlame }> = [];
      for (let line = visible.start.line; line <= visible.end.line; line++) {
        const blame = await resolveAt(doc, target, line);
        if (blame) items.push({ line0: line, blame });
        if (requestIds.get(key) !== requestId) return;
      }
      renderer.renderAll(editor, items);
    } else {
      const line0 = editor.selection.active.line;
      const blame = await resolveAt(doc, target, line0);
      if (requestIds.get(key) !== requestId) return;
      if (!blame) {
        renderer.clear(editor);
        return;
      }
      renderer.renderLine(editor, line0, blame);
    }
  }

  // ----- Event wiring ----------------------------------------------------

  subs.push(
    window.onDidChangeActiveTextEditor((editor) => {
      for (const e of window.visibleTextEditors) {
        if (e !== editor) renderer.clear(e);
      }
      if (editor) scheduleRender(editor, { immediate: true });
    }),
  );

  subs.push(
    window.onDidChangeTextEditorSelection((e: TextEditorSelectionChangeEvent) => {
      scheduleRender(e.textEditor);
    }),
  );

  subs.push(
    workspace.onDidChangeTextDocument((e: TextDocumentChangeEvent) => {
      const editor = window.visibleTextEditors.find(
        (ed) => ed.document === e.document,
      );
      if (!editor) return;
      // Update large-file LineMap for this doc, then clear + re-blame.
      engine.lineMapFor(e.document.uri.toString()).applyChanges(e.contentChanges);
      renderer.clear(editor);
      scheduleRender(editor);
    }),
  );

  subs.push(
    workspace.onDidSaveTextDocument((doc) => {
      engine.resetLineMap(doc.uri.toString());
      const editor = window.visibleTextEditors.find((e) => e.document === doc);
      if (editor) scheduleRender(editor);
    }),
  );

  subs.push(
    workspace.onDidCloseTextDocument((doc) => {
      const key = doc.uri.toString();
      cancel(key);
      requestIds.delete(key);
      engine.forgetDocument(key, doc.uri.fsPath);
    }),
  );

  // Repo invalidation — subscribe before start() so we don't miss the initial
  // onDidChange that fires when existing repositories are attached.
  subs.push(
    repoSub.onDidChange(({ repo, headChanged }) => {
      if (repo.remoteUrl !== undefined) {
        remoteUrlCache.set(repo.workingTreeRoot, repo.remoteUrl);
      }
      if (headChanged) {
        engine.invalidateFile(repo.workingTreeRoot);
        for (const editor of window.visibleTextEditors) {
          if (editor.document.uri.fsPath.startsWith(repo.workingTreeRoot)) {
            scheduleRender(editor, { immediate: true });
          }
        }
      }
    }),
  );
  subs.push(
    repoSub.onDidCommit(() => {
      engine.clearAll();
      details.clear();
      for (const editor of window.visibleTextEditors) {
        scheduleRender(editor, { immediate: true });
      }
    }),
  );
  repoSub.start();

  // Configuration change.
  subs.push(
    workspace.onDidChangeConfiguration((e: ConfigurationChangeEvent) => {
      if (!e.affectsConfiguration(CONFIG_NS)) return;
      settings = readSettings();
      engine.updateConfig({
        largeFileLines: settings.largeFileLines,
        maxLines: settings.maxLines,
        maxFileSizeBytes: settings.maxFileSizeBytes,
        poolSize: settings.processPoolSize,
      });
      if (!settings.enabled) {
        renderer.clearAll();
      } else {
        for (const editor of window.visibleTextEditors) {
          scheduleRender(editor, { immediate: true });
        }
      }
    }),
  );

  // Commands.
  subs.push(
    commands.registerCommand("liveBlame.toggle", async () => {
      const c = workspace.getConfiguration(CONFIG_NS);
      const current = c.get<boolean>("enabled", true);
      await c.update("enabled", !current, true);
    }),
    commands.registerCommand("liveBlame.copyHash", async (sha?: string) => {
      if (!sha) return;
      await env.clipboard.writeText(sha);
    }),
    commands.registerCommand("liveBlame.openCommit", async (sha?: string) => {
      if (!sha || isUncommitted(sha)) return;
      const editor = window.activeTextEditor;
      if (!editor) return;
      const remote = parseRemote(remoteUrlForEditor(editor));
      const links = resolveLinks(remote, sha, "");
      if (links.commitUrl) {
        await env.openExternal(Uri.parse(links.commitUrl));
      }
    }),
    commands.registerCommand("liveBlame.openPR", async () => {
      const editor = window.activeTextEditor;
      if (!editor) return;
      const target = await resolveTarget(editor.document);
      if (!target) return;
      const line0 = editor.selection.active.line;
      const blame = await resolveAt(editor.document, target, line0);
      if (!blame) return;
      const remote = parseRemote(remoteUrlForEditor(editor));
      const links = resolveLinks(remote, blame.commit.sha, blame.commit.summary);
      if (links.prUrl) {
        await env.openExternal(Uri.parse(links.prUrl));
      } else if (links.commitUrl) {
        await env.openExternal(Uri.parse(links.commitUrl));
      }
    }),
    commands.registerCommand("liveBlame.clearCache", () => {
      engine.clearAll();
      details.clear();
      for (const editor of window.visibleTextEditors) {
        scheduleRender(editor, { immediate: true });
      }
    }),
  );

  // Initial render for whatever's open.
  if (window.activeTextEditor) {
    scheduleRender(window.activeTextEditor, { immediate: true });
  }

  context.subscriptions.push(...subs);
}

export function deactivate(): void {
  // All cleanup runs via context.subscriptions disposal.
}
