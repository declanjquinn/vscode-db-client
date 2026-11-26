// Pure helpers: no vscode or driver imports, so `node --test` can run them directly.

export type Dialect = 'mysql' | 'postgres';
export interface Statement { text: string; start: number; end: number }
export interface EditTarget { schema: string; table: string; columns: string[]; pk: string[] }
/** Pending grid edits, keyed by row index then column index. Comes from the webview, so it is validated. */
export interface Changes {
  updates: Record<string, Record<string, string | null>>;
  inserts: Record<string, string | null>[];
  deletes: number[];
}
export interface Edit { sql: string; params: unknown[] }

const DOLLAR = /\$([A-Za-z_][A-Za-z_0-9]*)?\$/y;

// shortcut: no DELIMITER support, add when stored-procedure authoring is needed
export function splitStatements(sql: string, dialect: Dialect): Statement[] {
  const my = dialect === 'mysql', n = sql.length, out: Statement[] = [];
  let i = 0, start = 0, code = false; // code: the segment holds something besides comments and whitespace
  const push = (end: number) => {
    if (code) {
      const raw = sql.slice(start, end), text = raw.trim(), from = start + raw.length - raw.trimStart().length;
      out.push({ text, start: from, end: from + text.length });
    }
    start = end + 1;
    code = false;
  };
  while (i < n) {
    const c = sql[i];
    if (c === ';') { push(i++); continue; }
    // MySQL only treats `--` as a comment when whitespace follows; `#` is an operator in PostgreSQL.
    if ((c === '-' && sql[i + 1] === '-' && (!my || /^\s?$/.test(sql[i + 2] ?? ''))) || (my && c === '#')) {
      const e = sql.indexOf('\n', i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      if (sql[i + 2] === '!') code = true; // MySQL executable comment
      const e = sql.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === "'" || c === '"' || (my && c === '`')) {
      // Backslash escapes: MySQL strings, and PostgreSQL only in E'...' strings.
      const esc = c !== '`' && (my || (c === "'" && /(^|[^\w$])e$/i.test(sql.slice(Math.max(0, i - 2), i))));
      code = true;
      for (i++; i < n && sql[i] !== c; i++) if (esc && sql[i] === '\\') i++;
      i++;
      continue;
    }
    if (!my && c === '$' && !/[\w$]/.test(sql[i - 1] ?? '')) {
      DOLLAR.lastIndex = i;
      const tag = DOLLAR.exec(sql)?.[0];
      if (tag) {
        code = true;
        const e = sql.indexOf(tag, i + tag.length);
        i = e < 0 ? n : e + tag.length;
        continue;
      }
    }
    if (!/\s/.test(c)) code = true;
    i++;
  }
  push(n);
  return out;
}

/** The statement the cursor is in or directly after; otherwise the next one. */
export const statementAt = (stmts: Statement[], offset: number): Statement | undefined =>
  stmts.find(s => offset <= s.end + 1) ?? stmts.at(-1);

const LEADING = /^(\s|--[^\n]*(\n|$)|#[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)*/;

/** A statement that only reads: safe to add LIMIT to, and safe to re-run after applying grid edits. */
export function isSelect(stmt: string): boolean {
  const s = stmt.replace(LEADING, '');
  if (/\binto\b/i.test(s)) return false;
  return /^select\b/i.test(s) || (/^with\b/i.test(s) && !/\b(insert|update|delete|merge)\b/i.test(s));
}

// shortcut: keyword check, not a parser. A LIMIT inside a subquery or string means no outer LIMIT is added;
// upgrade to a tokenizer if unlimited results become a problem.
export function applyLimit(stmt: string, limit: number): string {
  if (limit <= 0 || !isSelect(stmt)) return stmt;
  if (/\b(limit|fetch\s+(first|next)|for\s+(update|share|no\s+key|key\s+share)|lock\s+in)\b/i.test(stmt)) return stmt;
  return `${stmt}\nLIMIT ${limit}`; // newline: the statement may end in a `--` comment
}

/** Turn grid changes into parameterised statements. `rows` are the original result rows, used for the WHERE. */
export function buildEdits(
  t: EditTarget, rows: unknown[][], ch: Changes, quote: (id: string) => string, ph: (i: number) => string,
): Edit[] {
  const table = `${quote(t.schema)}.${quote(t.table)}`;
  const col = (k: string) => {
    const name = t.columns[Number(k)];
    if (name === undefined) throw new Error(`Invalid column index ${k}`);
    return quote(name);
  };
  const val = (v: unknown) => {
    if (v !== null && typeof v !== 'string') throw new Error('Invalid cell value');
    return v;
  };
  const where = (i: number, from: number) => {
    const row = rows[i];
    if (!row) throw new Error(`Invalid row index ${i}`);
    return {
      sql: t.pk.map((k, j) => `${quote(k)} = ${ph(from + j)}`).join(' AND '),
      params: t.pk.map(k => row[t.columns.indexOf(k)]),
    };
  };
  const out: Edit[] = [], deleted = new Set(ch.deletes);
  for (const i of deleted) {
    const w = where(i, 1);
    out.push({ sql: `DELETE FROM ${table} WHERE ${w.sql}`, params: w.params });
  }
  for (const [i, cells] of Object.entries(ch.updates)) {
    const keys = Object.keys(cells);
    if (deleted.has(Number(i)) || !keys.length) continue;
    const w = where(Number(i), keys.length + 1);
    const set = keys.map((k, j) => `${col(k)} = ${ph(j + 1)}`).join(', ');
    out.push({ sql: `UPDATE ${table} SET ${set} WHERE ${w.sql}`, params: [...keys.map(k => val(cells[k])), ...w.params] });
  }
  for (const cells of ch.inserts) {
    const keys = Object.keys(cells);
    if (!keys.length) continue;
    out.push({
      sql: `INSERT INTO ${table} (${keys.map(col).join(', ')}) VALUES (${keys.map((_, j) => ph(j + 1)).join(', ')})`,
      params: keys.map(k => val(cells[k])),
    });
  }
  return out;
}

/** A database value as grid text. null stays null so the grid can show a NULL badge. */
export const show = (v: unknown): string | null =>
  v == null ? null
  : Buffer.isBuffer(v) ? (v.length <= 64 ? '0x' + v.toString('hex') : `BLOB (${v.length} bytes)`)
  : typeof v === 'object' ? JSON.stringify(v)
  : String(v);

export const toCsv = (rows: (string | null)[][]): string =>
  rows.map(r => r.map(v => (v == null ? '' : /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\r\n');
