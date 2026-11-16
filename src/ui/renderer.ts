// Renderer — owns the inline decoration lifecycle.
//
// Design notes:
//
//  * One *shared* TextEditorDecorationType across all editors. setDecorations
//    is per-editor, so we can still vary the inline text per editor.
//  * The "anchor at end of line" trick: a Range of (line, 2^30-1, line, 2^30-1)
//    forces VS Code to render `after.contentText` at the end of the line,
//    regardless of line length. Same trick GitLens uses.
//  * Per-editor pending state — a debounce timer + an active "request id"
//    so we ignore stale results when the cursor moved on or content changed.
//  * Cleared on:
//      - Active editor change (clear the *prior* editor)
//      - Document close
//      - Selection change while typing (avoid stale info during edits)

import {
  DecorationOptions,
  DecorationRangeBehavior,
  Disposable,
  Range,
  TextEditor,
  TextEditorDecorationType,
  ThemeColor,
  window,
} from "vscode";
import { ResolvedBlame } from "../engine/blameEngine.js";
import { REV_SCHEME } from "../timetravel/revisionProvider.js";

const EOL_COL = 0x40000000; // 2^30 — well beyond any realistic line length

export interface RendererHooks {
  buildInlineText(blame: ResolvedBlame): string;
}

export class Renderer implements Disposable {
  private decoType: TextEditorDecorationType;
  private cleared = new WeakSet<TextEditor>();

  constructor(private hooks: RendererHooks) {
    this.decoType = window.createTextEditorDecorationType({
      after: {
        margin: "0 0 0 3em",
        color: new ThemeColor("editorCodeLens.foreground"),
        fontStyle: "italic",
      },
      rangeBehavior: DecorationRangeBehavior.ClosedClosed,
      isWholeLine: false,
    });
  }

  /** Render blame on a single (cursor) line. */
  renderLine(editor: TextEditor, line0: number, blame: ResolvedBlame): void {
    if (!isLiveEditor(editor)) return;
    const inline = this.hooks.buildInlineText(blame);
    const range = new Range(line0, EOL_COL, line0, EOL_COL);
    const opt: DecorationOptions = {
      range,
      renderOptions: {
        after: { contentText: ` ${inline}` },
      },
    };
    editor.setDecorations(this.decoType, [opt]);
    this.cleared.delete(editor);
  }

  /** Render blame on every line in the visible range. */
  renderAll(
    editor: TextEditor,
    items: Array<{ line0: number; blame: ResolvedBlame }>,
  ): void {
    if (!isLiveEditor(editor)) return;
    const decos: DecorationOptions[] = items.map(({ line0, blame }) => ({
      range: new Range(line0, EOL_COL, line0, EOL_COL),
      renderOptions: {
        after: { contentText: ` ${this.hooks.buildInlineText(blame)}` },
      },
    }));
    editor.setDecorations(this.decoType, decos);
    this.cleared.delete(editor);
  }

  /** Clear all decorations on this editor. Idempotent. */
  clear(editor: TextEditor): void {
    if (this.cleared.has(editor)) return;
    if (!isLiveEditor(editor)) return;
    editor.setDecorations(this.decoType, []);
    this.cleared.add(editor);
  }

  /** Clear every visible editor (called on toggle off / disable). */
  clearAll(): void {
    for (const e of window.visibleTextEditors) {
      if (isLiveEditor(e)) e.setDecorations(this.decoType, []);
    }
  }

  dispose(): void {
    this.decoType.dispose();
  }
}

function isLiveEditor(editor: TextEditor): boolean {
  // Drop diff views, output channels, etc. We annotate "real" files plus the
  // read-only historical (time-travel) documents.
  const scheme = editor.document.uri.scheme;
  return (
    scheme === "file" || scheme === "vscode-remote" || scheme === REV_SCHEME
  );
}
