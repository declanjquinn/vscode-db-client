import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitStatements, statementAt, isSelect, applyLimit, buildEdits, show, toCsv } from './sql.ts';

const texts = (sql: string, d: 'mysql' | 'postgres') => splitStatements(sql, d).map(s => s.text);

test('split: basics, offsets, comment-only tail dropped', () => {
  const sql = 'SELECT 1;\n  SELECT 2 ;\n-- done\n';
  const s = splitStatements(sql, 'mysql');
  assert.deepEqual(s.map(x => x.text), ['SELECT 1', 'SELECT 2']);
  assert.equal(sql.slice(s[1].start, s[1].end), 'SELECT 2');
});

test('split: semicolons inside strings, identifiers and comments', () => {
  assert.deepEqual(texts("SELECT 'a;b', \"c;d\", `e;f`; SELECT 2", 'mysql'), ["SELECT 'a;b', \"c;d\", `e;f`", 'SELECT 2']);
  assert.deepEqual(texts("SELECT 'it''s;'; SELECT 2", 'postgres'), ["SELECT 'it''s;'", 'SELECT 2']);
  assert.deepEqual(texts('SELECT 1 /* ; */ + 1; -- x;y\nSELECT 2', 'mysql'), ['SELECT 1 /* ; */ + 1', '-- x;y\nSELECT 2']);
});

test('split: dialect differences', () => {
  // backslash escapes a quote in MySQL, not in a standard PostgreSQL string
  assert.deepEqual(texts("SELECT 'a\\';b'; SELECT 2", 'mysql'), ["SELECT 'a\\';b'", 'SELECT 2']);
  assert.deepEqual(texts("SELECT 'a\\'; SELECT 2", 'postgres'), ["SELECT 'a\\'", 'SELECT 2']);
  assert.deepEqual(texts("SELECT E'a\\';b'; SELECT 2", 'postgres'), ["SELECT E'a\\';b'", 'SELECT 2']);
  // # is a comment in MySQL, an operator in PostgreSQL
  assert.deepEqual(texts('SELECT 1 # a;b\n; SELECT 2', 'mysql'), ['SELECT 1 # a;b', 'SELECT 2']);
  assert.deepEqual(texts("SELECT a #> '{b}'; SELECT 2", 'postgres'), ["SELECT a #> '{b}'", 'SELECT 2']);
  // MySQL needs whitespace after -- for it to be a comment
  assert.deepEqual(texts('SELECT 5--3; SELECT 2', 'mysql'), ['SELECT 5--3', 'SELECT 2']);
});

test('split: PostgreSQL dollar quoting', () => {
  const fn = 'CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql';
  assert.deepEqual(texts(`${fn}; SELECT $$a;b$$; SELECT $1`, 'postgres'), [fn, 'SELECT $$a;b$$', 'SELECT $1']);
});

test('statementAt: cursor inside, right after the semicolon, between, past the end', () => {
  const sql = 'SELECT 1;\n\nSELECT 2;\n';
  const s = splitStatements(sql, 'mysql');
  assert.equal(statementAt(s, 3)?.text, 'SELECT 1');
  assert.equal(statementAt(s, 9)?.text, 'SELECT 1'); // just after ;
  assert.equal(statementAt(s, 10)?.text, 'SELECT 2'); // blank line between
  assert.equal(statementAt(s, sql.length)?.text, 'SELECT 2');
  assert.equal(statementAt([], 0), undefined);
});

test('applyLimit', () => {
  assert.equal(applyLimit('SELECT * FROM t', 1000), 'SELECT * FROM t\nLIMIT 1000');
  assert.equal(applyLimit('-- note\n  select * from t -- tail', 5), '-- note\n  select * from t -- tail\nLIMIT 5');
  assert.equal(applyLimit('WITH x AS (SELECT 1) SELECT * FROM x', 5), 'WITH x AS (SELECT 1) SELECT * FROM x\nLIMIT 5');
  for (const untouched of [
    'SELECT * FROM t LIMIT 3',
    'SELECT * FROM t FOR UPDATE',
    'SELECT * INTO OUTFILE "/tmp/x" FROM t',
    'SELECT * FROM t FETCH FIRST 3 ROWS ONLY',
    'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x',
    'UPDATE t SET a = 1',
    'SHOW TABLES',
  ]) assert.equal(applyLimit(untouched, 1000), untouched);
  assert.equal(applyLimit('SELECT 1', 0), 'SELECT 1');
});

test('isSelect', () => {
  assert.ok(isSelect('/* c */ SELECT 1'));
  assert.ok(!isSelect('INSERT INTO t VALUES (1) RETURNING *'));
  assert.ok(!isSelect('SELECT * INTO backup FROM t'));
});

test('buildEdits: SQL, parameter order, composite key, validation', () => {
  const t = { schema: 's', table: 'we"ird', columns: ['a', 'b', 'name'], pk: ['a', 'b'] };
  const rows = [[1, 'x', 'old'], [2, 'y', 'gone'], [3, 'z', 'keep']];
  const q = (id: string) => `"${id.replace(/"/g, '""')}"`, ph = (i: number) => `$${i}`;
  const edits = buildEdits(t, rows, {
    updates: { 0: { 2: 'new', 1: null }, 1: { 2: 'ignored, row is deleted' } },
    inserts: [{ 0: '9', 2: 'nine' }, {}],
    deletes: [1],
  }, q, ph);
  assert.deepEqual(edits, [
    { sql: 'DELETE FROM "s"."we""ird" WHERE "a" = $1 AND "b" = $2', params: [2, 'y'] },
    { sql: 'UPDATE "s"."we""ird" SET "b" = $1, "name" = $2 WHERE "a" = $3 AND "b" = $4', params: [null, 'new', 1, 'x'] },
    { sql: 'INSERT INTO "s"."we""ird" ("a", "name") VALUES ($1, $2)', params: ['9', 'nine'] },
  ]);
  const none = { updates: {}, inserts: [], deletes: [] };
  assert.throws(() => buildEdits(t, rows, { ...none, deletes: [7] }, q, ph), /row/);
  assert.throws(() => buildEdits(t, rows, { ...none, updates: { 0: { 5: 'x' } } }, q, ph), /column/);
  assert.throws(() => buildEdits(t, rows, { ...none, inserts: [{ 0: 5 as never }] }, q, ph), /value/);
});

test('show and toCsv', () => {
  assert.equal(show(null), null);
  assert.equal(show(Buffer.from([1, 255])), '0x01ff');
  assert.equal(show(Buffer.alloc(100)), 'BLOB (100 bytes)');
  assert.equal(show({ a: 1 }), '{"a":1}');
  assert.equal(show(42n), '42');
  assert.equal(toCsv([['id', 'note'], ['1', 'say "hi", ok'], ['2', null], ['3', 'two\nlines']]),
    'id,note\r\n1,"say ""hi"", ok"\r\n2,\r\n3,"two\nlines"');
});
