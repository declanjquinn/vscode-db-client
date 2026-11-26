import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

/** One result tab as the webview sees it. Cells are display text; null is SQL NULL. */
export interface GridSet {
  title: string;
  fields: string[];
  rows: (string | null)[][];
  /** Why the grid cannot be edited; undefined when it can. */
  readOnly?: string;
  /** Columns that cannot be edited (binary data). */
  roCols: boolean[];
}

/** The Result Grid: a webview view in the bottom panel. */
export class ResultsView implements vscode.WebviewViewProvider {
  private media: vscode.Uri;
  private view?: vscode.WebviewView;
  private sets: GridSet[] = [];
  onMessage: (m: any) => void = () => {};
  constructor(media: vscode.Uri) { this.media = media; }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const w = view.webview, nonce = randomBytes(16).toString('hex');
    const uri = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.media, f));
    w.options = { enableScripts: true, localResourceRoots: [this.media] };
    w.html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}'">
<link rel="stylesheet" href="${uri('grid.css')}"><title>Result Grid</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${uri('grid.js')}"></script></body></html>`;
    w.onDidReceiveMessage(m => (m?.type === 'ready' ? w.postMessage({ type: 'sets', sets: this.sets }) : this.onMessage(m)));
    view.onDidDispose(() => { this.view = undefined; });
  }

  /** Replace all result tabs and bring the grid into view without taking focus from the editor. */
  async show(sets: GridSet[]) {
    this.sets = sets;
    if (this.view) {
      this.view.show(true);
      this.view.webview.postMessage({ type: 'sets', sets });
    } else {
      // First use: opening the view loads the webview, which asks for the sets with 'ready'.
      await vscode.commands.executeCommand('dbClient.results.focus');
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }
  }
  /** Replace one tab, e.g. after its edits were applied. */
  replace(index: number, set: GridSet) {
    this.sets[index] = set;
    this.view?.webview.postMessage({ type: 'set', index, set });
  }
}

interface Entry { n: number; time: string; sql: string; message: string; ms: number; ok: boolean }

/** The Action Output list: one line per executed statement. */
export class ActionOutput implements vscode.TreeDataProvider<Entry> {
  private entries: Entry[] = [];
  private n = 0;
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  view?: vscode.TreeView<Entry>;

  add(sql: string, message: string, ms: number, ok: boolean) {
    const e: Entry = { n: ++this.n, time: new Date().toLocaleTimeString([], { hour12: false }), sql, message, ms, ok };
    this.entries.push(e);
    this.emitter.fire();
    // Scroll to the newest line. Only when visible, or a failure would steal the panel while the user types.
    if (this.view?.visible) this.view.reveal(e, { select: false, focus: false }).then(undefined, () => {});
  }
  clear() { this.entries = []; this.emitter.fire(); }

  getTreeItem(e: Entry): vscode.TreeItem {
    const line = e.sql.replace(/\s+/g, ' ');
    const it = new vscode.TreeItem(`${e.n}  ${e.time}  ${line.length > 60 ? line.slice(0, 60) + '…' : line}`);
    it.description = `${e.message.replace(/\s+/g, ' ')}  ·  ${(e.ms / 1000).toFixed(3)} sec`;
    it.tooltip = `${e.sql}\n\n${e.message}`;
    it.iconPath = e.ok
      ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
      : new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    return it;
  }
  getChildren(e?: Entry) { return e ? [] : this.entries; }
  getParent() { return undefined; }
}
