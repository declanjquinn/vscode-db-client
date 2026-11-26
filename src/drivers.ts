// Database access for both engines. No vscode import, so `node --test` can run it against real databases.
import mysql from 'mysql2/promise';
import pg from 'pg';
import type { Edit, EditTarget } from './sql.ts';

export interface ConnConfig {
  id: string; name: string; engine: 'mysql' | 'postgres';
  host: string; port: number; user: string; database?: string; ssl?: boolean;
}
/** Rows are arrays (not objects) so two columns with the same name both survive, e.g. `SELECT *` over a JOIN. */
export interface Result { fields: string[]; raw: unknown[]; rows: unknown[][]; affected?: number }
export interface Column { name: string; type: string; pk: boolean }
type Source = { schema: string; table: string; columns: string[] };

export interface Driver {
  /** Schemas the navigator hides. */
  readonly hidden: RegExp;
  /** SQL expression over information_schema.columns giving a readable type. */
  readonly typeExpr: string;
  query(sql: string, params?: unknown[]): Promise<Result>;
  setSchema(name: string): Promise<void>;
  currentSchema(): Promise<string | undefined>;
  /** Stop the running query from a second connection. */
  cancel(): Promise<void>;
  /** The one table every result column comes from, or undefined. `raw` is Result.raw. */
  source(raw: unknown[]): Promise<Source | undefined>;
  quoteId(name: string): string;
  /** Placeholder for the i-th parameter (1-based). */
  ph(i: number): string;
  close(): Promise<void>;
}

class MySql implements Driver {
  readonly hidden = /^(information_schema|mysql|performance_schema|sys)$/;
  readonly typeExpr = 'column_type';
  private c: mysql.Connection;
  private opts: mysql.ConnectionOptions;
  constructor(c: mysql.Connection, opts: mysql.ConnectionOptions) { this.c = c; this.opts = opts; }

  async query(sql: string, params: unknown[] = []): Promise<Result> {
    let [r, f] = (await this.c.query(sql, params.length ? params : undefined)) as [any, any];
    if (Array.isArray(f) && Array.isArray(f[0])) [r, f] = [r[0], f[0]]; // shortcut: CALL shows only its first result set
    return Array.isArray(r)
      ? { fields: f.map((x: any) => x.name), raw: f, rows: r }
      : { fields: [], raw: [], rows: [], affected: r.affectedRows };
  }
  async setSchema(name: string) { await this.c.query('USE ' + this.quoteId(name)); }
  async currentSchema() { return ((await this.query('SELECT DATABASE()')).rows[0]?.[0] ?? undefined) as string | undefined; }
  async cancel() {
    const k = await mysql.createConnection(this.opts);
    try { await k.query(`KILL QUERY ${Number(this.c.threadId)}`); } finally { k.destroy(); }
  }
  async source(raw: unknown[]): Promise<Source | undefined> {
    const f = raw as { schema?: string; db?: string; orgTable?: string; orgName?: string }[];
    const schema = f[0]?.schema ?? f[0]?.db, table = f[0]?.orgTable;
    if (!schema || !table || f.some(x => (x.schema ?? x.db) !== schema || x.orgTable !== table || !x.orgName)) return;
    return { schema, table, columns: f.map(x => x.orgName!) };
  }
  quoteId(name: string) { return '`' + name.replace(/`/g, '``') + '`'; }
  ph() { return '?'; }
  async close() { this.c.destroy(); }
}

class Pg implements Driver {
  readonly hidden = /^(information_schema|pg_.*)$/;
  readonly typeExpr = "CASE WHEN character_maximum_length IS NULL THEN data_type ELSE data_type || '(' || character_maximum_length || ')' END";
  private c: pg.Client;
  private opts: pg.ClientConfig;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(c: pg.Client, opts: pg.ClientConfig) { this.c = c; this.opts = opts; }

  // pg deprecates overlapping client.query() calls, so run them one at a time.
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => {});
    return p;
  }
  query(sql: string, params: unknown[] = []): Promise<Result> {
    return this.lock(async () => {
      // No values => simple protocol, which is what ad-hoc SQL needs (e.g. VACUUM, several statements).
      const r: any = await this.c.query({ text: sql, values: params.length ? params : undefined, rowMode: 'array' });
      const one = Array.isArray(r) ? r.at(-1) : r;
      return one.fields.length
        ? { fields: one.fields.map((x: any) => x.name), raw: one.fields, rows: one.rows }
        : { fields: [], raw: [], rows: [], affected: one.rowCount ?? undefined };
    });
  }
  async setSchema(name: string) { await this.query(`SET search_path TO ${this.quoteId(name)}, public`); }
  async currentSchema() { return ((await this.query('SELECT current_schema()')).rows[0]?.[0] ?? undefined) as string | undefined; }
  async cancel() {
    const k = new pg.Client(this.opts);
    k.on('error', () => {});
    await k.connect();
    try { await k.query('SELECT pg_cancel_backend($1)', [(this.c as any).processID]); } finally { await k.end(); }
  }
  async source(raw: unknown[]): Promise<Source | undefined> {
    const f = raw as { tableID: number; columnID: number }[];
    const oid = f[0]?.tableID;
    if (!oid || f.some(x => x.tableID !== oid || !x.columnID)) return;
    const r = await this.query(
      `SELECT n.nspname, c.relname, a.attnum, a.attname FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE a.attrelid = $1 AND a.attnum > 0`, [oid]);
    if (!r.rows.length) return;
    const names = new Map(r.rows.map(x => [Number(x[2]), String(x[3])]));
    return { schema: String(r.rows[0][0]), table: String(r.rows[0][1]), columns: f.map(x => names.get(x.columnID)!) };
  }
  quoteId(name: string) { return '"' + name.replace(/"/g, '""') + '"'; }
  ph(i: number) { return '$' + i; }
  async close() { await this.c.end().catch(() => {}); }
}

/** Open a session. `onLost` fires if the connection drops later, so the caller can forget it. */
export async function open(cfg: ConnConfig, password: string, onLost: () => void = () => {}): Promise<Driver> {
  const base = { host: cfg.host, port: cfg.port, user: cfg.user, password, database: cfg.database || undefined };
  // shortcut: SSL always verifies the server certificate, add a CA-file option when a self-signed server needs it
  if (cfg.engine === 'mysql') {
    // Values stay as the server sent them: no Date conversion, no precision loss on BIGINT/DECIMAL.
    const opts: mysql.ConnectionOptions = {
      ...base, ssl: cfg.ssl ? {} : undefined, rowsAsArray: true, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    };
    const c = await mysql.createConnection(opts);
    c.on('error', onLost); // without a listener a dropped connection would crash the extension host
    return new MySql(c, opts);
  }
  const opts: pg.ClientConfig = {
    ...base, ssl: cfg.ssl || undefined, connectionTimeoutMillis: 10_000,
    types: { getTypeParser: () => (v: unknown) => v } as any, // raw text for every type
  };
  const c = new pg.Client(opts);
  c.on('error', onLost);
  await c.connect();
  return new Pg(c, opts);
}

// --- Metadata: information_schema is the same on both engines, so these are shared. ---

const strings = (r: Result) => r.rows.map(x => String(x[0]));

export async function schemas(d: Driver): Promise<string[]> {
  return strings(await d.query('SELECT schema_name FROM information_schema.schemata ORDER BY schema_name')).filter(n => !d.hidden.test(n));
}

export async function tables(d: Driver, schema: string): Promise<{ name: string; view: boolean }[]> {
  const r = await d.query(`SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = ${d.ph(1)} ORDER BY table_name`, [schema]);
  return r.rows.map(x => ({ name: String(x[0]), view: String(x[1]).includes('VIEW') }));
}

export async function primaryKey(d: Driver, schema: string, table: string): Promise<string[]> {
  return strings(await d.query(
    `SELECT k.column_name FROM information_schema.table_constraints c
     JOIN information_schema.key_column_usage k ON k.constraint_schema = c.constraint_schema
       AND k.constraint_name = c.constraint_name AND k.table_schema = c.table_schema AND k.table_name = c.table_name
     WHERE c.constraint_type = 'PRIMARY KEY' AND c.table_schema = ${d.ph(1)} AND c.table_name = ${d.ph(2)}
     ORDER BY k.ordinal_position`, [schema, table]));
}

export async function columns(d: Driver, schema: string, table: string): Promise<Column[]> {
  const r = await d.query(
    `SELECT column_name, ${d.typeExpr} FROM information_schema.columns
     WHERE table_schema = ${d.ph(1)} AND table_name = ${d.ph(2)} ORDER BY ordinal_position`, [schema, table]);
  const pk = await primaryKey(d, schema, table);
  return r.rows.map(x => ({ name: String(x[0]), type: String(x[1]), pk: pk.includes(String(x[0])) }));
}

/** Where grid edits for this result would be written, or the reason it is read-only. */
export async function editTarget(d: Driver, raw: unknown[]): Promise<EditTarget | string> {
  const src = await d.source(raw);
  if (!src) return 'Read only: the result is not made of plain columns from a single table.';
  const pk = await primaryKey(d, src.schema, src.table);
  if (!pk.length) return `Read only: ${src.table} has no primary key.`;
  if (!pk.every(k => src.columns.includes(k))) return `Read only: the result does not include the primary key (${pk.join(', ')}).`;
  return { ...src, pk };
}

/** Run edits in one transaction on `d` (a dedicated connection), then close it. All or nothing. */
export async function applyEdits(d: Driver, edits: Edit[]): Promise<void> {
  try {
    await d.query('BEGIN');
    for (const e of edits) {
      const { affected } = await d.query(e.sql, e.params);
      // The WHERE is a full primary key, so anything but 1 means the row changed or vanished underneath us.
      if (affected !== 1) throw new Error(`Rolled back: expected 1 row but ${affected ?? 0} were affected by\n${e.sql}`);
    }
    await d.query('COMMIT');
  } catch (e) {
    await d.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await d.close();
  }
}
