import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { open, schemas, tables, columns } from './drivers.ts';
import type { ConnConfig, Driver, Column } from './drivers.ts';

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Saved connections (globalState), their passwords (SecretStorage) and their open sessions. */
export class Connections {
  private ctx: vscode.ExtensionContext;
  private sessions = new Map<string, Promise<Driver>>();
  private changed = new vscode.EventEmitter<void>();
  readonly onChange = this.changed.event;
  /** Current default schema per connection id. */
  readonly defaults = new Map<string, string | undefined>();
  /** Per connection, bumped whenever its session ends, so the tree shows it collapsed instead of reconnecting. */
  readonly epochs = new Map<string, number>();
  constructor(ctx: vscode.ExtensionContext) { this.ctx = ctx; }

  list(): ConnConfig[] { return this.ctx.globalState.get<ConnConfig[]>('connections', []); }
  get active(): ConnConfig | undefined {
    const id = this.ctx.globalState.get<string>('active');
    return this.list().find(c => c.id === id);
  }
  async setActive(cfg: ConnConfig) {
    await this.ctx.globalState.update('active', cfg.id);
    this.changed.fire();
  }
  isOpen(id: string) { return this.sessions.has(id); }

  /** The long-lived session for a connection, opened on first use. */
  driver(cfg: ConnConfig): Promise<Driver> {
    let p = this.sessions.get(cfg.id);
    if (!p) {
      const mine: Promise<Driver> = this.fresh(cfg, () => this.drop(cfg.id, mine));
      p = mine;
      this.sessions.set(cfg.id, p);
      // A failed connect is forgotten quietly: firing a change would make the tree retry in a loop.
      p.then(d => this.syncSchema(cfg, d, true), () => { if (this.sessions.get(cfg.id) === mine) this.sessions.delete(cfg.id); });
    }
    return p;
  }
  /** A separate connection, e.g. for applying grid edits in their own transaction. */
  async fresh(cfg: ConnConfig, onLost?: () => void): Promise<Driver> {
    return open(cfg, (await this.ctx.secrets.get(secretKey(cfg.id))) ?? '', onLost);
  }
  private drop(id: string, p: Promise<Driver>) {
    if (this.sessions.get(id) !== p) return;
    this.sessions.delete(id);
    this.defaults.delete(id);
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    this.changed.fire();
  }
  /** Re-read the default schema (the user may have run USE / SET search_path). */
  async syncSchema(cfg: ConnConfig, d?: Driver, force = false) {
    d ??= await this.driver(cfg);
    const s = await d.currentSchema().catch(() => undefined);
    if (!force && this.defaults.get(cfg.id) === s) return;
    this.defaults.set(cfg.id, s);
    this.changed.fire();
  }
  async disconnect(id: string) {
    const p = this.sessions.get(id);
    if (!p) return;
    this.drop(id, p);
    await (await p.catch(() => undefined))?.close();
  }
  async save(cfg: ConnConfig, password?: string) {
    await this.disconnect(cfg.id);
    const list = this.list(), i = list.findIndex(c => c.id === cfg.id);
    if (i < 0) list.push(cfg); else list[i] = cfg;
    await this.ctx.globalState.update('connections', list);
    if (password !== undefined) await this.ctx.secrets.store(secretKey(cfg.id), password);
    this.changed.fire();
  }
  async remove(cfg: ConnConfig) {
    await this.disconnect(cfg.id);
    await this.ctx.globalState.update('connections', this.list().filter(c => c.id !== cfg.id));
    await this.ctx.secrets.delete(secretKey(cfg.id));
    this.changed.fire();
  }
}
const secretKey = (id: string) => `dbClient.password.${id}`;

/** Ask for connection details step by step. Returns undefined if the user escapes any step. */
export async function promptConnection(old?: ConnConfig): Promise<{ cfg: ConnConfig; password?: string } | undefined> {
  const ask = (prompt: string, value: string, extra: vscode.InputBoxOptions = {}) =>
    vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true, ...extra });
  const engine = old?.engine ?? (await vscode.window.showQuickPick(
    [{ label: 'MySQL', engine: 'mysql' as const }, { label: 'PostgreSQL', engine: 'postgres' as const }],
    { placeHolder: 'Database engine', ignoreFocusOut: true }))?.engine;
  if (!engine) return;
  const my = engine === 'mysql';
  const name = await ask('Connection name', old?.name ?? '', { validateInput: v => (v.trim() ? undefined : 'Enter a name') });
  if (!name) return;
  const host = await ask('Host', old?.host ?? '127.0.0.1');
  if (!host) return;
  const port = await ask('Port', String(old?.port ?? (my ? 3306 : 5432)), {
    validateInput: v => (/^\d+$/.test(v) && +v > 0 && +v < 65536 ? undefined : 'Enter a port number'),
  });
  if (!port) return;
  const user = await ask('User', old?.user ?? (my ? 'root' : 'postgres'));
  if (!user) return;
  const password = await ask(old ? 'Password (leave empty to keep the saved one)' : 'Password', '', { password: true });
  if (password === undefined) return;
  const database = await ask(my ? 'Default schema (optional)' : 'Database (empty = same as the user name)', old?.database ?? '');
  if (database === undefined) return;
  const ssl = await vscode.window.showQuickPick(['No', 'Yes'], { placeHolder: 'Use SSL? (the server certificate is verified)', ignoreFocusOut: true });
  if (!ssl) return;
  return {
    cfg: { id: old?.id ?? randomUUID(), name: name.trim(), engine, host: host.trim(), port: +port, user, database: database.trim() || undefined, ssl: ssl === 'Yes' },
    password: old && !password ? undefined : password,
  };
}

export type Node =
  | { kind: 'connection'; cfg: ConnConfig }
  | { kind: 'schema'; cfg: ConnConfig; schema: string }
  | { kind: 'folder'; cfg: ConnConfig; schema: string; views: boolean }
  | { kind: 'table'; cfg: ConnConfig; schema: string; table: string; view: boolean }
  | { kind: 'column'; column: Column };

function columnItem(c: Column): vscode.TreeItem {
  const it = new vscode.TreeItem(c.name);
  it.description = c.type + (c.pk ? ' PK' : '');
  it.iconPath = new vscode.ThemeIcon(c.pk ? 'key' : 'symbol-field');
  return it;
}

/** The SCHEMAS tree: connection > schema > Tables/Views > table > columns. */
export class Navigator implements vscode.TreeDataProvider<Node> {
  private conns: Connections;
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(conns: Connections) {
    this.conns = conns;
    conns.onChange(() => this.refresh());
  }
  refresh() { this.emitter.fire(); }

  getTreeItem(n: Node): vscode.TreeItem {
    const { Collapsed } = vscode.TreeItemCollapsibleState;
    switch (n.kind) {
      case 'connection': {
        const on = this.conns.isOpen(n.cfg.id), active = this.conns.active?.id === n.cfg.id;
        const it = new vscode.TreeItem(n.cfg.name, Collapsed);
        it.id = `${n.cfg.id}:${this.conns.epochs.get(n.cfg.id) ?? 0}`;
        it.description = `${n.cfg.engine} · ${n.cfg.host}:${n.cfg.port}${active ? ' · active' : ''}`;
        it.iconPath = new vscode.ThemeIcon('server', on ? new vscode.ThemeColor('charts.green') : undefined);
        it.tooltip = on ? 'Connected' : 'Not connected. Expand to connect.';
        it.contextValue = 'connection';
        return it;
      }
      case 'schema': {
        // Workbench shows the default schema in bold; a full-label highlight is the tree's equivalent.
        const isDefault = this.conns.defaults.get(n.cfg.id) === n.schema;
        const it = new vscode.TreeItem({ label: n.schema, highlights: isDefault ? [[0, n.schema.length]] : [] }, Collapsed);
        it.description = isDefault ? 'default' : undefined;
        it.iconPath = new vscode.ThemeIcon('database');
        it.contextValue = 'schema';
        return it;
      }
      case 'folder': {
        const it = new vscode.TreeItem(n.views ? 'Views' : 'Tables', Collapsed);
        it.iconPath = vscode.ThemeIcon.Folder;
        return it;
      }
      case 'table': {
        const it = new vscode.TreeItem(n.table, Collapsed);
        it.iconPath = new vscode.ThemeIcon(n.view ? 'eye' : 'table');
        it.contextValue = 'table';
        return it;
      }
      case 'column': return columnItem(n.column);
    }
  }

  async getChildren(n?: Node): Promise<Node[]> {
    if (!n) return this.conns.list().map(cfg => ({ kind: 'connection', cfg }));
    if (n.kind === 'column') return [];
    if (n.kind === 'schema') return [false, true].map(views => ({ kind: 'folder', cfg: n.cfg, schema: n.schema, views }));
    const { cfg } = n;
    try {
      const d = await this.conns.driver(cfg);
      if (n.kind === 'connection') return (await schemas(d)).map(schema => ({ kind: 'schema', cfg, schema }));
      if (n.kind === 'folder') {
        return (await tables(d, n.schema)).filter(t => t.view === n.views)
          .map(t => ({ kind: 'table', cfg, schema: n.schema, table: t.name, view: t.view }));
      }
      return (await columns(d, n.schema, n.table)).map(column => ({ kind: 'column', column }));
    } catch (e) {
      vscode.window.showErrorMessage(`${cfg.name}: ${errText(e)}`);
      return [];
    }
  }
}

/** The Object Info pane: columns of the table selected in the navigator. */
export class ObjectInfo implements vscode.TreeDataProvider<Column> {
  private cols: Column[] = [];
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  set(cols: Column[]) { this.cols = cols; this.emitter.fire(); }
  getTreeItem = columnItem;
  getChildren(c?: Column) { return c ? [] : this.cols; }
}
