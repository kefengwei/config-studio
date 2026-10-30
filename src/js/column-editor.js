(function () {
/* 配置工作台 · 列编辑（Excel 式按列编辑）
 *
 * 与「批量编辑」的区别：
 *   批量编辑 = 勾选 N 行 → 给同一字段填同一个值
 *   列编辑   = 选一条字段路径 → 每行独立编辑，像 Excel 的一列
 *
 * 路径可以下钻到嵌套结构：Rewards[*].RequiredValue
 *   * 表示数组任意下标，会展开成多列（#1 #2 #3 …）
 * 落盘走 /api/preview + /api/apply 的 { type:'setpath' }，只替换目标值区间。
 */
const CE = {
  S: null,          // { table, field, pattern, cols, rows, edits, sel, anchor, shown, q }
  MAX_ROWS: 2000,
  CELL_BUDGET: 6000,
};
window.CE = CE;

const ceEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ceEl = (s) => document.querySelector(s);
const KEY = (row, path) => row + '\u0000' + JSON.stringify(path);
const COLK = (col) => JSON.stringify(col || []);
const colLabel = (col) => (!col || !col.length ? '值' : '#' + col.map((x) => x + 1).join('.'));
const colTitle = (col) => {
  if (!col || !col.length) return '整列：该字段每行只有一个值';
  if (col.length === 1) return '该数组的第 ' + (col[0] + 1) + ' 项';
  return col.map((x, i) => '第 ' + (i + 1) + ' 层第 ' + (x + 1) + ' 项').join('、');
};

function fmtVal(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/* 执行器中文名：与 struct-editor.js 的 ACT_CN 保持同一套高频表 */
const ACT_CN = {
  AddCatalogItem: '发放物品', WeightRandom: '按权重随机抽取', Statistic: '累计统计进度',
  AddEquipment: '发放装备', AddPlayerAttribute: '增加玩家属性', AddEngagementValue: '增加活跃值',
  ForceAddStatisticValue: '直接设置统计值', GenerateGem: '生成宝石', BuyGiftPack: '发放礼包',
  UnlockPlayerCustom: '解锁个性化', AddBuff: '增加增益', AddItem: '发放道具',
};
function actLabel(n) {
  if (!n) return '';
  const cn = ACT_CN[n] || (state.sem && state.sem.actuators[n] ? state.sem.actuators[n].desc : '') || '';
  const label = cn && cn !== n ? cn : n;
  return label.length > 18 ? label.slice(0, 18) + '…' : label;
}

/* 单元格的元信息（决定控件类型与引用选择器）：
   1) 执行器展开时，看该参数在 C# 里的声明（target / type / desc）
   2) 普通行级字段（path 只有一层）时，看表定义里它自己是不是引用字段，例如 Task.TimeControlRowName */
function cellMeta(cell) {
  const A = CE.S && CE.S.actuator;
  if (A && A.params) {
    const key = cell.path[cell.path.length - 1];
    if (A.params[key]) return A.params[key];
  }
  if (cell.path.length === 1 && state.sem && state.sem.tables[CE.S.table]) {
    const fields = state.sem.tables[CE.S.table].fields || [];
    const fd = fields.find((x) => x.name === cell.path[0]);
    if (fd && fd.kind === 'ref' && fd.target) return { target: fd.target, desc: fd.desc, type: 'string' };
  }
  return null;
}

function valType(v, meta) {
  if (meta) {
    if (meta.target) return 'ref';
    const t = Array.isArray(meta.type) ? meta.type : [meta.type];
    if (t.includes('boolean')) return 'bool';
    if (t.includes('integer') || t.includes('number')) return 'num';
  }
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'num';
  return 'str';
}


/* ---------- 1. 取样收集该字段所有可编辑叶子路径 ---------- */
function leavesOfSamples(fieldName) {
  const out = new Map(); // json(path) -> { path, sample, depth, maxLen, hits }
  let curRowSet = null;
  const add = (path, sample, lenHint, act, whole) => {
    // key 必须带上执行器名：AddCatalogItem 和 GenerateGem 在同一个数组位置
    // 都各有一组参数；若共用 "FreshRewards[*]" 这个 key，先遍历到的执行器会
    // 独占「整条」，后面几个执行器分组里就看不到自己的成组视图。
    const actName = act ? act.name : '';
    const k = JSON.stringify(path) + (actName ? '|@' + actName : '');
    const len = lenHint || 0;
    const prev = out.get(k);
    const meta = { act: actName || null, actDepth: act ? act.depth : -1, whole: !!whole };
    if (prev) {
      prev.maxLen = Math.max(prev.maxLen, len);
      if (!prev.act && meta.act) Object.assign(prev, meta);
      if (meta.whole) prev.whole = true;
    } else out.set(k, { key: k, path, sample, depth: path.length, maxLen: len, hits: 0, ...meta });
    if (curRowSet) curRowSet.add(k);
  };
  // 执行器节点形如 { Name: 'AddCatalogItem', JsonInput: {...} }：
  // JsonInput 里的参数只有同一种执行器才有共同语义，必须按类型分组，不能混在一列
  const isActuator = (v) => v && typeof v === 'object' && !Array.isArray(v) &&
    typeof v.Name === 'string' && v.JsonInput && typeof v.JsonInput === 'object' && !Array.isArray(v.JsonInput);
  const visit = (v, path, depth, lenHint, act) => {
    if (depth > 8) return;
    if (v === null || typeof v !== 'object') { add(path, v, lenHint, act); return; }
    if (Array.isArray(v)) {
      if (!v.length) return;
      const objs = v.filter((x) => x && typeof x === 'object').slice(0, 30);
      if (!objs.length) { add(path.concat('*'), v.slice(0, 3).join(', '), v.length, act); return; }
      for (const o of objs) visit(o, path.concat('*'), depth + 1, (lenHint || 1) * v.length, act);
      return;
    }
    const self = isActuator(v);
    const next = self ? { name: v.Name, depth: path.length - 1 } : act;
    // 整条入口：一次调用 = 一组参数列。单独看 RowName 或 Count 都没有对应关系
    if (self) add(path, Object.keys(v.JsonInput).join(', '), lenHint, next, true);
    const keys = Object.keys(v);
    if (!keys.length) { add(path, '{}', lenHint, act); return; }
    for (const k of keys) {
      if (self && k === 'Name') continue;  // 执行器名本身就是分组依据，不作为可编辑列
      visit(v[k], path.concat(k), depth + 1, lenHint, next);
    }
  };
  for (const r of state.rows) {
    const v = r[fieldName];
    if (v === undefined || v === null) continue;
    curRowSet = new Set();
    visit(v, [fieldName], 0, 0, null);
    for (const k of curRowSet) { const it = out.get(k); if (it) it.hits++; }
    curRowSet = null;
  }
  const total = state.rows.length || 1;
  for (const it of out.values()) it.coverage = it.hits / total;
  return [...out.values()];
}

function pathLabel(path) {
  return path.map((p) => (p === '*' ? '[*]' : p)).join(' › ');
}

/* ---------- 2. 弹层骨架 ---------- */
// 面板宽度可调：拖右边缘，宽度记进 localStorage，双击手柄恢复默认。
// 面板是居中的，鼠标位移的一半会被左边吃掉，所以要乘 2 手柄才跟手。
const CE_WIDTH_KEY = 'cs.ceWidth';
function initResize(panel) {
  if (!panel) return;
  const h = panel.querySelector('.ce-resize');
  if (!h) return;
  try {
    const saved = Number(localStorage.getItem(CE_WIDTH_KEY)) || 0;
    if (saved > 0) panel.style.width = saved + 'px';
  } catch (e) { /* localStorage 不可用就用默认宽度 */ }
  let sx = 0, sw = 0, dragging = false;
  const clamp = (w) => Math.round(Math.min(Math.round(innerWidth * 0.96), Math.max(680, w)));
  const down = (e) => {
    e.preventDefault();
    dragging = true;
    sx = e.clientX;
    sw = panel.getBoundingClientRect().width;
    h.classList.add('dragging');
    try { h.setPointerCapture(e.pointerId); } catch (err) {} 
  };
  const move = (e) => {
    if (!dragging) return;
    panel.style.width = clamp(sw + (e.clientX - sx) * 2) + 'px';
  };
  const up = () => {
    if (!dragging) return;
    dragging = false;
    h.classList.remove('dragging');
    try { localStorage.setItem(CE_WIDTH_KEY, String(Math.round(panel.getBoundingClientRect().width))); } catch (err) {}
  };
  h.addEventListener('pointerdown', down);
  h.addEventListener('pointermove', move);
  h.addEventListener('pointerup', up);
  h.addEventListener('pointercancel', up);
  h.addEventListener('dblclick', () => {
    panel.style.width = '';
    try { localStorage.removeItem(CE_WIDTH_KEY); } catch (err) {}
  });
}

CE.open = function (fieldName, seedRowFilters) {
  if (!state.cur) return;
  const t = state.sem.tables[state.cur];
  const fields = t.fields.filter((f) => f.name !== 'RowName');
  if (!fields.length) return;

  const startField = fields.find((f) => f.name === fieldName) || fields.find((f) => f.kind !== 'text') || fields[0];

  // 主表格已经筛过行时，把条件带进来（否则「主表格筛出 191 行」进面板变 2380 行）
  const seed = (seedRowFilters || []).map((f) => ({ col: '@' + f.field, op: f.op, val: f.val }));
  CE.S = { table: state.cur, field: startField.name, pattern: null, cols: [], allCols: [], colFill: new Map(), hideEmptyCols: true, rows: [], rowFields: [], edits: new Map(), sel: null, anchor: null, q: '', onlyFilled: false, filters: seed };

  const m = document.createElement('div');
  m.className = 'ce-mask';
  m.innerHTML =
    '<div class="ce-panel">' +
      '<div class="ce-head"><h3>列编辑</h3><span class="ce-sub" id="ce-sub">' + ceEsc(state.cur) + '</span>' +
        '<button class="ce-x" data-x="close">×</button></div>' +
      '<div class="ce-picker">' +
        '<label>字段</label><select id="ce-field">' +
          fields.map((f) => '<option value="' + ceEsc(f.name) + '"' + (f.name === startField.name ? ' selected' : '') + '>' + ceEsc(f.name) + '　' + ceEsc(f.kind) + '</option>').join('') +
        '</select>' +
        '<label>路径</label><select id="ce-path"></select>' +
        '<input id="ce-q" placeholder="筛行名…" />' +
        '<label class="ce-only"><input type="checkbox" id="ce-only" /> 只看有值</label>' +
        '<label class="ce-only"><input type="checkbox" id="ce-hidecol" checked /> 隐藏空列</label>' +
      '</div>' +
      '<div class="ce-quick" id="ce-quick" hidden></div>' +
      '<div class="ce-filter" id="ce-filter">' +
        '<span class="cf-l">按属性筛选</span>' +
        '<select id="ce-f-col"></select>' +
        '<select id="ce-f-op">' +
          '<option value="=">= 等于</option>' +
          '<option value="!=">≠ 不等于</option>' +
          '<option value=">">&gt; 大于</option>' +
          '<option value=">=">≥ 大于等于</option>' +
          '<option value="<">&lt; 小于</option>' +
          '<option value="<=">≤ 小于等于</option>' +
          '<option value="contains">包含</option>' +
          '<option value="empty">为空</option>' +
          '<option value="notempty">非空</option>' +
        '</select>' +
        '<input id="ce-f-val" placeholder="值…" />' +
        '<button class="btn" data-x="fadd">添加</button>' +
        '<div class="cf-chips" id="ce-f-chips"></div>' +
        '<span class="cf-note" id="ce-f-note"></span>' +
      '</div>' +
      '<div class="ce-scope" id="ce-scope" hidden></div>' +
      '<div class="ce-body"><div class="ce-empty">选择一条路径</div></div>' +
      '<div class="ce-foot">' +
        '<span class="ce-count" id="ce-count">未改动</span>' +
        '<span class="ce-spacer"></span>' +
        '<div class="ce-bulk" id="ce-bulk" hidden>' +
          '<span class="ce-selsum" id="ce-selsum"></span>' +
          '<input id="ce-set" placeholder="填充值…" />' +
          '<button class="btn" data-x="setcol">填充</button>' +
          '<span>' +
            '<input id="ce-mul" placeholder="倍数" />' +
            '<button class="btn" data-x="mulcol">× 应用</button>' +
          '</span>' +
          '<span class="ce-when-1col" id="ce-step-wrap" hidden>' +
            '<input id="ce-step" placeholder="步长" />' +
            '<button class="btn" data-x="fillcol">递增</button>' +
          '</span>' +
          '<button class="btn" data-x="clearsel">清空改动</button>' +
        '</div>' +
        '<button class="btn" data-x="close">关闭</button>' +
        '<button class="btn primary" data-x="save">预览并保存</button>' +
      '</div>' +
      '<div class="ce-resize" title="拖动调整宽度 · 双击恢复默认"></div>' +
    '</div>';
  document.body.appendChild(m);
  initResize(m.querySelector('.ce-panel'));

  m.querySelector('#ce-field').onchange = (e) => {
    CE.S.field = e.target.value;
    CE.S.pattern = null;
    CE.S.edits.clear();
    CE.S.sel = null;
    CE.S.anchor = null;
    CE.S.filters = (CE.S.filters || []).filter(isRowFilter);
    fillPaths();
  };
  m.querySelector('#ce-path').onchange = (e) => {
    if (!e.target.value) return;
    selectPath(e.target.value);
  };
  m.querySelector('#ce-q').oninput = (e) => {
    CE.S.q = e.target.value.trim().toLowerCase();
    renderScope();
    renderGrid();
  };
  m.querySelector('#ce-only').onchange = (e) => {
    CE.S.onlyFilled = e.target.checked;
    applyColFilter();
    fillFilterCols();
    renderScope();
    renderGrid();
  };
  m.querySelector('#ce-hidecol').onchange = (e) => {
    CE.S.hideEmptyCols = e.target.checked;
    applyColFilter();
    renderScope();
    renderGrid();
  };
  // 按属性筛选：条件叠加（AND），只影响显示与批量作用域
  const fOp = m.querySelector('#ce-f-op');
  const fVal = m.querySelector('#ce-f-val');
  const syncFVal = () => { fVal.disabled = fOp.value === 'empty' || fOp.value === 'notempty'; };
  fOp.onchange = syncFVal;
  syncFVal();
  const addFilter = () => {
    const col = m.querySelector('#ce-f-col').value;
    const op = fOp.value;
    const val = fVal.value.trim();
    if (!col) return;
    if (op !== 'empty' && op !== 'notempty' && val === '') { fVal.focus(); return; }
    CE.S.filters = (CE.S.filters || []).filter((f) => !(f.col === col && f.op === op));
    CE.S.filters.push({ col, op, val });
    fVal.value = '';
    renderFilters();
    renderScope();
    renderGrid();
  };
  m.querySelector('[data-x="fadd"]').onclick = addFilter;
  fVal.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addFilter(); } };
  m.querySelector('#ce-f-chips').onclick = (e) => {
    const b = e.target.closest('[data-fi]');
    if (!b) return;
    const i = Number(b.dataset.fi);
    CE.S.filters.splice(i, 1);
    renderFilters();
    renderScope();
    renderGrid();
  };
  const closePanel = async () => {
    if (!document.body.contains(m)) return;
    const n = dirtyOps().length;
    if (n) {
      const ok = await uiConfirm('放弃列编辑改动？', '还有 ' + n + ' 格改动没有写入文件。', {
        okText: '放弃并关闭',
        danger: true,
      });
      if (!ok) return;
    }
    m.remove();
    document.removeEventListener('keydown', onKey);
  };
  /* Esc 关闭列编辑。有引用选择器 / 确认框压在它上面时让位（它们自己会处理 Esc）。 */
  const onKey = (e) => {
    if (!document.body.contains(m)) { document.removeEventListener('keydown', onKey); return; }
    if (e.defaultPrevented) return;
    if (document.querySelector('.rp-mask:not([hidden]), .cfm-mask')) return;
    const typing = document.activeElement && document.activeElement.tagName === 'INPUT';
    // Ctrl/Cmd+A：焦点不在输入框里时，全选当前筛选结果
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A') && !typing) {
      const rows = CE.S.shown || filteredRows();
      if (!rows.length || !CE.S.cols.length) return;
      e.preventDefault();
      CE.S.sel = { r0: 0, c0: 0, r1: rows.length - 1, c1: CE.S.cols.length - 1 };
      CE.S.anchor = { r: 0, c: 0 };
      paintSel();
      return;
    }
    if (e.key !== 'Escape') return;
    e.preventDefault();
    // 逐层退出：有选区先清选区，再按一次才关面板
    if (CE.S.sel) { CE.S.sel = null; CE.S.anchor = null; paintSel(); return; }
    closePanel();
  };
  document.addEventListener('keydown', onKey);
  m.querySelectorAll('[data-x="close"]').forEach((b) => { b.onclick = closePanel; });
  m.querySelector('[data-x="setcol"]').onclick = () => applySetSel(m);
  m.querySelector('[data-x="mulcol"]').onclick = () => applyMulSel(m);
  m.querySelector('[data-x="fillcol"]').onclick = () => applyFillCol(m);
  m.querySelector('[data-x="clearsel"]').onclick = () => clearSelEdits();
  m.querySelector('[data-x="save"]').onclick = () => saveColumn(m);

  fillPaths();
};

/* 深链接：/?ce=Rewards#/Config_Task/Task_X 直接打开列编辑（方便分享和截图） */
let ceAutoTries = 0;
function ceAutoOpen() {
  const field = new URLSearchParams(location.search).get('ce');
  if (!field) return;
  if (!state.cur || !state.rows || !state.rows.length) {
    if (++ceAutoTries > 40) { setStatus('等待表格数据超时，无法自动打开列编辑'); return; }
    setTimeout(ceAutoOpen, 400);
    return;
  }
  CE.open(field);
}
document.addEventListener('DOMContentLoaded', () => setTimeout(ceAutoOpen, 700));

function fillPaths() {
  const sel = ceEl('#ce-path');
  if (!sel) return;
  const leaves = leavesOfSamples(CE.S.field);
  if (!leaves.length) {
    sel.innerHTML = '<option value="">（当前页样本里这个字段没有值）</option>';
    return;
  }
  const byCov = (a, b) => b.coverage - a.coverage || a.path.join('.').localeCompare(b.path.join('.'));
  const opt = (l) => {
    const samp = l.sample === undefined ? '' : '　例：' + fmtVal(l.sample).slice(0, 20);
    const cov = '　' + Math.round(l.coverage * 100) + '% 行';
    const cols = l.maxLen > 1 ? ' · ' + l.maxLen + ' 列' : '';
    // 整条必须标出执行器名：同一路径下每种执行器各有一条整条入口
    const tag = l.whole ? '　整条 · ' + (l.act || '') : '';
    return '<option value="' + ceEsc(l.key) + '">' + ceEsc(pathLabel(l.path)) + ceEsc(tag + cov + cols) + '</option>';
  };
  const grp = (label, arr) => arr.length
    ? '<optgroup label="' + ceEsc(label + '　' + arr.length + ' 项') + '">' + arr.map(opt).join('') + '</optgroup>'
    : '';

  CE.leafByPath = new Map();
  for (const l of leaves) CE.leafByPath.set(l.key, l);

  // 执行器参数的语义只对同一种执行器成立，必须分组；混在一起会让 RowName 同时指物品、装备、条件
  const plain = leaves.filter((l) => !l.act).sort(byCov);
  const acts = new Map();
  for (const l of leaves) {
    if (!l.act) continue;
    if (!acts.has(l.act)) acts.set(l.act, []);
    acts.get(l.act).push(l);
  }
  // 组顺序按「该执行器在样本里总共出现多少次」，不是按叶子数：
  // GenerateGem 有 3 个参数但全库只出现 98 次，AddCatalogItem 2 个参数出现 1.7 万次。
  const hitsOf = (arr) => arr.reduce((s, l) => s + (l.hits || 0), 0);
  const actList = [...acts.entries()].sort((a, b) => hitsOf(b[1]) - hitsOf(a[1]) || b[1].length - a[1].length);
  // 整条入口排在最前：选中执行器时先看到「参数成组」的视图，而不是单个参数列
  const wholeFirst = (a, b) => (b.whole ? 1 : 0) - (a.whole ? 1 : 0) || byCov(a, b);
  for (const [, arr] of actList) arr.sort(wholeFirst);

  let html = grp('字段本身', plain);
  for (const [act, arr] of actList) html += grp(act + ' · ' + actLabel(act), arr);
  sel.innerHTML = html || '<option value="">（无可用路径）</option>';

  CE.curLeaves = leaves;
  const pick = plain[0] || (actList[0] ? actList[0][1][0] : leaves[0]);
  sel.value = pick.key;
  CE.S.pattern = pick.path;
  CE.S.leaf = pick;
  renderQuickPaths();
  loadColumn();
}

/* 列太多时把「整列都是空」的列藏起来：Rewards[*] 展开 13 列，
   但多数行只有 1-2 个元素，剩下 10 列全是破折号。 */
function applyColFilter() {
  const S = CE.S;
  const all = S.allCols || S.cols || [];
  // 必须按「当前筛出的行」算：全表算的话，只要某一行有 100 个元素，
  // 100 列就全部保留，等于没过滤。
  const fill = new Map();
  // 只采样「一屏能看到的行」：553 行里只要有一行的数组带 100 个元素，
  // 按全表统计就会把 100 列全留下，可实际看到的行大多是破折号。
  // 采样量按未过滤时的渲染上限算（列多 -> 行少），与实际观感一致。
  const budget = Math.max(20, Math.min(CE.MAX_ROWS, Math.floor(CE.CELL_BUDGET / Math.max(1, all.length))));
  for (const r of filteredRows().slice(0, budget)) {
    for (const cc of r.cells) {
      const v = cc.value;
      if (v === null || v === undefined || v === '') continue;
      fill.set(COLK(cc.col), 1);
    }
  }
  S.colFill = fill;
  S.cols = S.hideEmptyCols ? all.filter((c) => fill.has(COLK(c))) : all.slice();
  if (!S.cols.length) S.cols = all.slice();
  if (S.sel && S.sel.c1 >= S.cols.length) { S.sel = null; S.anchor = null; }
}

/* 切路径的唯一入口：#ce-path 下拉和上方快捷 chip 共用 */
function selectPath(key) {
  const S = CE.S;
  const lb = CE.leafByPath || new Map();
  const leaf = lb.get(key) || null;
  S.leaf = leaf;
  S.pattern = leaf ? leaf.path : null;
  S.edits.clear();
  S.sel = null;
  S.anchor = null;
  S.filters = (S.filters || []).filter(isRowFilter);
  loadColumn();
}

/* 常用路径快捷条：整条入口 + 高覆盖率字段。
   下拉里有几十条路径，来回切换执行器要翻半天；这几个是一眼能找到的入口。 */
function renderQuickPaths() {
  const el = ceEl('#ce-quick');
  if (!el) return;
  const leaves = CE.curLeaves || [];
  const cur = CE.S.leaf ? CE.S.leaf.key : '';
  const whole = leaves.filter((l) => l.whole).sort((a, b) => (b.hits || 0) - (a.hits || 0)).slice(0, 4);
  const plain = leaves.filter((l) => !l.act && !l.whole && l.path.indexOf('*') >= 0)
    .sort((a, b) => b.coverage - a.coverage).slice(0, 3);
  const seen = new Set();
  const picks = whole.concat(plain).filter((l) => {
    const k = l.key;
    if (k === cur || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 6);
  if (picks.length < 2) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = '<span class="ce-quick-l">常用</span>' + picks.map((l) => {
    const k = l.key;
    const name = l.act || String(l.path[l.path.length - 1]);
    const short = name.length > 16 ? name.slice(0, 15) + '…' : name;
    return '<button class="ce-chip" data-qp="' + ceEsc(k) + '" title="' + ceEsc(pathLabel(l.path)) + '">' +
      ceEsc(short) + (l.whole ? '<i>整条</i>' : '') + '</button>';
  }).join('');
  el.onclick = (e) => {
    const b = e.target.closest('[data-qp]');
    if (!b) return;
    selectPath(b.dataset.qp);
  };
}

/* ---------- 3. 拉全表该路径的值 ---------- */
async function loadColumn() {
  const S = CE.S;
  const body = ceEl('.ce-body');
  body.innerHTML = '<div class="ce-empty">加载中…</div>';
  // 路径来自某个执行器分组时，加 when 条件：只取该执行器类型下展开的格子
  S.when = null;
  S.actuator = null;
  const leaf = S.leaf;
  if (leaf && leaf.act && leaf.actDepth >= 0) S.when = { [leaf.actDepth]: { Name: leaf.act } };
  // 整条：停在执行器元素上，把 JsonInput 拆成并排的参数列
  const expand = !!(leaf && leaf.whole);
  let data;
  try { data = await DS.column(S.table, S.pattern, S.when, expand); } catch (e) { body.innerHTML = '<div class="ce-empty">加载失败：' + ceEsc(e.message) + '</div>'; return; }
  if (!data.ok) { body.innerHTML = '<div class="ce-empty">' + ceEsc(data.error || '加载失败') + '</div>'; return; }
  S.allCols = data.cols;
  S.rows = data.rows;
  S.rowFields = data.rowFields || [];
  // 主表格带进来的条件若不属于本表（理论上不会），直接丢弃，避免「筛出 0 行」看不出原因
  S.filters = (S.filters || []).filter((f) => isRowFilter(f) &&
    (f.col === FILTER_COLS_ROW || f.col.slice(1) === 'RowName' || S.rowFields.some((x) => x.name === f.col.slice(1))));
  // 必须在 filters 定稿之后过滤列：它按「筛出的行」判断哪一列全空
  applyColFilter();
  S.starPos = data.starPositions || data.starPos;
  S.missing = data.missing;
  S.actuator = data.actuator || null;
  S.expand = !!data.expand;
  S.paramOrder = data.paramOrder || [];
  // 单元格索引：updateCount / saveColumn 不必对每格线性扫描全表（504 格 × 505 行会卡）
  S.cellIndex = new Map();
  for (const r of S.rows) for (const c of r.cells) S.cellIndex.set(KEY(r.row, c.path), { row: r.row, cell: c });
  const sub = ceEl('#ce-sub');
  if (sub) sub.textContent = S.table + '　' + S.cols.length + ' 列 / ' + S.rows.length + ' 行';
  fillFilterCols();
  renderScope();
  renderQuickPaths();
  renderGrid();
}

/* 作用域条：让使用者一眼看到「我现在批量改的是哪一类行为」，
   而不是只看到一个 JsonInput › Count 的路径（不同执行器的 Count 含义差别很大）。 */
function renderScope() {
  const S = CE.S;
  const el = ceEl('#ce-scope');
  if (!el) return;
  // 覆盖统计：让使用者知道这一列到底有多少行真会写进去（空行不算改动）。
  // 必须按「当前筛出的行」算——显示全表 2329 行会让人误以为筛出的 191 行也算在内。
  const scopeRows = filteredRows();
  const total = scopeRows.length;
  let filled = 0;
  for (const r of scopeRows) {
    if (r.cells && r.cells.some((c) => c.value !== null && c.value !== undefined && c.value !== '')) filled++;
  }
  const scopeTag = total < S.rows.length ? '筛出的 ' + total + ' 行里 ' : '';
  const cover = total === 0 ? '筛出的行里这一列没有值'
    : (filled >= total ? scopeTag + '整列 ' + total + ' 行都有值' : scopeTag + '有值 ' + filled + ' / ' + total + ' 行');

  if (!S.actuator) {
    el.hidden = false;
    el.innerHTML = '<span class="scope-tag">字段</span>' +
      '<b>' + ceEsc(pathLabel(S.pattern)) + '</b>' +
      '<span class="scope-note">' + cover + ' · 直接改这个字段的值</span>';
    return;
  }
  const A = S.actuator;
  if (S.expand) {
    // 整条：列 = 一组参数，强调「同一次调用的参数必须一起改」
    const keys = (S.paramOrder || []).filter((k) => k !== 'Name');
    el.hidden = false;
    el.innerHTML =
      '<span class="scope-tag">执行器</span>' +
      '<b>' + ceEsc(A.name) + '</b>' +
      '<span class="scope-cn">' + ceEsc(actLabel(A.name)) + '</span>' +
      '<span class="scope-sep">·</span>' +
      '<span class="scope-tag">每组列 = 一次调用</span>' +
      keys.map((k) => {
        const pdef = A.params ? A.params[k] : null;
        const tgt = pdef && pdef.target ? ' → ' + pdef.target.replace(/^Config_/, '') : '';
        return '<span class="scope-param">' + ceEsc(k) + '<i>' + ceEsc(paramShort(k)) + ceEsc(tgt) + '</i></span>';
      }).join('') +
      '<span class="scope-note">' + cover + ' · 同一组的参数一起改才有意义，只改其中一格会写出半条配置</span>';
    return;
  }
  const last = S.pattern[S.pattern.length - 1];
  const p = A.params ? A.params[last] : null;
  const desc = p && p.desc ? p.desc : '';
  const target = p && p.target ? p.target.replace(/^Config_/, '') : '';
  el.hidden = false;
  el.innerHTML =
    '<span class="scope-tag">执行器</span>' +
    '<b>' + ceEsc(A.name) + '</b>' +
    '<span class="scope-cn">' + ceEsc(actLabel(A.name)) + '</span>' +
    '<span class="scope-sep">·</span>' +
    '<span class="scope-tag">参数</span>' +
    '<b>' + ceEsc(last) + '</b>' +
    (desc ? '<span class="scope-cn">' + ceEsc(desc) + '</span>' : '') +
    (target ? '<span class="scope-ref">引用 → ' + ceEsc(target) + '</span>' : '') +
    '<span class="scope-note">' + cover + ' · 只改「Name = ' + ceEsc(A.name) + '」的元素，同行其它执行器不动</span>';
}

/* 整条模式下每个参数列的中文短标签（"数量。 如果是消耗…" → "数量"） */
function paramShort(k) {
  const A = CE.S && CE.S.actuator;
  const def = A && A.params ? A.params[k] : null;
  const raw = def && def.desc ? def.desc : k;
  return String(raw).split(/[。，,;；(（]/)[0].trim().slice(0, 12) || k;
}

/* 两级表头：上行 = 第几次调用（#1 #2），下行 = 参数名。
   这样 #1 的「物品」和「数量」在同一列组内，对应关系一眼可见。 */
function expandHead() {
  const S = CE.S;
  const groups = [];
  for (const c of S.cols) {
    const gk = COLK(c.slice(0, -1));
    let g = groups[groups.length - 1];
    if (!g || g.k !== gk) { g = { k: gk, col: c.slice(0, -1), items: [] }; groups.push(g); }
    g.items.push(c);
  }
  const A = S.actuator;
  const r1 = '<tr class="ce-gh"><th class="ce-rn" rowspan="2">RowName</th>' +
    groups.map((g) => {
      const seq = g.col[g.col.length - 1] + 1;
      let lab = ceEsc(colLabel(g.col));
      if (A) {
        const nm = A.name.length > 18 ? A.name.slice(0, 17) + '…' : A.name;
        lab = ceEsc(nm) + '<i>' + seq + '</i>';
      }
      return '<th class="ce-g" colspan="' + g.items.length + '" title="第 ' +
        g.col.map((x) => x + 1).join('.') + ' 次调用">' + lab + '</th>';
    }).join('') + '</tr>';
  const r2 = '<tr class="ce-ph">' + S.cols.map((c, ci) => {
    const k = COLK(c);
    const pk = c[c.length - 1];
    const label = paramShort(pk);
    return '<th class="ce-ch" data-col="' + ceEsc(k) + '" data-c="' + ci +
      '" title="' + ceEsc(pk + '（' + (c.slice(0, -1).map((x) => x + 1).join('.')) + '）') + '">' + ceEsc(label) + '</th>';
  }).join('') + '</tr>';
  return r1 + r2;
}

/* ---------- 3.5 按属性筛选 ---------- */
const FILTER_COLS_ROW = '__row';

function filterColLabel(c) {
  const S = CE.S;
  if (S && S.expand && Array.isArray(c) && c.length > 1) {
    return colLabel(c.slice(0, -1)) + ' ' + paramShort(c[c.length - 1]);
  }
  return colLabel(c);
}

function isRowFilter(f) { return !!f && (f.col === FILTER_COLS_ROW || (typeof f.col === 'string' && f.col[0] === '@')); }

function fillFilterCols() {
  const S = CE.S;
  const sel = ceEl('#ce-f-col');
  if (!sel) return;
  const keep = sel.value;
  // 行属性 = 整行的字段（DefineName / StandardCoinBase / Notes…），列 = 当前路径展开出来的格子列
  const rowOpts = '<option value="' + FILTER_COLS_ROW + '">RowName（行名）</option>' +
    (S.rowFields || []).map((f) => {
      const d = String(f.desc || '').trim();
      const kindTag = f.kind === 'primarray' ? '（数组）' : '';
      const txt = f.name + kindTag + (d ? '　' + (d.length > 10 ? d.slice(0, 10) + '…' : d) : '');
      const tip = d + (f.kind === 'primarray' ? '（数组：按单个元素匹配）' : '');
      return '<option value="' + ceEsc('@' + f.name) + '" title="' + ceEsc(tip) + '">' + ceEsc(txt) + '</option>';
    }).join('');
  const colOpts = S.cols.map((c) => '<option value="' + ceEsc(COLK(c)) + '">' + ceEsc(filterColLabel(c)) + '</option>').join('');
  sel.innerHTML =
    '<optgroup label="行属性（整行的字段）">' + rowOpts + '</optgroup>' +
    (colOpts ? '<optgroup label="列（本表展开的列）">' + colOpts + '</optgroup>' : '');
  if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

/* 筛选只按「原值」判断，故意不跟未保存的编辑走：
   否则「数量 > 2000 的行整列设为 0」一执行，行会立刻从表里消失，使用者没法核对改了什么。
   改动过的格子靠 td.chg 高亮，行不会消失。 */
function curValOf(r, key) {
  if (key === FILTER_COLS_ROW) return r.row;
  if (typeof key === 'string' && key[0] === '@') {
    const k = key.slice(1);
    if (k === 'RowName') return r.row;
    return r.scalars ? r.scalars[k] : undefined;
  }
  const cell = r.cells.find((c) => COLK(c.col) === key);
  return cell ? cell.value : undefined;
}

function numOf(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return isFinite(n) ? n : null; }
  return null;
}

function matchFilter(r, f) {
  const raw = curValOf(r, f.col);
  const isArr = Array.isArray(raw);
  const empty = raw === undefined || raw === null || raw === '' || (isArr && raw.length === 0);
  if (f.op === 'empty') return empty;
  if (f.op === 'notempty') return !empty;
  if (empty) return false;
  // 标准数组（如 Task.Tags）按元素匹配，不是把整个数组当 JSON 文本比
  if (isArr) {
    const w = f.val.toLowerCase();
    const elems = raw.map((e) => (e !== null && typeof e === 'object' ? JSON.stringify(e) : String(e)).toLowerCase());
    if (f.op === 'contains') return elems.some((e) => e.includes(w));
    if (f.op === '=') return elems.some((e) => e === w);
    if (f.op === '!=') return !elems.some((e) => e === w);
    return false;
  }
  if (f.op === 'contains') return String(raw).toLowerCase().includes(f.val.toLowerCase());
  const a = numOf(raw), b = numOf(f.val);
  if (a !== null && b !== null) {
    if (f.op === '=') return a === b;
    if (f.op === '!=') return a !== b;
    if (f.op === '>') return a > b;
    if (f.op === '>=') return a >= b;
    if (f.op === '<') return a < b;
    if (f.op === '<=') return a <= b;
  }
  const s = String(raw).toLowerCase(), w = f.val.toLowerCase();
  if (f.op === '=') return s === w;
  if (f.op === '!=') return s !== w;
  return false;
}

function filteredRows() {
  const S = CE.S;
  const fs = S.filters || [];
  return S.rows.filter((r) => {
    if (S.q && !String(r.row).toLowerCase().includes(S.q)) return false;
    if (S.onlyFilled && !r.cells.length) return false;
    return fs.every((f) => matchFilter(r, f));
  });
}

const OP_CN = { '=': '=', '!=': '≠', '>': '>', '>=': '≥', '<': '<', '<=': '≤', contains: '包含', empty: '为空', notempty: '非空' };

function filterText(f) {
  const name = f.col === FILTER_COLS_ROW ? 'RowName'
    : (typeof f.col === 'string' && f.col[0] === '@' ? f.col.slice(1) : filterColLabel(JSON.parse(f.col)));
  const tail = f.op === 'empty' || f.op === 'notempty' ? '' : ' ' + f.val;
  return name + ' ' + (OP_CN[f.op] || f.op) + tail;
}

function renderFilters() {
  const S = CE.S;
  const box = ceEl('#ce-f-chips');
  const note = ceEl('#ce-f-note');
  if (!box) return;
  const fs = S.filters || [];
  box.innerHTML = fs.map((f, i) =>
    '<span class="cf-chip">' + ceEsc(filterText(f)) + '<button class="cf-x" data-fi="' + i + '" title="移除">×</button></span>'
  ).join('');
  if (note) {
    const n = filteredRows().length;
    note.textContent = (fs.length || S.q || S.onlyFilled)
      ? '筛出 ' + n + ' / ' + S.rows.length + ' 行' + (fs.length ? ' · 批量只作用于筛出的行' : '')
      : '共 ' + S.rows.length + ' 行';
  }
}

/* ---------- 4. 渲染网格 ---------- */
function renderGrid() {
  const S = CE.S;
  const body = ceEl('.ce-body');
  if (!body) return;
  const rows = filteredRows();
  // 总控件数上限：505 行 × 100 列 = 50500 个 input 会把浏览器拖死
  const budget = Math.max(20, Math.min(CE.MAX_ROWS, Math.floor(CE.CELL_BUDGET / Math.max(1, S.cols.length))));
  const shown = rows.slice(0, budget);
  const head = S.expand ? expandHead() : '<tr><th class="ce-rn">RowName</th>' + S.cols.map((c, ci) => {
    const k = COLK(c);
    return '<th class="ce-ch" data-col="' + ceEsc(k) + '" data-c="' + ci + '" title="' + ceEsc(colTitle(c)) + '">' + ceEsc(colLabel(c)) + '</th>';
  }).join('') + '</tr>';

  shown.forEach((r) => { r._byCol = new Map(r.cells.map((c) => [COLK(c.col), c])); });
  S.shown = shown;
  const rowsHtml = shown.map((r, ri) => {
    const byCol = r._byCol;
    const tds = S.cols.map((col, ci) => {
      const cell = byCol.get(COLK(col));
      if (!cell) return '<td class="ce-na" data-r="' + ri + '" data-c="' + ci + '">—</td>';
      const k = KEY(r.row, cell.path);
      const v = S.edits.has(k) ? S.edits.get(k) : cell.value;
      const meta = cellMeta(cell);
      const ty = valType(v, meta);
      const changed = S.edits.has(k) && JSON.stringify(S.edits.get(k)) !== JSON.stringify(cell.value);
      const attrs = ' data-row="' + ceEsc(r.row) + '" data-r="' + ri + '" data-c="' + ci + '" data-p="' + ceEsc(JSON.stringify(cell.path)) + '" data-t="' + (ty === 'ref' ? 'str' : ty) + '"';
      if (ty === 'bool') {
        return '<td class="ce-c' + (changed ? ' chg' : '') + '" data-r="' + ri + '" data-c="' + ci + '"><select' + attrs + '><option value="true"' + (v ? ' selected' : '') + '>是</option><option value="false"' + (!v ? ' selected' : '') + '>否</option></select></td>';
      }
      /* 引用列：单元格按 ↓ 打开引用选择器（ref-picker.js 全局事件委托，不给每格加按钮） */
    const listAttr = ty === 'ref' && meta && meta.target ? ' data-rp="' + ceEsc(meta.target) + '"' : '';
      const tip = meta && meta.desc ? ' title="' + ceEsc(meta.desc) + '"' : '';
      return '<td class="ce-c' + (changed ? ' chg' : '') + '" data-r="' + ri + '" data-c="' + ci + '"><input type="' + (ty === 'num' ? 'number' : 'text') + '" step="any" value="' + ceEsc(fmtVal(v)) + '"' + listAttr + tip + attrs + ' /></td>';
    }).join('');
    return '<tr data-row="' + ceEsc(r.row) + '" data-r="' + ri + '"><th class="ce-rn" title="' + ceEsc(r.notes || '') + '">' + ceEsc(r.row) + '</th>' + tds + '</tr>';
  }).join('');

  const more = rows.length > shown.length
    ? '<div class="ce-note">表格只渲染前 ' + shown.length + ' 行（共 ' + rows.length + ' 行）。用「按属性筛选」「筛行名」「只看有值」缩小范围；「整列设为 / 递增」也只作用于筛出的行。</div>'
    : (rows.length < S.rows.length
      ? '<div class="ce-note">已筛选：' + rows.length + ' / ' + S.rows.length + ' 行，批量只作用于这些行。</div>'
      : '');

  body.innerHTML = more + '<table class="ce-grid"><thead>' + head + '</thead><tbody>' + rowsHtml + '</tbody></table>';

  body.querySelectorAll('th.ce-ch').forEach((th) => {
    th.onclick = (e) => {
      const c = Number(th.dataset.c);
      const n = (S.shown || filteredRows()).length;
      if (!n) return;
      if (e.shiftKey && S.anchor) S.sel = normSel(S.anchor, { r: n - 1, c });
      else { S.sel = { r0: 0, c0: c, r1: n - 1, c1: c }; S.anchor = { r: 0, c }; }
      paintSel();
    };
  });
  bindSelect(body);
  body.oncopy = onCopy;
  body.onpaste = onPaste;
  body.querySelectorAll('input[data-row],select[data-row]').forEach((inp) => {
    inp.oninput = inp.onchange = () => {
      const raw = inp.value;
      const ty = inp.dataset.t;
      const k = KEY(inp.dataset.row, JSON.parse(inp.dataset.p));
      const td = inp.closest('td');
      let v = raw;
      if (ty === 'num') {
        // 清空数字框 = 撤销这一格的改动，绝不把 null 写进配置
        if (raw.trim() === '') {
          S.edits.delete(k);
          const hit = S.cellIndex && S.cellIndex.get(k);
          if (hit) S.edits.delete(k);
          td.classList.remove('chg');
          updateCount();
          return;
        }
        v = Number(raw);
      } else if (ty === 'bool') v = raw === 'true';
      S.edits.set(k, v);
      const hit = S.cellIndex && S.cellIndex.get(k);
      td.classList.toggle('chg', !hit || JSON.stringify(hit.cell.value) !== JSON.stringify(v));
      td.classList.toggle('ce-sel-chg', td.classList.contains('ce-sel') && td.classList.contains('chg'));
      updateCount();
    };
  });
  renderFilters();
  updateCount();
  paintSel();
}

/* 真正有变化的格子（值与原值不同） */
function dirtyOps() {
  const S = CE.S;
  const out = [];
  if (!S.cellIndex) return out;
  for (const [k, v] of S.edits) {
    const hit = S.cellIndex.get(k);
    if (!hit) continue;
    if (JSON.stringify(hit.cell.value) === JSON.stringify(v)) continue;
    out.push({ row: hit.row, path: hit.cell.path, value: v });
  }
  return out;
}

function updateCount() {
  const S = CE.S;
  const n = dirtyOps().length;
  const el = ceEl('#ce-count');
  if (el) {
    const shown = filteredRows().length;
    const scopeTxt = shown < S.rows.length ? '筛出 ' + shown + ' / 全表 ' + S.rows.length + ' 行' : '全表 ' + S.rows.length + ' 行';
    el.textContent = n ? '已改 ' + n + ' 格（' + scopeTxt + '）' : '未改动';
  }
  updateBulk();
}

/* ---------- 4.5 选区 ---------- */
function normSel(a, b) {
  return {
    r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r),
    c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c),
  };
}

function selCells() {
  const S = CE.S;
  const sel = S.sel;
  if (!sel || !S.shown || !S.cols) return [];
  const out = [];
  for (let r = sel.r0; r <= sel.r1; r++) {
    const row = S.shown[r];
    if (!row || !row._byCol) continue;
    for (let c = sel.c0; c <= sel.c1; c++) {
      const col = S.cols[c];
      if (!col) continue;
      const cell = row._byCol.get(COLK(col));
      if (cell) out.push({ r, c, row, cell });
    }
  }
  return out;
}

/* 当前格显示的值（改动优先，否则磁盘值；布尔统一成 true/false 便于还原） */
function cellNow(row, cell) {
  const S = CE.S;
  const k = KEY(row.row, cell.path);
  const v = S.edits.has(k) ? S.edits.get(k) : cell.value;
  const ty = valType(v, cellMeta(cell));
  if (ty === 'bool') return v ? 'true' : 'false';
  return v === null || v === undefined ? '' : String(v);
}

function selTsv() {
  const S = CE.S;
  const sel = S.sel;
  if (!sel || !S.shown) return null;
  const lines = [];
  for (let r = sel.r0; r <= sel.r1; r++) {
    const row = S.shown[r];
    if (!row) { lines.push(''); continue; }
    const cols = [];
    for (let c = sel.c0; c <= sel.c1; c++) {
      const col = S.cols[c];
      const cell = col && row._byCol ? row._byCol.get(COLK(col)) : null;
      cols.push(cell ? cellNow(row, cell) : '');
    }
    lines.push(cols.join('\t'));
  }
  return lines.join('\n');
}

/* 高亮：只切 class，不重建表格（6000 个 input 重建一次要几百毫秒） */
function paintSel() {
  const S = CE.S;
  const body = ceEl('.ce-body');
  if (!body) return;
  const sel = S.sel;
  body.querySelectorAll('td[data-r]').forEach((td) => {
    const r = Number(td.dataset.r), c = Number(td.dataset.c);
    const on = !!sel && r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1;
    td.classList.toggle('ce-sel', on);
    td.classList.toggle('ce-sel-chg', on && td.classList.contains('chg'));
  });
  const one = !!sel && sel.c0 === sel.c1;
  body.querySelectorAll('th.ce-ch').forEach((th) => {
    const c = Number(th.dataset.c);
    th.classList.toggle('ce-hsel', !!sel && one && c === sel.c0);
  });
  updateBulk();
}

function updateBulk() {
  const S = CE.S;
  const bulk = ceEl('#ce-bulk');
  if (!bulk) return;
  const sel = S.sel;
  bulk.hidden = !sel;
  if (!sel) return;
  const sum = ceEl('#ce-selsum');
  if (sum) {
    sum.textContent = '已选 ' + (sel.r1 - sel.r0 + 1) + ' 行 × ' + (sel.c1 - sel.c0 + 1) + ' 列';
  }
  const stepWrap = ceEl('#ce-step-wrap');
  if (stepWrap) stepWrap.hidden = sel.c0 !== sel.c1;
}

/* Shift+点击会顺带让浏览器扩展一段文本选择，整块区域蒙上深蓝，看不出选区边界 */
function clearNativeSel() {
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
  const sel = window.getSelection ? window.getSelection() : null;
  if (sel && sel.rangeCount) sel.removeAllRanges();
}

/* 拖选：5px 阈值，点击不打断输入框聚焦 */
function bindSelect(body) {
  body.onmousedown = (e) => {
    if (e.button !== 0) return;
    const td = e.target.closest ? e.target.closest('td[data-r]') : null;
    if (!td) return;
    // Shift+点击只用来扩选区，禁止浏览器跟着做文本选择
    if (e.shiftKey) e.preventDefault();
    const r = Number(td.dataset.r), c = Number(td.dataset.c);
    const sx = e.clientX, sy = e.clientY;
    let dragging = false;
    const move = (ev) => {
      if (!dragging && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 5) return;
      if (!dragging) { dragging = true; body.classList.add('ce-dragging'); clearNativeSel(); }
      const t2 = document.elementFromPoint(ev.clientX, ev.clientY);
      const hit = t2 && t2.closest ? t2.closest('td[data-r]') : null;
      if (!hit) return;
      CE.S.sel = normSel({ r, c }, { r: Number(hit.dataset.r), c: Number(hit.dataset.c) });
      paintSel();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      body.classList.remove('ce-dragging');
      clearNativeSel();
      if (dragging) { CE.S.anchor = { r, c }; return; }
      if (e.shiftKey && CE.S.anchor) CE.S.sel = normSel(CE.S.anchor, { r, c });
      else { CE.S.sel = { r0: r, c0: c, r1: r, c1: c }; CE.S.anchor = { r, c }; }
      paintSel();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
}

function onCopy(e) {
  const S = CE.S;
  if (!S.sel) { setStatus('先选中要复制的单元格（或拖出一块区域）'); return; }
  const ae = document.activeElement;
  // 正在输入框里选字：让浏览器自己复制
  if (ae && ae.tagName === 'INPUT' && typeof ae.selectionStart === 'number' && ae.selectionStart !== ae.selectionEnd) return;
  const tsv = selTsv();
  if (tsv === null) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', tsv);
  setStatus('已复制 ' + (S.sel.r1 - S.sel.r0 + 1) + ' 行 × ' + (S.sel.c1 - S.sel.c0 + 1) + ' 列');
}

/* 写一格；返回 false 表示这个值不能转成该列的类型，跳过 */
function writeCell(row, cell, raw) {
  const S = CE.S;
  const k = KEY(row.row, cell.path);
  const cur = S.edits.has(k) ? S.edits.get(k) : cell.value;
  const ty = valType(cur, cellMeta(cell));
  const v = String(raw).trim();
  if (ty === 'bool') {
    const t = v.toLowerCase();
    if (['true', '是', '1', 'yes', 'y'].indexOf(t) >= 0) { S.edits.set(k, true); return true; }
    if (['false', '否', '0', 'no', 'n'].indexOf(t) >= 0) { S.edits.set(k, false); return true; }
    return false;
  }
  if (v === '') { S.edits.delete(k); return true; }
  if (ty === 'num') {
    const n = Number(v.replace(/,/g, ''));
    if (!isNaN(n)) { S.edits.set(k, n); return true; }
    return false;
  }
  S.edits.set(k, String(raw));
  return true;
}

function onPaste(e) {
  const S = CE.S;
  const sel = S.sel;
  if (!sel || !S.shown) { setStatus('先选中要粘贴的起始单元格（或拖出一块区域）'); return; }
  const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
  if (!text) return;
  e.preventDefault();
  const grid = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '').split('\n')
    .map((l) => l.split('\t'));
  let done = 0, skip = 0;
  for (let i = 0; i < grid.length; i++) {
    const row = S.shown[sel.r0 + i];
    if (!row) { skip += grid[i].length; continue; }
    for (let j = 0; j < grid[i].length; j++) {
      const col = S.cols[sel.c0 + j];
      const cell = col && row._byCol ? row._byCol.get(COLK(col)) : null;
      if (!cell) { skip++; continue; }
      if (writeCell(row, cell, grid[i][j])) done++; else skip++;
    }
  }
  renderGrid();
  setStatus('粘贴 ' + done + ' 格' + (skip ? '，' + skip + ' 格超出范围或类型不符已忽略' : ''));
}

/* ---------- 5. 选区批量 ---------- */
function applySetSel(m) {
  const S = CE.S;
  const sel = S.sel;
  if (!sel) return;
  const raw = m.querySelector('#ce-set').value;
  if (raw === '') return;
  const cells = selCells();
  if (!cells.length) { alert('选区里没有可写的格子'); return; }
  // 引用字段写 "10015" 这种纯数字也必须保持字符串，否则 JSON 里会变成 10015 让反序列化失败
  const meta = cellMeta(cells[0].cell);
  const typed = meta ? (Array.isArray(meta.type) ? meta.type : [meta.type]) : null;
  const wantStr = !!(meta && (meta.target || (typed && typed.indexOf('string') >= 0)));
  let v = raw;
  if (!wantStr && !isNaN(Number(raw)) && raw.trim() !== '') v = Number(raw);
  for (const it of cells) S.edits.set(KEY(it.row.row, it.cell.path), v);
  renderGrid();
}

function applyMulSel(m) {
  const S = CE.S;
  if (!S.sel) return;
  const raw = m.querySelector('#ce-mul').value;
  const mul = Number(raw);
  if (!raw || isNaN(mul)) return;
  let n = 0;
  for (const it of selCells()) {
    const k = KEY(it.row.row, it.cell.path);
    const base = S.edits.has(k) ? S.edits.get(k) : it.cell.value;
    const num = typeof base === 'number' ? base : parseFloat(base);
    if (isNaN(num)) continue;
    S.edits.set(k, num * mul);
    n++;
  }
  renderGrid();
  setStatus('已对 ' + n + ' 格 × ' + mul);
}

function clearSelEdits() {
  const S = CE.S;
  const cells = selCells();
  for (const it of cells) S.edits.delete(KEY(it.row.row, it.cell.path));
  renderGrid();
  setStatus('已清空选区内的改动（' + cells.length + ' 格）');
}

function applyFillCol(m) {
  const S = CE.S;
  const sel = S.sel;
  if (!sel || sel.c0 !== sel.c1) return;
  const raw = m.querySelector('#ce-step').value;
  const step = Number(raw);
  if (!raw || isNaN(step)) return;
  const col = S.cols[sel.c0];
  if (!col) return;
  let i = 0;
  for (let r = sel.r0; r <= sel.r1; r++) {
    const row = S.shown[r];
    const cell = row && row._byCol ? row._byCol.get(COLK(col)) : null;
    if (!cell) continue;
    const k = KEY(row.row, cell.path);
    const base = S.edits.has(k) ? S.edits.get(k) : cell.value;
    const num = typeof base === 'number' ? base : parseFloat(base);
    if (isNaN(num)) continue;
    S.edits.set(k, num + step * i);
    i++;
  }
  renderGrid();
}

/* ---------- 6. 预览 + 保存 ---------- */
async function saveColumn(m) {
  const S = CE.S;
  const ops = dirtyOps().map((o) => ({ type: 'setpath', row: o.row, path: o.path, value: o.value }));
  if (!ops.length) { setStatus('没有改动'); return; }

  setStatus('校验中…');
  const { data } = await postJson('/api/preview', { table: S.table, ops });
  if (!data || !data.diff) { setStatus('预览失败'); alert((data && (data.error || (data.errors || []).join('\n'))) || '预览失败'); return; }
  setStatus('就绪');
  showDiffDialog(data, async () => {
    const res = await postJson('/api/apply', { table: S.table, ops });
    if (!res.data.ok) { alert('保存失败：' + (res.data.error || (res.data.errors || []).join('\n'))); return false; }
    setStatus('列编辑已保存 ' + res.data.opCount + ' 处 · 备份 ' + res.data.backup);
    m.remove();
    await loadRows();
    return true;
  }, '写入 ' + ops.length + ' 格');
}

})();
