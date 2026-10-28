/* 配置工作台 · 单行编辑
 * 设计原则：
 *  1. 所有改动先进「待保存队列」，必须过 /api/preview 看 diff 才能落盘
 *  2. 不重写文件，只替换被改字段的值区间（见 json-edit.mjs）
 *  3. 批量改同一列走 column-editor.js，不走这里
 */
const EP = {
  detailMode: 'view',
  editRow: null,
  pending: new Map(),   // 'table\u0000row' -> { table, row, patch, orig }
  refCache: new Map(),
  draft: null,
};

const PK = (t, r) => t + '\u0000' + r;
const $e = (s) => document.querySelector(s);

/* ---------------- 通用确认 / 提示弹层 ----------------
   原生 confirm / alert 的配色由浏览器决定，与工作台主题无关（暗色下会突然白一块），
   而且无法排版引用列表。这里统一走自建弹层，样式与 diff 弹窗同一套。 */
function uiDialog(opts) {
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'cfm-mask';
    const body = opts.html || (opts.text ? '<p class="cfm-p">' + esc(opts.text) + '</p>' : '');
    m.innerHTML = '<div class="cfm' + (opts.tone ? ' cfm-' + opts.tone : '') + '" role="dialog">' +
      '<div class="cfm-t">' + esc(opts.title || '') + '</div>' +
      (opts.sub ? '<div class="cfm-sub">' + esc(opts.sub) + '</div>' : '') +
      (body ? '<div class="cfm-body">' + body + '</div>' : '') +
      '<div class="cfm-foot">' +
        (opts.cancelText === null ? '' : '<button class="btn" data-x="no">' + esc(opts.cancelText || '取消') + '</button>') +
        '<button class="btn ' + (opts.danger ? 'danger' : 'primary') + '" data-x="yes">' + esc(opts.okText || '确定') + '</button>' +
      '</div></div>';
    document.body.appendChild(m);
    const done = (v) => {
      document.removeEventListener('keydown', onKey, true);
      m.remove();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
    };
    document.addEventListener('keydown', onKey, true);
    const no = m.querySelector('[data-x="no"]');
    if (no) no.onclick = () => done(false);
    m.querySelector('[data-x="yes"]').onclick = () => done(true);
    m.addEventListener('mousedown', (e) => { if (e.target === m) done(false); });
    setTimeout(() => m.querySelector('[data-x="yes"]').focus(), 0);
  });
}
const uiAlert = (title, text, sub) => uiDialog({ title: title, text: text, sub: sub, cancelText: null, okText: '知道了' });
const uiConfirm = (title, text, opts) => uiDialog(Object.assign({ title: title, text: text }, opts || {}));

/* ---------------- 工具条注入 ---------------- */
function mountEditBar() {
  // 同步 state.selRow（app.js 只给 tr 加 sel 类，没维护 state）
  document.querySelector('#grid-body').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const i = +tr.dataset.i;
    const row = state.rows[i - state.offset];
    state.selRow = row ? row.RowName : null;
  });

  // 待保存条
  const pbar = document.createElement('div');
  pbar.id = 'pending-bar';
  pbar.className = 'pending-bar';
  pbar.hidden = true;
  document.querySelector('footer.statusbar').parentNode.insertBefore(pbar, document.querySelector('footer.statusbar'));
}

/** 当前中间表格选中的行（DOM 的 .sel 是唯一真源） */
function currentSelRow() {
  const tr = document.querySelector('#grid-body tr.sel');
  if (!tr) return null;
  const row = state.rows[+tr.dataset.i - state.offset];
  return row ? row.RowName : null;
}

/* ---------------- 待保存队列 ---------------- */
function addPending(table, row, patch, orig) {
  const key = PK(table, row);
  const cur = EP.pending.get(key) || { table, row, patch: {}, orig: orig || {} };
  for (const [k, v] of Object.entries(patch)) {
    if (JSON.stringify(v) === JSON.stringify(cur.orig[k] ?? orig[k])) delete cur.patch[k];
    else cur.patch[k] = v;
  }
  if (!Object.keys(cur.patch).length) EP.pending.delete(key);
  else EP.pending.set(key, cur);
  updatePendingBar();
  syncDelMarks();
}

/* 删除也进队列（和编辑共用一次 diff 预览 + 一次写盘） */
function addPendingDel(table, row, refs) {
  const key = PK(table, row);
  const old = EP.pending.get(key);
  EP.pending.set(key, { table: table, row: row, del: true, patch: {}, refs: refs || (old && old.refs) || null });
  updatePendingBar();
  syncDelMarks();
}

function isPendingDel(table, row) {
  const p = EP.pending.get(PK(table, row));
  return !!(p && p.del);
}

function pendingOps(items) {
  return (items || [...EP.pending.values()]).map((p) =>
    p.del ? { type: 'delete', row: p.row } : { type: 'set', row: p.row, patch: p.patch });
}

/* 表格里标记队列中的行：改过的加黄点，要删的整行划掉 */
function syncDelMarks() {
  const body = document.querySelector('#grid-body');
  if (!body || !state.cur) return;
  for (const tr of body.querySelectorAll('tr')) {
    const row = state.rows[+tr.dataset.i - state.offset];
    if (!row) continue;
    const p = EP.pending.get(PK(state.cur, row.RowName));
    tr.classList.toggle('tr-del', !!(p && p.del));
    tr.classList.toggle('tr-mod', !!(p && !p.del));
  }
}

function updatePendingBar() {
  const bar = $e('#pending-bar');
  if (!bar) return;
  const all = [...EP.pending.values()];
  const n = all.length;
  if (!n) { bar.hidden = true; return; }
  bar.hidden = false;
  const del = all.filter((p) => p.del).length;
  const sets = n - del;
  const parts = [];
  if (sets) parts.push('<b>' + sets + '</b> 行待保存');
  if (del) parts.push('<b class="pb-dn">' + del + '</b> 行待删除');
  bar.innerHTML = '<span class="pb-dot"></span> ' + parts.join(' <span class="pb-sep">·</span> ') +
    '<span class="pb-rows">' + all.slice(0, 3).map((p) =>
      p.del ? '<s>' + esc(p.row) + '</s>' : esc(p.row)).join('、') + (n > 3 ? ' …' : '') + '</span>' +
    '<span class="spacer"></span>' +
    '<button class="btn primary" id="btn-save">预览并保存</button>' +
    '<button class="btn" id="btn-discard">放弃</button>';
  $e('#btn-save').onclick = saveAll;
  $e('#btn-discard').onclick = async () => {
    const ok = await uiConfirm('放弃这些改动？',
      (sets ? '取消 ' + sets + ' 行待保存的修改' : '') +
      (sets && del ? '，' : '') +
      (del ? '取消 ' + del + ' 行删除' : '') + '。 文件不会被写入。',
      { okText: '放弃', danger: true });
    if (!ok) return;
    EP.pending.clear();
    updatePendingBar();
    syncDelMarks();
    const cur = state.rows.find((r) => r.RowName === currentSelRow());
    if (cur) renderDetail(cur);
  };
}

/* ---------------- 保存：预览 → 应用 ---------------- */
async function postJson(url, body) {
  const m = url.split('?')[0];
  try {
    if (m === '/api/preview') return { code: 200, data: await DS.preview(body.table, body.ops) };
    if (m === '/api/apply') {
      const r = await DS.apply(body.table, body.ops);
      return { code: 200, data: Object.assign({ ok: true }, r) };
    }
    return { code: 404, data: { ok: false, error: '未知操作' } };
  } catch (e) {
    return { code: 400, data: { ok: false, error: e.message, errors: [e.message] } };
  }
}

/* 删除行在入队那一刻就开始扫引用，这里只是等它把结果交上来 */
async function ensureDelRefs() {
  const list = [...EP.pending.values()].filter((p) => p.del);
  for (const p of list) {
    if (p.refs) continue;
    try { p.refs = await DS.findRefsTo(p.table, p.row); } catch (e) { p.refs = []; }
  }
  return list;
}

function delWarnings(dels) {
  return dels.map((p) => {
    const r = p.refs || [];
    if (!r.length) return '删除 ' + p.row + '：没有其他行引用它';
    const sample = r.slice(0, 3).map((x) => x.table + '/' + x.row).join('、');
    return '删除 ' + p.row + '：会影响 ' + r.length + ' 处引用（' + sample + (r.length > 3 ? ' 等' : '') + '），删除后会变成悬空';
  });
}

/* 待保存队列按表分组，顺序稳定（按首次入队顺序） */
function groupPending() {
  const m = new Map();
  for (const p of EP.pending.values()) {
    if (!m.has(p.table)) m.set(p.table, []);
    m.get(p.table).push(p);
  }
  return m;
}

/* 写盘后刷新：表行数、侧栏、详情。其它表被删行时 rowCount 也要跟着变 */
async function reloadAfterSave(tables) {
  for (const t of tables) { try { await DS.notes(t); } catch (e) { } }
  state.tables = Object.values(state.sem.tables).sort((a, b) => b.rowCount - a.rowCount);
  renderTableList();
  await loadRows();
  const kept = state.rows.find((r) => r.RowName === state.selRow);
  renderDetail(kept || null);
  if (!kept) syncHash(state.cur, null);
}

async function saveAll() {
  if (!EP.pending.size) return;
  const groups = groupPending();
  setStatus('校验中…');
  await ensureDelRefs();

  const parts = [];
  for (const [table, items] of groups) {
    const delRows = items.filter((p) => p.del);
    const ops = pendingOps(items);
    const { data } = await postJson('/api/preview', { table, ops });
    if (!data || !data.diff) {
      setStatus('预览失败');
      uiAlert('预览失败 · ' + table, (data && (data.error || (data.errors || []).join('\n'))) || '预览失败');
      return;
    }
    if (delRows.length) data.warnings = delWarnings(delRows).concat(data.warnings || []);
    parts.push({ table, ops, data, setCount: items.length - delRows.length, delCount: delRows.length });
  }
  setStatus('就绪');

  const totalOps = parts.reduce((s, p) => s + p.ops.length, 0);
  const totalDel = parts.reduce((s, p) => s + p.delCount, 0);
  const onlyDel = totalDel > 0 && totalDel === totalOps;
  const many = parts.length > 1;
  const okText = many ? '写入 ' + parts.length + ' 张表' : (onlyDel ? '删除' : '写入文件');
  const title = many ? '确认改动（' + parts.length + ' 张表）' : (onlyDel ? '确认删除' : '确认改动');

  showMultiDiffDialog(parts, async () => {
    const done = [];
    for (const p of parts) {
      try {
        done.push(await DS.apply(p.table, p.ops));
      } catch (e) {
        const rolled = [];
        for (const d of done) { try { await DS.undo(d.backup); rolled.push(d.table); } catch (e2) { } }
        EP.pending.clear();
        updatePendingBar();
        syncDelMarks();
        uiAlert('保存失败，已回滚', p.table + '：' + e.message +
          (rolled.length ? '\n\n已还原：' + rolled.join('、') : ''));
        await reloadAfterSave(parts.map((x) => x.table));
        setStatus('保存失败');
        return false;
      }
    }
    EP.pending.clear();
    updatePendingBar();
    syncDelMarks();
    await reloadAfterSave(parts.map((x) => x.table));
    const bits = [];
    if (totalOps - totalDel) bits.push('修改 ' + (totalOps - totalDel) + ' 处');
    if (totalDel) bits.push('删除 ' + totalDel + ' 行');
    if (many) bits.push(parts.length + ' 张表');
    const bs = done.map((d) => d.backup);
    setStatus((bits.join(' · ') || '已写入') + ' · 备份 ' + (bs.length > 1 ? bs[0] + ' 等 ' + bs.length + ' 个' : bs[0]));
    return true;
  }, okText, title);
}

/* ---------------- diff 弹层 ---------------- */
function hunksHtml(d) {
  return d.hunks.map((h) => {
    const aStart = Math.max(1, h.aStart - h.before.length);
    return '<div class="hunk"><div class="hunk-head">@@ 第 ' + aStart + ' 行 @@</div>' +
      h.before.map((l) => '<div class="dl ctx">' + esc(l) + '</div>').join('') +
      h.aLines.map((l) => '<div class="dl del">- ' + esc(l) + '</div>').join('') +
      h.bLines.map((l) => '<div class="dl add">+ ' + esc(l) + '</div>').join('') +
      h.after.map((l) => '<div class="dl ctx">' + esc(l) + '</div>').join('') +
      '</div>';
  }).join('');
}

function warnBlocks(warnings, errors) {
  const w = (warnings || []).length
    ? '<div class="dlg-warn"><b>校验提示</b><ul>' + warnings.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div>'
    : '';
  const e = (errors || []).length
    ? '<div class="dlg-err"><b>校验错误（无法保存）</b><ul>' + errors.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div>'
    : '';
  return e + w;
}

function showDiffDialog(data, onConfirm, confirmText, title) {
  const d = data.diff;
  const hunkHtml = d.hunks.map((h) => {
    const aStart = Math.max(1, h.aStart - h.before.length);
    return '<div class="hunk"><div class="hunk-head">@@ 第 ' + aStart + ' 行 @@</div>' +
      h.before.map((l) => '<div class="dl ctx">' + esc(l) + '</div>').join('') +
      h.aLines.map((l) => '<div class="dl del">- ' + esc(l) + '</div>').join('') +
      h.bLines.map((l) => '<div class="dl add">+ ' + esc(l) + '</div>').join('') +
      h.after.map((l) => '<div class="dl ctx">' + esc(l) + '</div>').join('') +
      '</div>';
  }).join('');

  const warns = (data.warnings || []).length
    ? '<div class="dlg-warn"><b>校验提示</b><ul>' + data.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul></div>'
    : '';
  const errs = (data.errors || []).length
    ? '<div class="dlg-err"><b>校验错误（无法保存）</b><ul>' + data.errors.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul></div>'
    : '';

  const m = document.createElement('div');
  m.className = 'modal-mask';
  m.innerHTML = '<div class="modal">' +
    '<div class="modal-head"><h3>' + esc(title || '确认改动') + '</h3>' +
    '<div class="modal-sub">' + d.hunkCount + ' 处 · 删除 ' + d.removedLines + ' 行 / 新增 ' + d.addedLines + ' 行 · 文件 ' +
    data.sizeBefore + ' → ' + data.sizeAfter + ' 字节' + (d.truncated ? '（diff 已截断）' : '') + '</div></div>' +
    errs + warns +
    '<div class="modal-body">' + (hunkHtml || '<div class="empty">没有差异</div>') + '</div>' +
    '<div class="modal-foot"><button class="btn" data-x="cancel">取消</button>' +
    '<button class="btn primary" data-x="ok"' + ((data.errors || []).length ? ' disabled' : '') + '>' + (confirmText || '写入文件') + '</button></div>' +
    '</div>';
  document.body.appendChild(m);
  const close = () => m.remove();
  m.querySelector('[data-x="cancel"]').onclick = close;
  m.querySelector('[data-x="ok"]').onclick = async () => {
    m.querySelector('[data-x="ok"]').disabled = true;
    const ok = await onConfirm();
    if (ok !== false) close();
    else m.querySelector('[data-x="ok"]').disabled = false;
  };
}

/* 跨表保存：一张表一段，头部显示表名与该表字节变化 */
function showMultiDiffDialog(parts, onConfirm, okText, title) {
  const many = parts.length > 1;
  let hunks = 0, removed = 0, added = 0;
  for (const p of parts) {
    hunks += p.data.diff.hunkCount;
    removed += p.data.diff.removedLines;
    added += p.data.diff.addedLines;
  }
  let warns = '', errs = '';
  for (const p of parts) {
    if (!(p.data.warnings || []).length && !(p.data.errors || []).length) continue;
    const tag = many ? '<li class="mt-tag">表 ' + esc(p.table) + '</li>' : '';
    if ((p.data.errors || []).length) {
      errs += '<div class="dlg-err"><b>校验错误（无法保存）· ' + esc(p.table) + '</b><ul>' +
        p.data.errors.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div>';
    }
    if ((p.data.warnings || []).length) {
      warns += '<div class="dlg-warn"><b>校验提示' + (many ? ' · ' + esc(p.table) : '') + '</b><ul>' +
        p.data.warnings.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div>';
    }
  }
  const body = parts.map((p) => {
    const d = p.data.diff;
    return '<div class="mt-sec">' +
      '<div class="mt-head"><b>' + esc(p.table) + '</b>' +
      '<span>' + p.ops.length + ' 处 · ' + d.hunkCount + ' 段 · 删除 ' + d.removedLines + ' 行 / 新增 ' + d.addedLines + ' 行 · ' +
      p.data.sizeBefore + ' → ' + p.data.sizeAfter + ' 字节</span></div>' +
      (d.hunks.length ? hunksHtml(d) : '<div class="empty">没有差异</div>') +
      '</div>';
  }).join('');

  const m = document.createElement('div');
  m.className = 'modal-mask';
  m.innerHTML = '<div class="modal">' +
    '<div class="modal-head"><h3>' + esc(title || (many ? '确认改动（' + parts.length + ' 张表）' : '确认改动')) + '</h3>' +
    '<div class="modal-sub">' + (many ? parts.length + ' 张表 · ' : '') + hunks + ' 段 · 删除 ' + removed + ' 行 / 新增 ' + added + ' 行</div></div>' +
    errs + warns +
    '<div class="modal-body">' + body + '</div>' +
    '<div class="modal-foot"><button class="btn" data-x="cancel">取消</button>' +
    '<button class="btn primary" data-x="ok"' + (errs ? ' disabled' : '') + '>' + esc(okText || (many ? '写入 ' + parts.length + ' 张表' : '写入文件')) + '</button></div>' +
    '</div>';
  document.body.appendChild(m);
  const close = () => m.remove();
  m.querySelector('[data-x="cancel"]').onclick = close;
  m.querySelector('[data-x="ok"]').onclick = async () => {
    m.querySelector('[data-x="ok"]').disabled = true;
    const ok = await onConfirm();
    if (ok !== false) close();
    else m.querySelector('[data-x="ok"]').disabled = false;
  };
}

/* ---------------- 详情：编辑表单 ---------------- */
const baseRenderDetail = window.renderDetail;

window.renderDetail = function (row) {
  // 点了别的行（或清空选择）就退出编辑态，否则会把上一行的表单套到新行上
  if (EP.detailMode === 'edit' && (!row || row.RowName !== EP.editRow)) { EP.detailMode = 'view'; EP.draft = null; }
  if (EP.detailMode !== 'edit' || !row) return baseRenderDetail(row);
  renderEditForm(row);
};

function kindOf(f) { return f.kind; }

function ctrlHtml(t, f, v) {
  const name = 'f-' + f.name;
  const common = 'data-field="' + esc(f.name) + '" id="' + name + '"';
  const kind = kindOf(f);
  if (kind === 'bool') {
    const cur = v === true ? 'true' : v === false ? 'false' : '';
    return '<select ' + common + ' class="ed-ctl"><option value="">未设置</option>' +
      '<option value="true"' + (cur === 'true' ? ' selected' : '') + '>是</option>' +
      '<option value="false"' + (cur === 'false' ? ' selected' : '') + '>否</option></select>';
  }
  if (kind === 'nullable') {
    // 可空字段的实际类型看 types。之前一律当数字，
    // 结果 "30.00:00:00" 这种字符串塞进 <input type=number> 会被浏览器清成空串，
    // 打开编辑什么都不改、直接应用就把原值写没了。
    if (typeof v === 'boolean') {
      const cur = v === true ? 'true' : 'false';
      return '<select ' + common + ' class="ed-ctl"><option value="">未设置</option>' +
        '<option value="true"' + (cur === 'true' ? ' selected' : '') + '>是</option>' +
        '<option value="false"' + (cur === 'false' ? ' selected' : '') + '>否</option></select>';
    }
    if (typeof v === 'object' && v !== null) return jsonCtrl(f, v);
    const types = (f.types || []).filter((x) => x !== 'null');
    const numish = typeof v === 'number' || ((v === undefined || v === null) && types.indexOf('number') >= 0);
    return '<input ' + common + ' class="ed-ctl" type="' + (numish ? 'number' : 'text') + '" step="any" value="' + esc(v ?? '') + '" />';
  }
  if (kind === 'number' || kind === 'int') {
    if (typeof v === 'object' && v !== null) return jsonCtrl(f, v);
    // 数据里偶尔是字符串（"0.75"）甚至非数字文本，非数字时降级成文本框，别让控件吞值
    const odd = v !== undefined && v !== null && v !== '' && Number.isNaN(Number(v));
    return '<input ' + common + ' class="ed-ctl" type="' + (odd ? 'text' : 'number') + '" step="any" value="' + esc(v ?? '') + '" />';
  }
  if (kind === 'enum') {
    const map = state.sem.enums[f.enum] || {};
    const opts = Object.entries(map).map(([k, label]) =>
      '<option value="' + esc(k) + '"' + (String(v) === String(k) ? ' selected' : '') + '>' + esc(k) + ' · ' + esc(label) + '</option>').join('');
    return '<select ' + common + ' class="ed-ctl"><option value="">未设置</option>' + opts + '</select>';
  }
  if (kind === 'ref') {
    /* 引用字段：点 ▾ 或按 ↓ 打开目标表行选择器（ref-picker.js），比原生 datalist 可控 */
    return '<span class="rp-wrap">' +
      '<input ' + common + ' class="ed-ctl" data-rp="' + esc(f.target) + '" value="' + esc(v ?? '') + '" placeholder="' + esc(f.target) + '" />' +
      '<button type="button" class="rp-btn" data-rp-btn title="从 ' + esc(f.target) + ' 里选一行">▾</button>' +
      '<button type="button" class="mini-btn" data-goto-target="' + esc(f.target) + '" data-goto-row="' + esc(v ?? '') + '" title="跳到 ' + esc(f.target) + '">→</button>' +
      '</span>';
  }
  if (kind === 'datetime' || kind === 'duration' || kind === 'text') {
    const ph = kind === 'duration' ? 'day.hour:min:sec 例 1.12:30:30' : kind === 'datetime' ? '2025-01-01T00:00:00Z' : '';
    return '<input ' + common + ' class="ed-ctl mono" type="text" value="' + esc(v ?? '') + '" placeholder="' + ph + '" />';
  }
  return jsonCtrl(f, v);
}

function jsonCtrl(f, v) {
  const txt = v === undefined ? '' : JSON.stringify(v);
  return '<textarea data-field="' + esc(f.name) + '" class="ed-ctl ed-json" rows="3" spellcheck="false">' + esc(txt) + '</textarea>' +
    '<div class="ed-json-hint">JSON 格式，结构校验会在保存前执行</div>';
}


function renderEditForm(row) {
  const t = state.sem.tables[state.cur];
  const fields = t.fields.filter((f) => f.name !== 'RowName');
  const el = $e('#detail');

  // draft 只装「走结构化编辑」的字段，其它字段仍然从 DOM 读
  EP.draft = { values: {}, fields: new Set() };

  const rowsHtml = fields.map((f) => {
    let ctrl;
    if (typeof SE !== 'undefined' && SE.supports(f)) {
      EP.draft.values[f.name] = SE.normalize(f, row[f.name]);
      EP.draft.fields.add(f.name);
      ctrl = SE.fieldHtml(f, EP.draft.values[f.name]);
    } else {
      ctrl = ctrlHtml(t, f, row[f.name]);
    }
    return '<div class="f-row ed-row"><div class="f-key">' + fkeyHtml(f) +
      (f.target ? '<span class="k-target">→ ' + esc(f.target) + '</span>' : '') + '</div>' +
      '<div class="f-val">' + ctrl + '</div>' +
      (f.desc ? '<div class="f-desc" title="' + esc(f.desc) + '">' + esc(f.desc) + '</div>' : '') +
      '</div>';
  }).join('');

  const html = '<div class="d-head"><div class="d-rn">' + esc(row.RowName) +
    '<span class="ed-tag">编辑中</span></div>' +
    '<div class="d-summary">' + esc(t.name) + ' · 修改后需预览 diff 才会写盘</div></div>' +
    '<div class="d-body ed-form">' + rowsHtml +
    '</div><div class="ed-foot">' +
    '<button class="btn" id="ed-cancel" title="取消编辑（Esc）">取消 <kbd>Esc</kbd></button>' +
    '<button class="btn primary" id="ed-apply" title="应用修改（Ctrl + Enter）">应用修改 <kbd>Ctrl ↵</kbd></button></div>';
  el.innerHTML = html;
  el.scrollTop = 0;

  if (typeof SE !== 'undefined') SE.bind(el.querySelector('.ed-form'), EP.draft);

  $e('#ed-cancel').onclick = () => { EP.detailMode = 'view'; EP.editRow = null; EP.draft = null; renderDetail(row); };
  $e('#ed-apply').onclick = () => applyForm(row, t);
  el.querySelectorAll('[data-goto-target]').forEach((b) => b.addEventListener('click', () => {
    /* 优先读输入框当前值：用选择器改过之后 data-goto-row 里的是旧值 */
    const inp = b.parentElement && b.parentElement.querySelector('[data-rp]');
    const cur = inp ? inp.value : b.dataset.gotoRow;
    if (cur) goTo(b.dataset.gotoTarget, cur);
  }));
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function isEmptyStruct(v) {
  if (Array.isArray(v)) return v.length === 0;
  if (v && typeof v === 'object') return Object.keys(v).length === 0;
  return v === '' || v === null;
}

function collectForm(t, row) {
  const patch = {};
  const bad = [];
  const structFields = (EP.draft && EP.draft.fields) || new Set();
  const formEl = $e('#detail .ed-form');

  for (const f of t.fields) {
    if (f.name === 'RowName') continue;
    const orig = row[f.name];

    // 结构化字段：真源是 draft，DOM 只负责显示
    if (structFields.has(f.name)) {
      const val = EP.draft.values[f.name];
      // 原值缺省或 null、编辑器里又是空容器（结构化编辑器会把 null 兜成 {} / []）＝没改动
      if ((orig === undefined || orig === null) && isEmptyStruct(val)) continue;
      if (sameJson(orig, val)) continue;
      patch[f.name] = val;
      continue;
    }

    const el = formEl && formEl.querySelector('[data-field="' + f.name + '"]');
    if (!el) continue;
    const raw = el.value;
    // 第一道闸：控件里的文本和原值一模一样 → 用户根本没动这个字段，
    // 直接跳过。后面所有类型转换、空值判断都不该再参与。
    if (orig !== undefined && orig !== null && typeof orig !== 'object' && raw === String(orig)) continue;
    let val;
    let has = true;

    if (el.classList.contains('ed-json')) {
      if (!raw.trim()) has = false;
      else {
        try { val = JSON.parse(raw); } catch (e) { bad.push(f.name + '：JSON 非法 — ' + e.message); continue; }
      }
    } else if (f.kind === 'bool') {
      if (raw === '') has = false; else val = raw === 'true';
    } else if (f.kind === 'number' || f.kind === 'int') {
      if (raw === '') has = false;
      else {
        const n = Number(raw);
        if (Number.isNaN(n)) { bad.push(f.name + '：不是数字'); continue; }
        val = n;
      }
    } else if (f.kind === 'enum') {
      // 枚举是数字常量：<select> 的 value 永远是字符串，要按原值类型转回来，
      // 否则「打开编辑不改任何东西直接应用」会把 0 写成 "0"。
      if (raw === '') has = false;
      else val = typeof orig === 'number' ? Number(raw) : raw;
    } else {
      val = raw;
    }

    // 只收真正变化的字段：空输入框不等于「把字段改成空串」，
    // 否则每次保存都会给没填备注的行凭空写回 "Notes": ""。
    if (!has) continue;                              // 清空字段暂不支持
    // 原本就没有这个字段、或者是 null，空串不算改动（null 和 "" 在反序列化时同义）
    if (val === '' && (orig === undefined || orig === null)) continue;
    if (sameJson(orig, val)) continue;
    // 数值字段的原文可能写成字符串（"0.75"、"1"）、布尔也可能写成 "true"；
    // 只要文本等价就算没改，别顺手把 JSON 类型改掉。
    if (typeof orig !== 'object' && orig !== undefined && orig !== null && String(orig) === String(val)) continue;
    patch[f.name] = val;
  }
  return { patch, bad };
}

/* ---------------- 编辑表单快捷键 ---------------- */
/* Ctrl/Cmd + Enter 或 Ctrl/Cmd + S = 应用修改；Esc = 取消。
   有弹层打开时让位：引用选择器 / 命令面板 / diff 弹窗 / 确认框 / 列编辑都会先用 Escape。
   它们的处理函数已经 preventDefault，这里靠 defaultPrevented 判断，避免一次 Esc 把编辑也关掉。 */
function overlayOpen() {
  return !!document.querySelector('.rp-mask:not([hidden]), .cmdk-mask:not([hidden]), .cfm-mask, .modal-mask, .ce-mask');
}
function isTyping(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || !!el.isContentEditable;
}

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;

  /* 编辑态：Ctrl/Cmd+Enter 或 Ctrl/Cmd+S 应用，Esc 取消 */
  if (EP.detailMode === 'edit') {
    const apply = $e('#ed-apply');
    const cancel = $e('#ed-cancel');
    if (!apply || !cancel) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'Enter' || e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      apply.click();
      return;
    }
    if (e.key === 'Escape') {
      if (overlayOpen()) return;
      e.preventDefault();
      cancel.click();
    }
    return;
  }

  /* 只读态：E 编辑本行，Delete 删除本行 */
  if (overlayOpen() || isTyping(e.target)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const rn = state.selRow;
  if (!rn) return;
  const row = (state.rows || []).find((x) => x.RowName === rn);
  if (!row) return;
  if (isPendingDel(state.cur, rn)) return;  /* 已入删除队列，详情里只有「撤销删除」 */
  if (e.key === 'e' || e.key === 'E') {
    e.preventDefault();
    EP.detailMode = 'edit';
    EP.editRow = row.RowName;
    renderEditForm(row);
  } else if (e.key === 'Delete') {
    e.preventDefault();
    deleteRowFlow(row);
  }
});

function applyForm(row, t) {
  const { patch, bad } = collectForm(t, row);
  if (bad.length) { uiAlert('有字段无法解析', bad.join('\n')); return; }
  // undefined 表示「删除该字段」—— 原型阶段不支持删除字段，跳过
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
  EP.detailMode = 'view';
  EP.editRow = null;
  EP.draft = null;
  if (!Object.keys(patch).length) {
    // 什么都没改：不入队；如果这行之前排过队，这次改回原值就把队列里的那条撤掉
    if (EP.pending.delete(PK(t.name, row.RowName))) { updatePendingBar(); syncDelMarks(); }
    renderDetail(row);
    setStatus('没有改动');
    return;
  }
  addPending(t.name, row.RowName, patch, row);
  renderDetail(row);
  setStatus(EP.pending.size ? '已加入待保存队列（' + EP.pending.size + ' 行）' : '没有改动');
}


/* ---------------- 删除当前行 ---------------- */


/* 点「删除本行」不写盘、也不弹窗：和编辑一样先进待保存队列，
   底部「预览并保存」统一过 diff 才落盘。引用扫描在后台跑，结果进 diff 弹窗的提示区。 */
async function deleteRowFlow(row) {
  const t = state.sem.tables[state.cur];
  if (!t) return;
  const name = row.RowName;
  addPendingDel(t.name, name, null);
  EP.detailMode = 'view';
  EP.editRow = null;
  EP.draft = null;
  renderDetail(row);
  setStatus('已加入删除队列 · 点底部「预览并保存」确认');
  try {
    const refs = await DS.findRefsTo(t.name, name);
    const p = EP.pending.get(PK(t.name, name));
    if (p && p.del) { p.refs = refs; updatePendingBar(); renderDetail(row); }
  } catch (e) { /* 扫不到不影响删除，保存时会再试 */ }
}

function undoDelRow(row) {
  EP.pending.delete(PK(state.cur, row.RowName));
  updatePendingBar();
  syncDelMarks();
  renderDetail(row);
  setStatus('已撤销删除');
}

/* ---------------- 详情头部：编辑 / 删除 ---------------- */
const baseDetail2 = window.renderDetail;
window.renderDetail = function (row) {
  baseDetail2(row);
  if (!row || EP.detailMode === 'edit') return;
  const head = $e('#detail .d-head');
  if (!head) return;
  const wrap = document.createElement('div');
  wrap.className = 'd-actions';

  /* 已入删除队列：只给「撤销删除」，不给编辑 */
  if (isPendingDel(state.cur, row.RowName)) {
    const p = EP.pending.get(PK(state.cur, row.RowName));
    const refs = (p && p.refs) || [];
    const note = document.createElement('div');
    note.className = 'd-del-note';
    note.innerHTML = '<b>已加入删除队列</b>' +
      '<span>点底部「预览并保存」后才会写入文件</span>' +
      (p && p.refs
        ? '<span class="d-del-refs">' + (refs.length
            ? '⚠ 会影响 ' + refs.length + ' 处引用：' + esc(refs.slice(0, 2).map((x) => x.table + '/' + x.row).join('、')) + (refs.length > 2 ? ' 等' : '')
            : '✓ 没有其他行引用它') + '</span>'
        : '<span class="d-del-refs">正在检查引用…</span>');
    const undo = document.createElement('button');
    undo.className = 'btn';
    undo.textContent = '撤销删除';
    undo.onclick = () => undoDelRow(row);
    wrap.appendChild(undo);
    head.appendChild(wrap);
    head.appendChild(note);
    return;
  }

  const editBtn = document.createElement('button');
  editBtn.className = 'btn primary';
  editBtn.title = '编辑本行（E）';
  editBtn.innerHTML = '编辑本行 <kbd>E</kbd>';
  editBtn.onclick = () => { EP.detailMode = 'edit'; EP.editRow = row.RowName; renderEditForm(row); };

  const delBtn = document.createElement('button');
  delBtn.className = 'btn danger';
  delBtn.title = '删除本行（Delete）';
  delBtn.innerHTML = '删除本行 <kbd>Del</kbd>';
  delBtn.onclick = () => deleteRowFlow(row);

  wrap.appendChild(editBtn);
  wrap.appendChild(delBtn);
  head.appendChild(wrap);
};

/* 表格每次重渲染都会丢掉 .tr-del 类，这里挂一层包装补回来 */
const baseRenderGrid = window.renderGrid;
window.renderGrid = function () {
  baseRenderGrid();
  syncDelMarks();
};

/* ---------------- 启动 ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  mountEditBar();
});