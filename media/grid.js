// Result grid webview. Database content is untrusted: cells are only ever written with textContent.
const vscode = acquireVsCodeApi();
const app = document.getElementById('app');

let sets = [];      // result tabs from the extension
let pend = [];      // per tab: { edits: {row: {col: value}}, inserts: [{col: value}], deletes: Set<row> }
let cur = 0;        // active tab
let sel = null;     // selected cell [row, col]; rows past the result are pending inserts
let wasDirty = false;

const fresh = () => ({ edits: {}, inserts: [], deletes: new Set() });
const isDirty = p => Object.keys(p.edits).length > 0 || p.inserts.length > 0 || p.deletes.size > 0;
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

// undefined = a new row's cell that was never filled in (left out of the INSERT)
function value(r, c) {
  const s = sets[cur], p = pend[cur], n = s.rows.length;
  if (r >= n) return p.inserts[r - n][c];
  const e = p.edits[r];
  return e && c in e ? e[c] : s.rows[r][c];
}

function setValue(r, c, v) {
  const s = sets[cur], p = pend[cur], n = s.rows.length;
  if (r >= n) p.inserts[r - n][c] = v;
  else if (v === s.rows[r][c]) {
    if (p.edits[r]) delete p.edits[r][c];
    if (p.edits[r] && !Object.keys(p.edits[r]).length) delete p.edits[r];
  } else (p.edits[r] ??= {})[c] = v;
  render();
}

function tellDirty() {
  const d = pend.some(isDirty);
  if (d !== wasDirty) vscode.postMessage({ type: 'dirty', value: (wasDirty = d) });
}

const cellAt = rc => rc && app.querySelector('tbody')?.rows[rc[0]]?.cells[rc[1] + 1];

function select(rc) {
  cellAt(sel)?.classList.remove('sel');
  sel = rc;
  const td = cellAt(sel);
  td?.classList.add('sel');
  td?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  for (const b of app.querySelectorAll('button.needs-cell')) b.disabled = !td;
}

function startEdit() {
  const s = sets[cur], p = pend[cur], td = cellAt(sel);
  if (!td || s.readOnly || s.roCols[sel[1]] || p.deletes.has(sel[0])) return;
  const [r, c] = sel, before = value(r, c) ?? '';
  let done = false;
  // shortcut: single-line editor, and an untouched NULL stays NULL (so '' cannot replace NULL);
  // add a multi-line editor when long text needs editing in place
  const finish = save => {
    if (done) return;
    done = true;
    const v = td.textContent;
    if (save && v !== before) setValue(r, c, v); else render();
    app.querySelector('table')?.focus();
  };
  td.classList.remove('null');
  td.textContent = before;
  td.contentEditable = 'plaintext-only';
  td.focus();
  getSelection().selectAllChildren(td);
  td.onblur = () => finish(true);
  td.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  };
}

function render() {
  const s = sets[cur];
  if (!s) {
    app.replaceChildren(el('p', { className: 'empty', textContent: 'Run a query to see its result here. Ctrl+Enter runs the statement under the cursor, Ctrl+Shift+Enter runs the selection or the whole file.' }));
    return;
  }
  const p = pend[cur], n = s.rows.length, total = n + p.inserts.length;
  const btn = (text, title, onclick, props = {}) => el('button', { type: 'button', textContent: text, title, onclick, ...props });

  const bar = el('div', { className: 'bar' }, btn('Export', 'Export this result to a CSV file', () => vscode.postMessage({ type: 'export', set: cur })));
  if (s.readOnly) bar.append(el('span', { className: 'ro', textContent: 'Read Only', title: s.readOnly }));
  else bar.append(
    btn('Add Row', 'Add a new row', () => { p.inserts.push({}); render(); select([total, 0]); }),
    btn('Delete Row', 'Mark the selected row for deletion (again to undo)', () => {
      const r = sel[0];
      if (r >= n) { p.inserts.splice(r - n, 1); sel = null; }
      else if (!p.deletes.delete(r)) p.deletes.add(r);
      render();
    }, { className: 'needs-cell' }),
    btn('Set NULL', 'Set the selected cell to NULL', () => { if (!s.roCols[sel[1]]) setValue(sel[0], sel[1], null); }, { className: 'needs-cell' }),
    btn('Apply', 'Write the pending changes to the database', () => vscode.postMessage({
      type: 'apply', set: cur, changes: { updates: p.edits, inserts: p.inserts, deletes: [...p.deletes] },
    }), { disabled: !isDirty(p), className: 'primary' }),
    btn('Revert', 'Discard the pending changes', () => { pend[cur] = fresh(); render(); }, { disabled: !isDirty(p) }),
  );
  bar.append(el('span', { className: 'count', textContent: `${n} row(s)` }));

  const head = el('tr', {}, el('th', { scope: 'col', ariaLabel: 'Row' }), ...s.fields.map(f => el('th', { scope: 'col', textContent: f, title: f })));
  const body = el('tbody');
  for (let r = 0; r < total; r++) {
    const tr = el('tr', { className: p.deletes.has(r) ? 'del' : r >= n ? 'new' : '' }, el('th', { scope: 'row', textContent: r >= n ? '*' : String(r + 1) }));
    for (let c = 0; c < s.fields.length; c++) {
      const v = value(r, c), td = el('td');
      if (v == null) { td.className = 'null'; td.textContent = v === null ? 'NULL' : ''; }
      else { td.textContent = v; if (v.length > 40) td.title = v.slice(0, 2000); }
      if (r < n && p.edits[r] && c in p.edits[r]) td.classList.add('dirty');
      tr.append(td);
    }
    body.append(tr);
  }
  const table = el('table', { tabIndex: 0, ariaLabel: `${s.title}, ${n} rows` }, el('thead', {}, head), body);
  const pos = td => [td.parentElement.sectionRowIndex, td.cellIndex - 1];
  table.onmousedown = e => { const td = e.target.closest('td'); if (td && !td.isContentEditable) select(pos(td)); };
  table.ondblclick = e => { if (e.target.closest('td')) startEdit(); };
  table.onkeydown = e => {
    const move = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (move && total) {
      const [r, c] = sel ?? [0, 0];
      select([Math.max(0, Math.min(total - 1, r + (sel ? move[0] : 0))), Math.max(0, Math.min(s.fields.length - 1, c + (sel ? move[1] : 0)))]);
      e.preventDefault();
    } else if ((e.key === 'Enter' || e.key === 'F2') && sel) { startEdit(); e.preventDefault(); }
  };

  const tabs = el('div', { className: 'tabs', role: 'tablist' }, ...sets.map((t, i) => {
    const b = btn(t.title, '', () => { cur = i; sel = null; render(); }, { role: 'tab' });
    b.setAttribute('aria-selected', String(i === cur));
    return b;
  }));

  app.replaceChildren(bar, el('div', { className: 'wrap' }, table), tabs);
  select(sel && sel[0] < total ? sel : null);
  tellDirty();
}

window.addEventListener('message', ({ data: m }) => {
  if (m.type === 'sets') { sets = m.sets; pend = sets.map(fresh); cur = 0; sel = null; }
  else if (m.type === 'set') { sets[m.index] = m.set; pend[m.index] = fresh(); if (m.index === cur) sel = null; }
  render();
  tellDirty();
});
render();
vscode.postMessage({ type: 'ready' });
