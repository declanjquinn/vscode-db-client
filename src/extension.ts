import * as vscode from 'vscode';
import { Connections, Navigator, ObjectInfo, promptConnection, errText } from './navigator.ts';
import type { Node } from './navigator.ts';
import { ResultsView, ActionOutput } from './results.ts';
import type { GridSet } from './results.ts';
import { columns, editTarget, applyEdits } from './drivers.ts';
import type { ConnConfig, Driver, Result } from './drivers.ts';
import { splitStatements, statementAt, applyLimit, isSelect, buildEdits, show, toCsv } from './sql.ts';
import type { EditTarget } from './sql.ts';

/** What the extension keeps for each result tab: the grid sent to the webview plus what edits need. */
interface Live { cfg: ConnConfig; sql: string; rows: unknown[][]; target?: EditTarget; grid: GridSet }

export function activate(ctx: vscode.ExtensionContext) {
  const conns = new Connections(ctx);
  const navigator = new Navigator(conns);
  const info = new ObjectInfo();
  const output = new ActionOutput();
  const results = new ResultsView(vscode.Uri.joinPath(ctx.extensionUri, 'media'));
  const navView = vscode.window.createTreeView('dbClient.navigator', { treeDataProvider: navigator });
  const infoView = vscode.window.createTreeView('dbClient.objectInfo', { treeDataProvider: info });
  output.view = vscode.window.createTreeView('dbClient.output', { treeDataProvider: output });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  status.command = 'dbClient.switchConnection';
  status.tooltip = 'DB Client: active connection and default schema. Click to switch.';

  let live: Live[] = [];
  let running: Driver | undefined;
  let dirty = false; // the grid has edits that were not applied

  const paint = () => {
    const a = conns.active, schema = a && conns.defaults.get(a.id);
    status.text = `$(database) ${a ? a.name + (schema ? ` · ${schema}` : '') : 'No connection'}`;
  };
  conns.onChange(paint);
  paint();
  status.show();

  const limit = () => vscode.workspace.getConfiguration('dbClient').get<number>('rowLimit', 1000);
  const confirm = async (message: string, action: string, detail?: string) =>
    (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
  const fail = (e: unknown, prefix = '') => void vscode.window.showErrorMessage(prefix + errText(e));

  async function pickConnection(): Promise<ConnConfig | undefined> {
    const list = conns.list();
    if (!list.length) {
      if (await vscode.window.showInformationMessage('No database connections yet.', 'Add Connection')) await addOrEdit();
      return conns.active;
    }
    const pick = await vscode.window.showQuickPick(
      list.map(cfg => ({ label: cfg.name, description: `${cfg.engine} · ${cfg.host}:${cfg.port}`, cfg })),
      { placeHolder: 'Connection to run SQL against' });
    if (pick) await conns.setActive(pick.cfg);
    return pick?.cfg;
  }

  async function addOrEdit(old?: ConnConfig) {
    const r = await promptConnection(old);
    if (!r) return;
    await conns.save(r.cfg, r.password);
    if (!conns.active) await conns.setActive(r.cfg);
  }

  async function toLive(cfg: ConnConfig, d: Driver, sql: string, r: Result, title: string): Promise<Live> {
    // Only plain SELECTs are editable: applying edits re-runs the statement, which must not repeat a write.
    const t = isSelect(sql) ? await editTarget(d, r.raw).catch(errText) : 'Read only: only results of a plain SELECT can be edited.';
    return {
      cfg, sql, rows: r.rows, target: typeof t === 'string' ? undefined : t,
      grid: {
        title, fields: r.fields, rows: r.rows.map(row => row.map(show)),
        readOnly: typeof t === 'string' ? t : undefined,
        roCols: r.fields.map((_, c) => r.rows.some(row => Buffer.isBuffer(row[c]))),
      },
    };
  }

  async function run(currentOnly: boolean) {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    if (running) return void vscode.window.showWarningMessage('A query is still running. Stop it first.');
    const cfg = conns.active ?? (await pickConnection());
    if (!cfg) return;
    const doc = ed.document, selected = !currentOnly && !ed.selection.isEmpty;
    const all = splitStatements(selected ? doc.getText(ed.selection) : doc.getText(), cfg.engine);
    const at = currentOnly ? statementAt(all, doc.offsetAt(ed.selection.active)) : undefined;
    const stmts = currentOnly ? (at ? [at] : []) : all;
    if (!stmts.length) return;
    if (dirty && !(await confirm('Discard the edits in the result grid that were not applied?', 'Discard'))) return;

    let d: Driver;
    try { d = await conns.driver(cfg); } catch (e) { return fail(e, `${cfg.name}: `); }
    running = d;
    vscode.commands.executeCommand('setContext', 'dbClient.running', true);
    const sets: Live[] = [];
    let error: string | undefined;
    try {
      for (const s of stmts) {
        const sql = applyLimit(s.text, limit()), t0 = performance.now();
        try {
          const r = await d.query(sql);
          const ms = performance.now() - t0;
          if (r.fields.length) {
            sets.push(await toLive(cfg, d, sql, r, `Result ${sets.length + 1}`));
            output.add(s.text, `${r.rows.length} row(s) returned`, ms, true);
          } else {
            output.add(s.text, r.affected === undefined ? 'OK' : `${r.affected} row(s) affected`, ms, true);
          }
        } catch (e) {
          error = errText(e);
          output.add(s.text, `Error: ${error}`, performance.now() - t0, false);
          break; // like Workbench: stop the script at the first failing statement
        }
      }
    } finally {
      running = undefined;
      vscode.commands.executeCommand('setContext', 'dbClient.running', false);
    }
    if (sets.length) {
      live = sets;
      dirty = false;
      await results.show(sets.map(s => s.grid));
    }
    if (error && !output.view?.visible) fail(error);
    conns.syncSchema(cfg).catch(() => {});
  }

  async function apply(index: number, changes: any) {
    const s = live[index];
    if (!s?.target) return;
    try {
      const d = await conns.driver(s.cfg);
      const edits = buildEdits(s.target, s.rows, changes, d.quoteId.bind(d), d.ph.bind(d));
      if (!edits.length) return;
      const preview = edits.slice(0, 12).map(e => `${e.sql}\n   ${JSON.stringify(e.params.map(show))}`).join('\n');
      const more = edits.length > 12 ? `\n… and ${edits.length - 12} more` : '';
      if (!(await confirm(`Apply ${edits.length} change(s) to ${s.target.table}?`, 'Apply', preview + more))) return;
      const t0 = performance.now();
      try {
        // Its own connection and transaction, so a transaction the user has open is never committed by this.
        await applyEdits(await conns.fresh(s.cfg), edits);
      } catch (e) {
        output.add(`Apply ${edits.length} change(s) to ${s.target.table}`, `Error: ${errText(e)}`, performance.now() - t0, false);
        throw e;
      }
      output.add(edits.map(e => e.sql).join(';\n'), `${edits.length} change(s) applied`, performance.now() - t0, true);
      live[index] = await toLive(s.cfg, d, s.sql, await d.query(s.sql), s.grid.title);
      results.replace(index, live[index].grid);
    } catch (e) {
      fail(e);
    }
  }

  async function exportCsv(index: number) {
    const g = live[index]?.grid;
    if (!g) return;
    const uri = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] }, saveLabel: 'Export' });
    if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(toCsv([g.fields, ...g.rows])));
  }

  results.onMessage = m => {
    if (m?.type === 'dirty') dirty = !!m.value;
    else if (m?.type === 'apply') apply(Number(m.set), m.changes);
    else if (m?.type === 'export') exportCsv(Number(m.set)).catch(fail);
  };

  navView.onDidChangeSelection(async e => {
    const n = e.selection[0];
    if (n?.kind !== 'table') return;
    try {
      info.set(await columns(await conns.driver(n.cfg), n.schema, n.table));
      infoView.title = `${n.view ? 'View' : 'Table'}: ${n.table}`;
    } catch (err) {
      fail(err);
    }
  });

  const commands: Record<string, (n: any) => unknown> = {
    addConnection: () => addOrEdit(),
    editConnection: (n: Node & { kind: 'connection' }) => addOrEdit(n.cfg),
    deleteConnection: async (n: Node & { kind: 'connection' }) => {
      if (await confirm(`Delete the connection "${n.cfg.name}"?`, 'Delete', 'Only the saved connection is removed. The database is not touched.')) await conns.remove(n.cfg);
    },
    disconnect: (n: Node & { kind: 'connection' }) => conns.disconnect(n.cfg.id),
    refresh: () => navigator.refresh(),
    switchConnection: () => pickConnection(),
    setDefaultSchema: async (n: Node & { kind: 'schema' }) => {
      await (await conns.driver(n.cfg)).setSchema(n.schema);
      await conns.setActive(n.cfg);
      await conns.syncSchema(n.cfg);
    },
    selectRows: async (n: Node & { kind: 'table' }) => {
      const d = await conns.driver(n.cfg);
      await conns.setActive(n.cfg);
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: `SELECT * FROM ${d.quoteId(n.schema)}.${d.quoteId(n.table)};\n` });
      await vscode.window.showTextDocument(doc);
      await run(false);
    },
    copyName: (n: Node & { kind: 'schema' | 'table' }) => vscode.env.clipboard.writeText(n.kind === 'table' ? n.table : n.schema),
    execute: () => run(false),
    executeCurrent: () => run(true),
    stop: () => running?.cancel(),
    setRowLimit: async () => {
      const pick = await vscode.window.showQuickPick(["Don't Limit", '10', '50', '100', '200', '500', '1000', '2000', '5000', '10000', '50000'],
        { placeHolder: `Limit rows returned by SELECT (now ${limit() || 'unlimited'})` });
      if (pick) await vscode.workspace.getConfiguration('dbClient').update('rowLimit', Number(pick) || 0, vscode.ConfigurationTarget.Global);
    },
    clearOutput: () => output.clear(),
  };
  for (const [id, fn] of Object.entries(commands)) {
    ctx.subscriptions.push(vscode.commands.registerCommand(`dbClient.${id}`, async (n: unknown) => {
      try { await fn(n); } catch (e) { fail(e); }
    }));
  }
  ctx.subscriptions.push(
    navView, infoView, output.view, status,
    vscode.window.registerWebviewViewProvider('dbClient.results', results, { webviewOptions: { retainContextWhenHidden: true } }),
  );
}
