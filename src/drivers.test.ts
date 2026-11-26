// Needs the databases from docker-compose.yml: `docker compose up -d`, then `npm run test:db`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { open, schemas, tables, columns, editTarget, applyEdits } from './drivers.ts';
import type { ConnConfig, Driver } from './drivers.ts';
import { buildEdits } from './sql.ts';
import type { Changes, EditTarget } from './sql.ts';

const configs: (ConnConfig & { schema: string; sleep: string })[] = [
  { id: 'm', name: 'mysql', engine: 'mysql', host: '127.0.0.1', port: 33306, user: 'root', schema: 'shop', sleep: 'SELECT SLEEP(20)' },
  { id: 'p', name: 'postgres', engine: 'postgres', host: '127.0.0.1', port: 55432, user: 'postgres', database: 'shop', schema: 'public', sleep: 'SELECT pg_sleep(20)' },
];
const none: Changes = { updates: {}, inserts: [], deletes: [] };

for (const cfg of configs) {
  const e = cfg.engine;
  let d: Driver;
  const connect = () => open(cfg, 'test');
  const target = async (sql: string) => editTarget(d, (await d.query(sql)).raw);
  const names = async () => (await d.query('SELECT name FROM customer ORDER BY id')).rows.map(r => r[0]);
  after(() => d?.close());

  test(`${e}: connect, default schema`, async () => {
    d = await connect();
    await d.setSchema(cfg.schema);
    assert.equal(await d.currentSchema(), cfg.schema);
    // later tests edit customer; reset it so the suite can be re-run
    await d.query('DELETE FROM customer');
    await d.query("INSERT INTO customer VALUES (1, 'Ada', NULL), (2, 'Grace', 'vip'), (3, 'Linus', NULL)");
  });

  test(`${e}: schemas, tables, views, columns`, async () => {
    const s = await schemas(d);
    assert.ok(s.includes(cfg.schema));
    assert.ok(!s.includes('information_schema'));
    assert.deepEqual(await tables(d, cfg.schema), [
      { name: 'big_orders', view: true }, { name: 'customer', view: false },
      { name: 'nopk', view: false }, { name: 'orders', view: false },
    ]);
    const cols = await columns(d, cfg.schema, 'customer');
    assert.deepEqual(cols.map(c => [c.name, c.pk]), [['id', true], ['name', false], ['note', false]]);
    assert.match(cols[1].type, /char.*\(255\)/);
  });

  test(`${e}: duplicate column names survive, values stay as text`, async () => {
    const r = await d.query('SELECT * FROM customer c JOIN orders o ON o.customer_id = c.id ORDER BY c.id');
    assert.deepEqual(r.fields, ['id', 'name', 'note', 'id', 'customer_id', 'total', 'created_at']);
    assert.deepEqual(r.rows[1], [2, 'Grace', 'vip', 2, 2, '250.50', '2025-01-02 11:00:00'].map((v, i) => (e === 'postgres' && typeof v === 'number' ? String(v) : v)));
    assert.equal(r.rows[0][2], null);
  });

  test(`${e}: which results are editable`, async () => {
    assert.deepEqual(await target('SELECT * FROM customer'), { schema: cfg.schema, table: 'customer', columns: ['id', 'name', 'note'], pk: ['id'] });
    assert.deepEqual(((await target('SELECT name AS n, id FROM customer')) as EditTarget).columns, ['name', 'id']);
    assert.match((await target('SELECT name FROM customer')) as string, /does not include the primary key/);
    assert.match((await target('SELECT * FROM nopk')) as string, /no primary key/);
    assert.match((await target('SELECT * FROM customer c JOIN orders o ON o.customer_id = c.id')) as string, /single table/);
    assert.match((await target('SELECT id, upper(name) FROM customer')) as string, /single table/);
  });

  test(`${e}: apply update + insert + delete, including a no-op update`, async () => {
    const r = await d.query('SELECT * FROM customer ORDER BY id');
    const t = (await editTarget(d, r.raw)) as EditTarget;
    const edits = buildEdits(t, r.rows, {
      updates: { 0: { 1: 'Ada L', 2: 'first' }, 1: { 1: 'Grace' } }, // row 1: same value, must still count as 1 row
      inserts: [{ 0: '4', 1: "O'Brien" }],
      deletes: [2],
    }, d.quoteId.bind(d), d.ph.bind(d));
    await applyEdits(await connect(), edits);
    assert.deepEqual(await names(), ['Ada L', 'Grace', "O'Brien"]);
  });

  test(`${e}: a stale row rolls the whole batch back`, async () => {
    const r = await d.query('SELECT * FROM customer ORDER BY id');
    const t = (await editTarget(d, r.raw)) as EditTarget;
    const stale = [...r.rows, [999, 'ghost', null]];
    const edits = buildEdits(t, stale, { ...none, updates: { 0: { 1: 'CHANGED' }, 3: { 1: 'nobody' } } }, d.quoteId.bind(d), d.ph.bind(d));
    await assert.rejects(applyEdits(await connect(), edits), /Rolled back/);
    assert.deepEqual(await names(), ['Ada L', 'Grace', "O'Brien"]);
  });

  test(`${e}: cancel stops a running query and the session survives`, async () => {
    const t0 = Date.now();
    const running = d.query(cfg.sleep).catch(err => err);
    await new Promise(r => setTimeout(r, 300));
    await d.cancel();
    await running;
    assert.ok(Date.now() - t0 < 5000, 'query should stop long before its 20s sleep');
    assert.equal(String((await d.query('SELECT 1')).rows[0][0]), '1');
  });

  test(`${e}: errors reject and wrong password fails`, async () => {
    await assert.rejects(d.query('SELECT * FROM does_not_exist'));
    await assert.rejects(open(cfg, 'wrong'));
  });
}
