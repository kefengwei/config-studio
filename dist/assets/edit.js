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
  editShown: null,      // 编辑表单的显示基线（磁盘值 + 队列里的改动）
  newBase: null,        // 新增 / 复制行时的初始值快照（编辑模式为 null）
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

  // 新增行：和编辑一样先进队列，底部「预览并保存」统一写盘
  const newBtn = document.getElementById('btn-new-row');
  if (newBtn) newBtn.addEventListener('click', () => {
    const t = state.sem.tables[state.cur];
    if (!t) return;
    EP.detailMode = 'new';
    EP.editRow = null;
    renderNewRowForm(t);
  });

  // 复制行：以选中行为模板，字段预填，RowName 留空
  const copyBtn = document.getElementById('btn-copy-row');
  if (copyBtn) copyBtn.addEventListener('click', () => copySelectedRow());

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
/* 同一行可能被反复编辑，patch 每次都是「相对磁盘原值的全量差异」，
   所以这里整体替换而不是增量合并 —— 增量合并会让「第二次改回原值」被第一次的旧值盖住。
   orig 只在第一次入队时记下（磁盘原值），之后复用。 */
function addPending(table, row, patch, orig) {
  /* 保存过程中继续改同一行，会在写盘结束后被 savedKeys 精确删除 —— 改动静默丢失。
     写入窗口很短（本地文件），直接拒绝比做并发合并简单可靠。 */
  if (EP.saving) { setStatus('正在保存，等写完后可以继续改这一行'); return; }
  const key = PK(table, row);
  const old = EP.pending.get(key);
  const base = (old && old.orig) || orig || {};
  const next = {};
  for (const [k, v] of Object.entries(patch)) {
    if (sameJson(v, base[k])) continue;
    next[k] = v;
  }
  if (!Object.keys(next).length) EP.pending.delete(key);
  else EP.pending.set(key, { table: table, row: row, patch: next, orig: base });
  updatePendingBar();
  syncDelMarks();
}

/* 删除也进队列（和编辑共用一次 diff 预览 + 一次写盘） */
function addPendingDel(table, row, refs) {
  if (EP.saving) { setStatus('正在保存，等写完后可以继续操作'); return; }
  const key = PK(table, row);
  const old = EP.pending.get(key);
  /* 这一行可能已经先改过字段、还没保存（old.patch 非空）。删除只是入队等 diff，
     不是立即抹掉数据 —— 保留原 patch，用户点「撤销删除」时才能把改动一起恢复。 */
  EP.pending.set(key, {
    table: table, row: row, del: true,
    patch: (old && !old.del && old.patch) || {},
    orig: (old && old.orig) || null,
    refs: refs || (old && old.refs) || null
  });
  updatePendingBar();
  syncDelMarks();
}

function isPendingDel(table, row) {
  const p = EP.pending.get(PK(table, row));
  return !!(p && p.del);
}

function pendingOps(items) {
  return (items || [...EP.pending.values()]).map((p) =>
    p.del ? { type: 'delete', row: p.row }
      : p.append ? { type: 'append', value: p.value }
      : { type: 'set', row: p.row, patch: p.patch });
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
  const add = all.filter((p) => p.append).length;
  const sets = n - del - add;
  const parts = [];
  if (sets) parts.push('<b>' + sets + '</b> 行待保存');
  if (add) parts.push('<b class="pb-add">+' + add + '</b> 行待新增');
  if (del) parts.push('<b class="pb-dn">' + del + '</b> 行待删除');
  bar.innerHTML = '<span class="pb-dot"></span> ' + parts.join(' <span class="pb-sep">·</span> ') +
    '<span class="pb-rows">' + all.slice(0, 3).map((p) =>
      p.del ? '<s>' + esc(p.row) + '</s>' : (p.append ? '<em>+' + esc(p.row) + '</em>' : esc(p.row))).join('、') + (n > 3 ? ' …' : '') + '</span>' +
    '<span class="spacer"></span>' +
    '<button class="btn primary" id="btn-save">预览并保存</button>' +
    '<button class="btn" id="btn-discard">放弃</button>';
  $e('#btn-save').onclick = saveAll;
  $e('#btn-discard').onclick = async () => {
    const bits = [];
    if (sets) bits.push('取消 ' + sets + ' 行待保存的修改');
    if (add) bits.push('取消 ' + add + ' 行新增');
    if (del) bits.push('取消 ' + del + ' 行删除');
    const ok = await uiConfirm('放弃这些改动？', bits.join('，') + '。 文件不会被写入。',
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

/* 外层兜底：预览 / 弹窗 / 重载任何一环抛异常，都要让用户看见。
   否则 promise 变成 unhandled rejection，状态栏永远停在「校验中…」。 */
async function saveAll() {
  if (EP.saving || !EP.pending.size) return;
  try {
    await saveAllInner();
  } catch (e) {
    console.error(e);
    setStatus('保存失败：' + ((e && e.message) || e));
    uiAlert('保存失败', String((e && e.message) || e) + '\n\n待保存队列里的改动没有丢，可以重试。');
  }
}

async function saveAllInner() {
  const groups = groupPending();
  /* 快照：保存期间用户还能继续编辑，结束时按 key 精确删除参与本次保存的条目，
     不能 EP.pending.clear()（会把保存开始后新入队的改动一起吞掉）。 */
  const savedKeys = [];
  for (const [table, items] of groups) for (const p of items) savedKeys.push(PK(table, p.row));
  setStatus('校验中…');
  await ensureDelRefs();

  const parts = [];
  for (const [table, items] of groups) {
    const delRows = items.filter((p) => p.del);
    const addRows = items.filter((p) => p.append);
    const ops = pendingOps(items);
    const { data } = await postJson('/api/preview', { table, ops });
    if (!data || !data.diff) {
      setStatus('预览失败');
      uiAlert('预览失败 · ' + table, (data && (data.error || (data.errors || []).join('\n'))) || '预览失败');
      return;
    }
    if (delRows.length) data.warnings = delWarnings(delRows).concat(data.warnings || []);
    parts.push({ table, ops, data, setCount: items.length - delRows.length - addRows.length, delCount: delRows.length, addCount: addRows.length });
  }
  setStatus('就绪');

  const totalOps = parts.reduce((s, p) => s + p.ops.length, 0);
  const totalDel = parts.reduce((s, p) => s + p.delCount, 0);
  const totalAdd = parts.reduce((s, p) => s + p.addCount, 0);
  const onlyDel = totalDel > 0 && totalDel === totalOps;
  const onlyAdd = totalAdd > 0 && totalAdd === totalOps;
  const many = parts.length > 1;
  const okText = many ? '写入 ' + parts.length + ' 张表' : (onlyDel ? '删除' : onlyAdd ? '新增' : '写入文件');
  const title = many ? '确认改动（' + parts.length + ' 张表）' : (onlyDel ? '确认删除' : onlyAdd ? '确认新增' : '确认改动');

  showMultiDiffDialog(parts, async () => {
    EP.saving = true;
    const done = [];
    try {
    for (const p of parts) {
      try {
        done.push(await DS.apply(p.table, p.ops));
      } catch (e) {
        /* 冲突：磁盘被人改过，写盘还没开始（或只写了前面几张表）。
           这种情况不删队列 —— 用户的改动是好的，只是基线过期了。 */
        if (e && e.conflict) {
          const rolled2 = [];
          const fail2 = [];
          for (const d of done) { try { await DS.undo(d.backup); rolled2.push(d.table); } catch (e2) { fail2.push(d.table + '（备份 ' + d.backup + '）'); } }
          uiAlert('没有保存：文件已被外部修改', p.table + '\n\n' + e.message +
            (rolled2.length ? '\n\n已还原本次已写入的：' + rolled2.join('、') : '') +
            (fail2.length ? '\n\n⚠ 这几张表回滚失败，需要手动还原：' + fail2.join('、') : '') +
            '\n\n你的改动还在待保存队列里。');
          await reloadAfterSave(parts.map((x) => x.table));
          setStatus('保存已取消 · 外部改动未受影响');
          return false;
        }
        const rolled = [];
        const failed = [];
        for (const d of done) { try { await DS.undo(d.backup); rolled.push(d.table); } catch (e2) { failed.push(d.table + '（备份 ' + d.backup + '）'); } }
        for (const k of savedKeys) EP.pending.delete(k);
        updatePendingBar();
        syncDelMarks();
        uiAlert(failed.length ? '保存失败，部分回滚失败' : '保存失败，已回滚', p.table + '：' + e.message +
          (rolled.length ? '\n\n已还原：' + rolled.join('、') : '') +
          (failed.length ? '\n\n⚠ 这几张表回滚失败，需要手动还原：' + failed.join('、') : ''));
        await reloadAfterSave(parts.map((x) => x.table));
        setStatus('保存失败');
        return false;
      }
    }
    for (const k of savedKeys) EP.pending.delete(k);
    updatePendingBar();
    syncDelMarks();
    await reloadAfterSave(parts.map((x) => x.table));
    const bits = [];
    const setTotal = totalOps - totalDel - totalAdd;
    if (setTotal) bits.push('修改 ' + setTotal + ' 处');
    if (totalAdd) bits.push('新增 ' + totalAdd + ' 行');
    if (totalDel) bits.push('删除 ' + totalDel + ' 行');
    if (many) bits.push(parts.length + ' 张表');
    const bs = done.map((d) => d.backup);
    setStatus((bits.join(' · ') || '已写入') + ' · 备份 ' + (bs.length > 1 ? bs[0] + ' 等 ' + bs.length + ' 个' : bs[0]));
    return true;
    } finally { EP.saving = false; updatePendingBar(); }
  }, okText, title);
}

/* ---------------- diff 弹层 ---------------- */
function hunksHtml(d) {
  let body = d.hunks.map((h) => {
    const aStart = Math.max(1, h.aStart - h.before.length);
    return '<div class="hunk"><div class="hunk-head">@@ 第 ' + aStart + ' 行 @@</div>' +
      h.before.map((l) => '<div class="dl ctx">' + esc(l) + '</div>').join('') +
      h.aLines.map((l) => '<div class="dl del">- ' + esc(l) + '</div>').join('') +
      h.bLines.map((l) => '<div class="dl add">+ ' + esc(l) + '</div>').join('') +
      h.after.map((l) => '<div class="dl ctx">' + esc(l) + '</div>').join('') +
      '</div>';
  }).join('');
  // 差异过多时 diff 只返回前 N 段（json-diff.js 的 maxHunks），
  // 不提示的话用户会以为这就是全部改动。
  if (d.truncated) {
    body += '<div class="hunk-more">差异过多，只显示前 ' + d.hunks.length + ' 段（共 ' + d.hunkCount +
      ' 段、删除 ' + d.removedLines + ' 行 / 新增 ' + d.addedLines + ' 行）。写入前把关一下改动的范围。</div>';
  }
  return body;
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
  const hunkHtml = hunksHtml(d);

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

/* 进编辑/新增态时把右栏拉宽到「中间只剩 RowName 那一列」，退出时还原。
   宽度状态在 layout.js 里，这里只按当前模式开关。 */
function syncEditFocus() {
  const on = EP.detailMode === 'edit' || EP.detailMode === 'new';
  if (window.LAYOUT && window.LAYOUT.editFocus) window.LAYOUT.editFocus(on);
}

window.renderDetail = function (row) {
  // 点了别的行（或清空选择）就退出编辑态，否则会把上一行的表单套到新行上
  if (EP.detailMode === 'edit' && (!row || row.RowName !== EP.editRow)) { EP.detailMode = 'view'; EP.draft = null; EP.newBase = null; EP.editShown = null; }
  // 新增行没填完就去点别的行：直接放弃这份表单（它还没进队列，没有副作用）
  if (EP.detailMode === 'new' && row) { EP.detailMode = 'view'; EP.draft = null; EP.newBase = null; }
  syncEditFocus();
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
  EP.detailMode = 'edit';
  syncEditFocus();
  const t = state.sem.tables[state.cur];
  const fields = t.fields.filter((f) => f.name !== 'RowName');
  const el = $e('#detail');

  // draft 只装「走结构化编辑」的字段，其它字段仍然从 DOM 读
  EP.draft = { values: {}, fields: new Set() };

  /* 表单显示「磁盘值 + 已入队的改动」。只显示磁盘值的话，同一行第二次编辑时
     用户看到的是旧值，保存的却是队列里的新值 —— 以为改回原值，实际没有。 */
  const pend = EP.pending.get(PK(state.cur, row.RowName));
  const shown = pend && !pend.del ? Object.assign({}, row, pend.patch) : row;
  EP.editShown = shown;

  const rowsHtml = fields.map((f) => {
    let ctrl;
    if (typeof SE !== 'undefined' && SE.supports(f)) {
      EP.draft.values[f.name] = SE.normalize(f, shown[f.name]);
      EP.draft.fields.add(f.name);
      ctrl = SE.fieldHtml(f, EP.draft.values[f.name]);
    } else {
      ctrl = ctrlHtml(t, f, shown[f.name]);
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

  $e('#ed-cancel').onclick = () => { EP.detailMode = 'view'; EP.editRow = null; EP.draft = null; EP.editShown = null; renderDetail(row); };
  $e('#ed-apply').onclick = () => applyForm(row, t);
  el.querySelectorAll('[data-goto-target]').forEach((b) => b.addEventListener('click', () => {
    /* 优先读输入框当前值：用选择器改过之后 data-goto-row 里的是旧值 */
    const inp = b.parentElement && b.parentElement.querySelector('[data-rp]');
    const cur = inp ? inp.value : b.dataset.gotoRow;
    if (cur) goTo(b.dataset.gotoTarget, cur);
  }));
}


/* ---------------- 新增行 ----------------
   和编辑同一套机制：填完先入「待保存队列」，底部「预览并保存」过 diff 才写盘。
   只把用户真填了的字段写进 JSON —— 没动的字段不出现在新行里，避免写一堆空值。 */
function renderNewRowForm(t, src) {
  EP.detailMode = 'new';
  syncEditFocus();
  const fields = t.fields.filter((f) => f.name !== 'RowName');
  const el = $e('#detail');
  const from = src || null;
  /* 复制行的基线快照：collectForm 拿它判断「哪些字段没动」，
     没动的字段连 JSON 类型一起原样带进新行（别把 "0.75" 写成 0.75）。 */
  EP.newBase = from ? JSON.parse(JSON.stringify(from)) : {};

  EP.draft = { values: {}, fields: new Set() };

  const rowsHtml = fields.map((f) => {
    const init = from ? from[f.name] : undefined;
    let ctrl;
    if (typeof SE !== 'undefined' && SE.supports(f)) {
      EP.draft.values[f.name] = SE.normalize(f, init);
      EP.draft.fields.add(f.name);
      ctrl = SE.fieldHtml(f, EP.draft.values[f.name]);
    } else {
      ctrl = ctrlHtml(t, f, init);
    }
    return '<div class="f-row ed-row"><div class="f-key">' + fkeyHtml(f) +
      (f.target ? '<span class="k-target">→ ' + esc(f.target) + '</span>' : '') + '</div>' +
      '<div class="f-val">' + ctrl + '</div>' +
      (f.desc ? '<div class="f-desc" title="' + esc(f.desc) + '">' + esc(f.desc) + '</div>' : '') +
      '</div>';
  }).join('');

  el.innerHTML = '<div class="d-head"><div class="d-rn">' + (from ? '复制自 ' + esc(from.RowName) : '新增行') +
    '<span class="ed-tag">未保存</span></div>' +
    '<div class="d-summary">' + esc(t.name) +
    (from ? ' · 字段已按模板预填，填个新行名就是新的一行' : ' · 只写入填了值的字段') + '</div></div>' +
    '<div class="d-body ed-form">' +
    '<div class="f-row ed-row"><div class="f-key"><span class="fk-cn">行名</span><span class="fk-en">RowName</span></div>' +
    '<div class="f-val"><input class="ed-ctl mono" id="new-rowname" placeholder="必填 · 表内唯一" autocomplete="off" spellcheck="false" /></div>' +
    '<div class="f-desc">' + (from ? '复制不会沿用原行名 —— 这里必须填一个新名字' : '这一行的唯一标识；别的表靠这个名字引用本行') + '</div></div>' +
    rowsHtml + '</div>' +
    '<div class="ed-foot"><button class="btn" id="new-cancel">取消 <kbd>Esc</kbd></button>' +
    '<button class="btn primary" id="new-add">加入待保存 <kbd>Ctrl ↵</kbd></button></div>';
  el.scrollTop = 0;

  if (typeof SE !== 'undefined') SE.bind(el.querySelector('.ed-form'), EP.draft);
  $e('#new-cancel').onclick = () => { EP.detailMode = 'view'; EP.draft = null; EP.newBase = null; renderDetail(null); };
  $e('#new-add').onclick = () => applyNewRow(t);
  const rn = $e('#new-rowname');
  if (rn) rn.focus();
}

async function applyNewRow(t) {
  const rnEl = $e('#new-rowname');
  const rn = (rnEl ? rnEl.value : '').trim();
  if (!rn) { uiAlert('RowName 不能为空', 'RowName 是这一行的唯一标识，别的表靠它引用本行。'); if (rnEl) rnEl.focus(); return; }
  if (/\s/.test(rn)) { uiAlert('RowName 里有空格', '当前值：' + rn + '\n配置里的 RowName 一律不带空格（列编辑也是按名字定位的）。'); if (rnEl) rnEl.focus(); return; }
  try { await DS.notes(t.name); } catch (e) { }
  if (DS.hasRow(t.name, rn)) {
    uiAlert('RowName 已存在', t.name + ' 里已经有 ' + rn + ' 这一行。换一个名字，或直接编辑那一行。');
    if (rnEl) rnEl.focus();
    return;
  }
  const { patch, bad } = collectForm(t, {}, EP.newBase);
  if (bad.length) { uiAlert('有字段无法解析', bad.join('\n')); return; }
  const value = Object.assign({ RowName: rn }, patch);
  EP.pending.set(PK(t.name, rn), { table: t.name, row: rn, append: true, value: value });
  EP.detailMode = 'view';
  EP.editRow = null;
  EP.draft = null;
  EP.newBase = null;
  updatePendingBar();
  syncDelMarks();
  $e('#detail').innerHTML = '<div class="d-head"><div class="d-rn">' + esc(rn) +
    '<span class="ed-tag">待新增</span></div>' +
    '<div class="d-summary">' + esc(t.name) + ' · 已加入待保存队列</div></div>' +
    '<div class="d-body"><div class="d-del-note"><b>已加入新增队列</b>' +
    '<span>点底部「预览并保存」后才写入文件；可以继续新增下一行</span></div></div>';
  setStatus('已加入新增队列（' + rn + '）· 共 ' + Object.keys(patch).length + ' 个字段');
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function isEmptyStruct(v) {
  if (Array.isArray(v)) return v.length === 0;
  if (v && typeof v === 'object') return Object.keys(v).length === 0;
  return v === '' || v === null;
}

/* 把控件里的文本解析成 JSON 值。orig 只用来决定枚举 / 数值该转成什么类型。 */
function parseScalar(f, el, raw, orig) {
  let val;
  let has = true;
  if (el.classList.contains('ed-json')) {
    if (!raw.trim()) has = false;
    else {
      try { val = JSON.parse(raw); } catch (e) { return { err: f.name + '：JSON 非法 — ' + e.message }; }
    }
  } else if (f.kind === 'bool') {
    if (raw === '') has = false; else val = raw === 'true';
  } else if (f.kind === 'number' || f.kind === 'int') {
    if (raw === '') has = false;
    else {
      const n = Number(raw);
      if (Number.isNaN(n)) return { err: f.name + '：不是数字' };
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
  return { has: has, val: val };
}

/* base 非空 = 新增 / 复制行：控件已经按模板值预填，没动的字段要「原样带上」而不是跳过。
   编辑模式（base 为 null）沿用老逻辑：只收真正变化的字段。 */
function collectForm(t, row, base) {
  const patch = {};
  const bad = [];
  const structFields = (EP.draft && EP.draft.fields) || new Set();
  const formEl = $e('#detail .ed-form');
  const isNew = !!base;

  for (const f of t.fields) {
    if (f.name === 'RowName') continue;
    const orig = isNew ? base[f.name] : row[f.name];

    // 结构化字段：真源是 draft，DOM 只负责显示
    if (structFields.has(f.name)) {
      const val = EP.draft.values[f.name];
      // 原值缺省或 null、编辑器里又是空容器（结构化编辑器会把 null 兜成 {} / []）＝没内容
      if ((orig === undefined || orig === null) && isEmptyStruct(val)) continue;
      if (!isNew && sameJson(orig, val)) continue;
      patch[f.name] = val;
      continue;
    }

    const el = formEl && formEl.querySelector('[data-field="' + f.name + '"]');
    if (!el) continue;
    const raw = el.value;

    /* 「有没有动」要跟表单显示值比（它可能带着队列里的改动）；
       「改动是什么」要跟磁盘值比 —— 两者分开，第二次编辑才能既保留队列值、
       又能在用户显式改回磁盘值时把队列里的改动撤掉。 */
    const shownV = (!isNew && EP.editShown) ? EP.editShown[f.name] : orig;
    if (shownV !== undefined && shownV !== null && typeof shownV !== 'object' && raw === String(shownV)) {
      if (isNew) patch[f.name] = orig;                        // 复制行要带上它，且保持原始 JSON 类型
      else if (!sameJson(orig, shownV)) patch[f.name] = shownV; // 队列里已有的改动继续保留
      continue;
    }

    const got = parseScalar(f, el, raw, orig);
    if (got.err) { bad.push(got.err); continue; }

    // 空输入框不等于「把字段改成空串」；复制行里清空则回落模板值
    if (!got.has) {
      if (isNew && orig !== undefined && orig !== null) patch[f.name] = orig;
      continue;
    }
    const val = got.val;
    // 原本就没有这个字段、或者是 null，空串不算改动（null 和 "" 在反序列化时同义）
    if (val === '' && (orig === undefined || orig === null)) continue;
    if (!isNew && sameJson(orig, val)) continue;
    // 数值字段的原文可能写成字符串（"0.75"、"1"）、布尔也可能写成 "true"；
    // 只要文本等价就算没改，别顺手把 JSON 类型改掉。
    if (typeof orig !== 'object' && orig !== undefined && orig !== null && String(orig) === String(val)) {
      if (isNew) patch[f.name] = orig;
      continue;
    }
    patch[f.name] = val;
  }
  return { patch, bad };
}

/* ---------------- 编辑表单快捷键 ---------------- */
/* Ctrl/Cmd + Enter 或 Ctrl/Cmd + S = 应用修改；Esc = 取消。
   有弹层打开时让位：引用选择器 / 命令面板 / diff 弹窗 / 确认框 / 列编辑都会先用 Escape。
   它们的处理函数已经 preventDefault，这里靠 defaultPrevented 判断，避免一次 Esc 把编辑也关掉。 */
function overlayOpen() {
  return !!document.querySelector('.rp-mask:not([hidden]), .cmdk-mask:not([hidden]), .cfm-mask, .modal-mask, .ce-mask, .gd-mask:not([hidden])');
}
function isTyping(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || !!el.isContentEditable;
}

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;

  /* 新增态：Ctrl/Cmd+Enter 加入队列，Esc 取消 */
  if (EP.detailMode === 'new') {
    const add = $e('#new-add');
    const cancel = $e('#new-cancel');
    if (!add || !cancel) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'Enter' || e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      add.click();
      return;
    }
    if (e.key === 'Escape') {
      if (overlayOpen()) return;
      e.preventDefault();
      cancel.click();
    }
    return;
  }

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

  /* 只读态：E 编辑本行，Delete 删除本行，Ctrl+D 复制本行 */
  if (overlayOpen() || isTyping(e.target)) return;
  /* Ctrl/Cmd+D 复制：Excel 的 duplicate 手感，顺手吞掉浏览器「加入书签」 */
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'd' || e.key === 'D')) {
    if (EP.detailMode !== 'view') return;
    const cn = state.selRow;
    const crow = cn ? (state.rows || []).find((x) => x.RowName === cn) : null;
    if (!crow) return;
    e.preventDefault();
    copyRowFlow(crow);
    return;
  }
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
  EP.editShown = null;
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


/* ---------------- 复制行 ----------------
   以选中行为模板开一张「新增行」表单：字段预填模板值，RowName 留空。
   入队仍然是 append op，和其它新增共用一次 diff 预览 + 一次写盘。 */
function copyRowFlow(row) {
  const t = state.sem.tables[state.cur];
  if (!t) return;
  if (!row) { setStatus('先在中间表格里选一行，再点「复制行」'); return; }
  EP.detailMode = 'new';
  EP.editRow = null;
  renderNewRowForm(t, row);
  setStatus('正在复制 ' + row.RowName + ' · 填一个新行名后加入待保存');
}

function copySelectedRow() {
  const rn = state.selRow || currentSelRow();
  const row = rn ? (state.rows || []).find((x) => x.RowName === rn) : null;
  copyRowFlow(row);
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
  const key = PK(state.cur, row.RowName);
  const old = EP.pending.get(key);
  /* 撤销删除：如果这行在删除前还有未保存的字段改动，恢复成编辑项，而不是直接扔掉。 */
  if (old && old.del && old.patch && Object.keys(old.patch).length) {
    EP.pending.set(key, { table: state.cur, row: row.RowName, patch: old.patch, orig: old.orig || {} });
    setStatus('已撤销删除（保留之前的字段改动）');
  } else {
    EP.pending.delete(key);
    setStatus('已撤销删除');
  }
  updatePendingBar();
  syncDelMarks();
  renderDetail(row);
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

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn';
  copyBtn.title = '以这一行为模板新增一行（Ctrl+D）';
  copyBtn.innerHTML = '复制本行 <kbd>Ctrl D</kbd>';
  copyBtn.onclick = () => copyRowFlow(row);

  const delBtn = document.createElement('button');
  delBtn.className = 'btn danger';
  delBtn.title = '删除本行（Delete）';
  delBtn.innerHTML = '删除本行 <kbd>Del</kbd>';
  delBtn.onclick = () => deleteRowFlow(row);

  wrap.appendChild(editBtn);
  wrap.appendChild(copyBtn);
  wrap.appendChild(delBtn);
  head.appendChild(wrap);
  syncCopyBtn();
};

/* 工具条「复制行」在没有选中行时置灰，避免用户点了才发现要选行 */
function syncCopyBtn() {
  const btn = document.getElementById('btn-copy-row');
  if (!btn) return;
  const rn = state.selRow;
  const has = !!(rn && (state.rows || []).some((x) => x.RowName === rn));
  btn.disabled = !has;
  btn.title = has ? ('以 ' + rn + ' 为模板新增一行（填个新行名即可）') : '先在中间表格里选一行';
}

/* 表格每次重渲染都会丢掉 .tr-del 类，这里挂一层包装补回来 */
const baseRenderGrid = window.renderGrid;
window.renderGrid = function () {
  baseRenderGrid();
  syncDelMarks();
  syncCopyBtn();
};

/* 给 Git 面板用：切分支 / 拉取前要知道有没有未保存的改动 */
window.EDIT = { hasPending: () => EP.pending.size > 0 };

/* ---------------- 启动 ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  mountEditBar();
});