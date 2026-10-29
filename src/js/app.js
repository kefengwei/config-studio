/* 配置工作台 · 只读浏览原型 */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString('zh-CN') : n);

const state = {
  sem: null,
  tables: [],
  filter: '',
  cur: null,
  rows: [],
  total: 0,
  offset: 0,
  limit: 100,
  q: '',
  filters: [],
  colSample: { table: null, rows: [] },
  fills: null,
  selRow: null,
  notes: {},
  searchTimer: null,
  // 定位模式：搜索/筛选后自动把选中行落到结果上（默认开，偏好存 localStorage）
  locate: (localStorage.getItem('wb.locate') || '1') !== '0',
};

/* ---------------- boot ---------------- */
async function init() {
  // 字段说明默认收两行，点一下展开全文（详情面板与编辑表单共用）
  document.addEventListener('click', (e) => {
    const d = e.target.closest ? e.target.closest('.f-desc') : null;
    if (d) d.classList.toggle('expanded');
  });
  setStatus('加载语义层…');
  state.sem = await DS.init((d, n) => setStatus('加载配置数据 ' + d + ' / ' + n + ' 张表…'));
  $('#stat-tables').textContent = state.sem.stats.tables;
  $('#stat-rows').textContent = fmtNum(state.sem.stats.rows);
  DS.ping().then((p) => {
    if (!p || !p.configDir) return;
    const seg = String(p.configDir).replace(/\\/g, '/').split('/').filter(Boolean);
    const repo = seg.length >= 2 ? seg[seg.length - 2] : seg[0];
    if (repo) $('#stat-repo').textContent = repo;
  });

  state.tables = Object.values(state.sem.tables).sort((a, b) => b.rowCount - a.rowCount);
  $('#table-count').textContent = state.tables.length + ' 张';
  renderTableList();

  const missing = await preloadNotes();
  const st = DS.stale || { added: [], removed: [] };
  const schemaMode = DS.semMode === 'schema';
  const staleMsg = [];
  /* schema 模式下没有「语义层过期」这回事：语义层是现算的，added 表示这批表
     后端没有导出 schema（字段说明会缺，但表照样能打开编辑）。 */
  if (st.added.length) staleMsg.push(schemaMode
    ? st.added.length + ' 张表没有 schema 定义（后端没导出，侧栏不列出）：' + st.added.slice(0, 3).join(', ') + (st.added.length > 3 ? ' …' : '')
    : '新增 ' + st.added.length + ' 张表未纳入语义层');
  /* removed 与 missing 常常是同一批表（切到配置更少的分支）。那种情况
     「请重新构建」是错的建议 —— 少的是文件，不是语义层。 */
  const removedOnly = st.removed.filter((n) => !missing.includes(n));
  if (removedOnly.length) staleMsg.push(removedOnly.length + ' 张表已无文件');
  const missMsg = missing.length
    ? '　△ ' + missing.length + ' 张表的文件在当前分支上不存在（引用它们的格子会显示「目标不存在」）'
    : '';
  setStatus(
    (missing.length ? '部分表缺失 · ' : '就绪 · ') + state.sem.stats.actuators + ' 个执行器 · ' + state.sem.stats.refFields + ' 个引用字段 · ' +
    state.sem.stats.enumsWithChinese + '/' + state.sem.stats.enums + ' 枚举有中文' +
    (staleMsg.length ? '　△ ' + staleMsg.join('，') + (schemaMode ? '' : '，请重新构建') : '') + missMsg
  );
  if (staleMsg.length) console.warn(schemaMode ? '[无 schema 的表]' : '[语义层过期]', st);
  /* 默认/深链接指定的表可能在当前目录里没有文件（切到配置更少的分支时很常见）。
     这种情况不要整条 init 抛错 —— 换一张确实存在的表，状态栏已经写明缺了多少张。 */
  const missSet = new Set(missing);
  const usable = state.tables.filter((t) => !missSet.has(t.name));
  const hash = decodeURIComponent(location.hash.slice(1)).replace(/^\//, '');
  if (hash) {
    const [raw, r] = hash.split('/');
    const t = resolveTableName(raw);
    if (t && !missSet.has(t)) { await selectTable(t); if (r) await goTo(t, r); return; }
    if (t) setStatus('这张表在当前配置目录里没有文件：' + t);
  }
  if (!usable.length) {
    setStatus('配置目录里没有可用的配置文件，请检查目录是否选对');
    return;
  }
  await selectTable(usable[0].name);
}

/* 预加载「被引用表」的 RowName→Notes 索引，供引用 chip 显示中文名。
   逐表 try/catch：切到配置更少的分支时，某些表在磁盘上根本不存在，
   以前这里会让 Promise.all 整体 reject，导致 init 失败、状态栏永久红字、连表都不自动选。 */
async function preloadNotes() {
  const need = new Set();
  for (const rt of Object.values(state.sem.refTargets)) need.add(rt.target);
  for (const a of Object.values(state.sem.actuators)) for (const p of Object.values(a.params || {})) if (p.target) need.add(p.target);
  /* DS.init 已经知道哪些表读不到文件，这里直接合并，不用再猜一遍 */
  const missing = new Set(DS.missing || []);
  await Promise.all([...need].filter((t) => state.sem.tables[t]).map(async (t) => {
    try { state.notes[t] = await DS.notes(t); } catch (e) { missing.add(t); }
  }));
  const arr = [...missing].sort();
  state.missingTables = arr;
  return arr;
}

const hasRow = (target, raw) => !!state.notes[target] &&
  Object.prototype.hasOwnProperty.call(state.notes[target], raw);

const refLabel = (target, raw) => {
  if (!hasRow(target, raw)) return null;
  const n = state.notes[target][raw];
  return n && n.trim() ? n : raw;
};

/* ---------------- sidebar ---------------- */
function renderTableList() {
  const f = state.filter.toLowerCase();
  const list = state.tables.filter((t) => t.name.toLowerCase().includes(f));
  $('#table-list').innerHTML = list.map((t) => {
    const low = t.notesRate < 30;
    return '<div class="t-item' + (t.name === state.cur ? ' active' : '') + '" data-t="' + esc(t.name) + '">' +
      '<span class="t-name" title="' + esc(t.name) + '">' + esc(t.name.replace(/^Config_/, '')) + '</span>' +
      '<span class="t-rows">' + t.rowCount + '</span>' +
      '<div class="t-bar' + (low ? ' low' : '') + '"><i style="width:' + t.notesRate + '%"></i></div>' +
      '</div>';
  }).join('') || '<div class="empty">无匹配表</div>';
  sfSync();
}

$('#table-list').addEventListener('click', (e) => {
  const el = e.target.closest('.t-item');
  if (el) selectTable(el.dataset.t);
});
$('#table-filter').addEventListener('input', (e) => { state.filter = e.target.value; renderTableList(); });

/* ---------------- table ---------------- */
async function selectTable(name) {
  state.cur = name;
  state.offset = 0;
  state.q = '';
  state.selRow = null;
  $('#row-search').value = '';
  state.filters = [];
  renderTableList();
  renderDetail(null);
  renderPfFields();
  renderPfChips();
  const t = state.sem.tables[name];
  $('#cur-title').textContent = name.replace(/^Config_/, '');
  $('#cur-badges').innerHTML =
    (t.hasSchema ? '' : '<span class="badge">无 schema</span>') +
    (t.increments ? Object.keys(t.increments).map((c) => '<span class="badge ch">' + esc(c) + '</span>').join('') : '') +
    (t.extraKeys.length ? '<span class="badge">' + t.extraKeys.length + ' 个未知字段</span>' : '');
  const fields = t.fields.filter((f) => !['RowName', 'Notes'].includes(f.name));
  $('#cur-meta').innerHTML =
    '<span><b>' + t.rowCount + '</b> 行</span>' +
    '<span>注释覆盖 <b>' + t.notesRate + '%</b></span>' +
    '<span><b>' + fields.length + '</b> 个字段</span>' +
    (t.increments ? '<span>渠道增量 <b>' + Object.entries(t.increments).map(([k, v]) => k + ':' + v).join(' / ') + '</b></span>' : '');
  await loadFills(name);
  await loadRows();
  syncHash(name, null);
}

// 全表字段统计（填充率 / 是否恒等于 RowName）——挑列不能只靠前几行抽样：
// Level 的 DefineName 前 100 行全是 Main，后面还有 MainLevelUnlock；TimeControlRowName 前 100 行全空，全表却有值。
async function loadFills(name) {
  try {
    const r = await DS.fill(name);
    state.fills = r && r.ok ? r : null;
  } catch {
    state.fills = null;
  }
}

async function loadRows() {
  const r = await DS.page(state.cur, { offset: state.offset, limit: state.limit, q: state.q, filters: state.filters });
  state.rows = r.rows;
  state.total = r.total;
  renderGrid();
  renderPfChips();
  locateAfterLoad();
}

/* 定位模式：搜索/筛选结束后选中行落在哪一行。
   规则 —— 当前选中行还在结果里就只恢复高亮（不打断你正在看的那行）；
   不在结果里且搜索词非空、又没在编辑表单里，就直接选中第一条并滚过去。 */
function locateAfterLoad() {
  if (!state.rows.length) {
    state.selRow = null;
    renderDetail(null);
    setStatus(state.q ? '搜索「' + state.q + '」没有匹配的行' : '这张表没有匹配的行');
    return;
  }
  const editing = typeof EP !== 'undefined' && EP && (EP.detailMode === 'edit' || EP.detailMode === 'new');
  const keep = !!state.selRow && state.rows.some((r) => r.RowName === state.selRow);
  if (!keep && !editing) {
    if (state.q && state.locate) applySelection(state.rows[0]);
    else if (state.selRow) { state.selRow = null; markSelection(); renderDetail(null); }
  }
  reportLocate();
}

/* 状态栏告诉用户「现在停在命中的第几个」 */
function reportLocate() {
  if (!state.q) return;
  const i = state.selRow ? state.rows.findIndex((r) => r.RowName === state.selRow) : -1;
  const abs = i >= 0 ? state.offset + i + 1 : 0;
  setStatus('搜索「' + state.q + '」· 命中 ' + state.total + ' 行'
    + (abs ? ' · 当前第 ' + abs + ' 个' : '')
    + (state.locate ? '（↑↓ 逐个切换）' : '（定位已关，↑↓ 仍可用）'));
}

/* ---------------- 按属性筛选（行本身的字段，不是列编辑里那种展开列） ---------------- */
const PF_OPS = { '=': '=', '!=': '≠', '>': '>', '>=': '≥', '<': '<', '<=': '≤', contains: '包含', empty: '为空', notempty: '非空' };
// 标准数组（primarray，如 Task.Tags）可筛；对象数组 / 对象 / 执行器不进下拉（用列编辑下钻）
const PF_HIDE_KINDS = ['objectarray', 'array', 'poly', 'object', 'actuators'];

function pfFields() {
  const t = state.sem.tables[state.cur];
  if (!t) return [];
  return t.fields.filter((f) => !PF_HIDE_KINDS.includes(f.kind));
}

function renderPfFields() {
  const sel = $('#pf-field');
  if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = pfFields().map((f) => {
    const d = String(f.desc || '').replace(/\s+/g, ' ').trim();
    const tail = d ? '　' + (d.length > 10 ? d.slice(0, 10) + '…' : d) : '';
    const kindTag = f.kind === 'primarray' ? '（数组）' : '';
    const tip = d + (f.kind === 'primarray' ? '（数组：按单个元素匹配）' : '');
    return '<option value="' + esc(f.name) + '" title="' + esc(tip) + '">' + esc(f.name) + kindTag + esc(tail) + '</option>';
  }).join('');
  if (keep && Array.prototype.some.call(sel.options, (o) => o.value === keep)) sel.value = keep;
}

function renderPfChips() {
  const box = $('#pf-chips'), note = $('#pf-note'), clr = $('#pf-clear');
  if (!box) return;
  box.innerHTML = state.filters.map((f, i) => {
    const noVal = f.op === 'empty' || f.op === 'notempty';
    const txt = f.field + ' ' + (PF_OPS[f.op] || f.op) + (noVal ? '' : ' ' + f.val);
    return '<span class="pf-chip">' + esc(txt) + '<button class="pf-x" data-i="' + i + '" title="移除">×</button></span>';
  }).join('');
  const t = state.sem && state.cur ? state.sem.tables[state.cur] : null;
  if (note) note.textContent = state.filters.length ? '筛出 ' + state.total + ' / 共 ' + (t ? t.rowCount : 0) + ' 行' : '';
  if (clr) clr.hidden = !state.filters.length;
}

function pfAdd() {
  const field = $('#pf-field').value;
  const op = $('#pf-op').value;
  const noVal = op === 'empty' || op === 'notempty';
  const val = $('#pf-val').value.trim();
  if (!field) return;
  if (!noVal && val === '') { $('#pf-val').focus(); return; }
  state.filters = state.filters.filter((f) => !(f.field === field && f.op === op));
  state.filters.push({ field, op, val: noVal ? '' : val });
  $('#pf-val').value = '';
  state.offset = 0;
  renderPfChips();
  loadRows();
}

function pfInit() {
  if (!$('#pf-field')) return;
  $('#pf-add').addEventListener('click', pfAdd);
  $('#pf-val').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pfAdd(); } });
  $('#pf-op').addEventListener('change', () => {
    const noVal = ['empty', 'notempty'].includes($('#pf-op').value);
    $('#pf-val').disabled = noVal;
    if (noVal) $('#pf-val').value = '';
  });
  $('#pf-chips').addEventListener('click', (e) => {
    const b = e.target.closest('.pf-x');
    if (!b) return;
    state.filters.splice(+b.dataset.i, 1);
    state.offset = 0;
    renderPfChips();
    loadRows();
  });
  $('#pf-clear').addEventListener('click', () => {
    if (!state.filters.length) return;
    state.filters = [];
    state.offset = 0;
    renderPfChips();
    loadRows();
  });
}

/* 中文字段名：从 Description 里取"名字"那一段。
   Description 的实际写法千奇百怪：
     开始时间 - 配置文件直接定义开始时间。请注意，如果是简单类型的重复性时间…
     持续时间, 指从开始时间加持续时间范围内是可用的 - 格式 day.hour:min:sec
     是否重复
   所以先按分隔符（。- ，, ；; ：: （( 以及 " - " 破折号）切出第一段，再按类型收紧长度。 */
function cnLabel(f, max) {
  if (f.name === 'RowName') return '行名';
  let d = String(f.desc || '')
    .replace(/[。，,；;：:(（].*$/, '')
    .replace(/\s*[-–—]\s+.*$/, '')
    .replace(/\s*[、][^、]*$/, '')
    .trim();
  // 有些字段的 Description 是英文（Type / Name 之类），那不是中文标题，别硬塞进主标题行
  if (!d || !/[\u4e00-\u9fa5]/.test(d)) return '';
  if (f.kind === 'bool') {
    // 「是否可重复」→「可重复」、「启用/禁用」→「启用」：布尔字段描述通常只是个问句
    d = d.replace(/^(是否|能否)/, '').replace(/\/.*$/, '').trim();
  }
  const cap = max || (f.kind === 'bool' ? 4 : 8);
  return d.length > cap ? d.slice(0, cap) + '…' : d;
}

/* 字段名显示：有中文描述时中文当主标题、英文字段名降为副标题，
   这样策划读中文就行，程序要对照 JSON 时看下面那行 */
function fkeyHtml(f) {
  const cn = cnLabel(f, f.kind === 'bool' ? 6 : 10);
  if (!cn) return esc(f.name);
  return '<span class="fk-cn">' + esc(cn) + '</span><span class="fk-en">' + esc(f.name) + '</span>';
}

/* 归一化成"只有字母数字"的串，用来判断两个名字是不是同一件事：
   Task_DailyTask_Progress / task_dailyTaskProgress / Task for DailyTask Progress
   → 归一化后都是 taskdailytaskprogress */
function normTokens(s) {
  return String(s == null ? '' : s).toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter((x) => x && !['for', 'the', 'a', 'an', 'of', 'and', 'to', 'in', 'by'].includes(x))
    .join('');
}
/* 与 RowName 同源的文本列：70% 以上的行归一化后互为子串，视为冗余列 */
function isRedundantText(f, rows) {
  const use = rows.filter((r) => r && r.RowName && r[f.name] != null && r[f.name] !== '');
  if (use.length < 3) return false;
  let hit = 0;
  for (const r of use) {
    const v = normTokens(r[f.name]);
    const rn = normTokens(r.RowName);
    if (v && rn && (v === rn || v.includes(rn) || rn.includes(v))) hit++;
  }
  return hit / use.length >= 0.7;
}

function pickColumns(t) {
  // 列集合 = RowName + 按 C# 声明顺序的前 5 个标量字段 + 1 个富字段。
  // 旧算法按「样本填充率」挑列并丢掉「只有一种值」的列，两个问题：
  //   ① 抽样只取前 80 行 —— Level 前 100 行全是主线关，StandardCoinBase 看着是 100% 有值，全表其实只有 200/2380 行有
  //   ② DefineName 前 100 行恒为 Main（主线关卡设计上就恒为同值），被判成「常量列」隐藏，而它是有效分类信息
  // 现在：填充率取全表统计（/api/fill），只用来隐藏「几乎全空」的列；排序改用类型声明顺序。
  const stats = state.fills && state.fills.table === state.cur ? state.fills.fields : null;
  if (state.colSample.table !== state.cur) {
    state.colSample = { table: state.cur, rows: state.rows.slice(0, 80) };
  }
  const sample = stats ? [] : state.colSample.rows;
  const isBlank = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  const cand = [];
  for (let fi = 0; fi < t.fields.length; fi++) {
    const f = t.fields[fi];
    if (['RowName', 'Notes'].includes(f.name)) continue;
    const isCond = f.kind === 'object' && /Logical/.test(f.def || '');
    // primarray（如 Task.Tags）也要能成为列——否则能筛却看不到
    if (!isCond && !['text', 'number', 'bool', 'enum', 'ref', 'datetime', 'duration', 'primarray', 'enumarray'].includes(f.kind)) continue;
    let fill = 1;
    let sameAsRowName = false;
    if (stats && stats[f.name]) {
      fill = stats[f.name].fill;
      sameAsRowName = stats[f.name].sameAsRowName;
    } else if (sample.length) {
      // 统计接口没拿到时回落到当前页样本
      const vals = sample.map((r) => r[f.name]);
      fill = vals.filter((v) => !isBlank(v)).length / sample.length;
      sameAsRowName = sample.every((r) => r[f.name] === undefined || r[f.name] === r.RowName);
    }
    // 与 RowName 完全同值的文本列没有信息量（DefineName 这类分类列通常不等于 RowName，会保留）
    if (f.kind === 'text' && sameAsRowName) continue;
    // Name = task_xxx、Description = Task for task xxx 这类列，和 RowName 是同一串信息的不同写法，
    // 留在表里只会把横向空间分走，让真正的 RowName 被截断
    if (f.kind === 'text' && isRedundantText(f, state.colSample.rows)) continue;
    // 只隐藏「几乎全空」的列（全表有值的行不足 2%）。不按「值只有一种」隐藏：
    // Level 的 DefineName 恒为 Main（主线 200 关），StandardCoinBase 只在 200/2380 行有值，都是有效信息
    if (fill < 0.02) continue;
    cand.push({ f, fill, order: fi });
  }
  // 排序列 = C# 字段声明顺序（表设计时的顺序），填充率只决定是否显示
  cand.sort((a, b) => a.order - b.order);
  // 5 个标量是上限：再多每列就只剩 8% 宽，RowName 会被截成看不懂的半截，反而更难用。
  // 需要看更多字段时，进编辑模式或右侧详情。
  const cols = [{ name: 'RowName', kind: 'text' }, ...cand.slice(0, 5).map((c) => c.f)];
  // 富字段（奖励数组 / 执行器 / 枚举数组）取全表填充率最高的一个，单独展示
  const richKinds = ['actuators', 'objectarray', 'enumarray'];
  const rich = t.fields
    .filter((f) => richKinds.includes(f.kind))
    .map((f) => ({ f, fill: stats && stats[f.name] ? stats[f.name].fill : 1 }))
    .sort((a, b) => b.fill - a.fill)[0];
  if (rich) cols.push(rich.f);
  return cols;
}

/* 列宽权重：按字段类型给"这个列大概多需要横向空间"，
   配合 table-layout:fixed 让所有列按比例分完视口宽度——
   否则长文本列会把表格撑出容器，最右边那列永远被切掉半个字。 */
const COL_W = { number: 9, bool: 7, ref: 13, enum: 9, text: 13, primarray: 16, objectarray: 18, actuators: 16, enumarray: 15, datetime: 12, duration: 10 };

/* 每列的最小像素宽：等宽字体（Maple Mono）下中文占两个英文字宽，
   表头中文 + 英文副标题最少要这么多，否则只剩省略号。
   只影响 table 的 min-width（超了横向滚动），不影响各列比例。 */
const COL_MIN = { number: 104, bool: 88, ref: 150, enum: 116, text: 150, primarray: 168, objectarray: 190, actuators: 176, enumarray: 170, datetime: 148, duration: 128 };

function renderGrid() {
  const t = state.sem.tables[state.cur];
  const cols = pickColumns(t);
  const tbl = document.getElementById('grid');
  const oldCg = tbl.querySelector('colgroup');
  if (oldCg) oldCg.remove();
  // 列宽用像素而不是百分比：百分比在 table-layout:fixed 下只能分到「容器宽/列数」，
  // 等宽字体下「推荐战斗力」这类表头会被压成「推…」。这里按每列的下限给像素，
  // 总和超过容器就让 .grid-wrap 出横向滚动条；容器更宽时整体等比放大铺满。
  const wrapEl = document.querySelector('.grid-wrap');
  const basePx = cols.map((c) => (c.name === 'RowName' ? 210 : (COL_MIN[c.kind] || 140)));
  const needPx = basePx.reduce((a2, b) => a2 + b, 0);
  const wrapW = wrapEl ? wrapEl.clientWidth : 0;
  const scale = wrapW > needPx ? wrapW / needPx : 1;
  const px = basePx.map((v) => Math.round(v * scale));
  tbl.style.minWidth = Math.max(wrapW, needPx) + 'px';
  tbl.insertAdjacentHTML('afterbegin', '<colgroup>' + px.map((w) => '<col style="width:' + w + 'px">').join('') + '</colgroup>');
  $('#grid-head').innerHTML = '<tr>' + cols.map((c) => {
    const tip = c.name + (c.desc ? ' · ' + c.desc : '') + ' · 点击打开列编辑';
    const cn = cnLabel(c);
    // 中文主标题 + 英文字段名副标题：策划读中文，程序对照 JSON 时看下面那行
    return '<th class="col-ed' + (cn ? ' has-cn' : '') + '" data-field="' + esc(c.name) + '" title="' + esc(tip) + '">'
      + (cn ? '<span class="th-cn">' + esc(cn) + '</span>' : '')
      + '<span class="th-en">' + esc(c.name) + '</span><i class="col-ed-i">▤</i></th>';
  }).join('') + '</tr>';
  if (!state.rows.length) {
    $('#grid-body').innerHTML = '';
    $('#empty').hidden = false;
  } else {
    $('#empty').hidden = true;
    $('#grid-body').innerHTML = state.rows.map((row, i) => {
      const abs = state.offset + i;
      return '<tr data-i="' + abs + '">' + cols.map((c) => {
        const txt = cellText(c, row);
        return '<td class="' + (c.kind === 'number' ? 'num' : c.name === 'RowName' ? 'rn' : '') + '" title="' + esc(txt) + '">' + esc(txt) + '</td>';
      }).join('') + '</tr>';
    }).join('');
  }
  const from = state.total ? state.offset + 1 : 0;
  $('#page-info').textContent = from + '–' + Math.min(state.offset + state.limit, state.total) + ' / ' + state.total;
  $('#prev').disabled = state.offset <= 0;
  $('#next').disabled = state.offset + state.limit >= state.total;
  markSelection();
  sfSync();
}

/* 重绘后把选中行的样式补回来（tbody 是整体重建的，.sel 会丢） */
function markSelection() {
  document.querySelectorAll('#grid-body tr.sel').forEach((x) => x.classList.remove('sel'));
  if (!state.selRow) return;
  const i = state.rows.findIndex((r) => r.RowName === state.selRow);
  if (i < 0) return;
  const tr = document.querySelector('#grid-body tr[data-i="' + (state.offset + i) + '"]');
  if (tr) tr.classList.add('sel');
}

function cellText(field, row) {
  const v = row[field.name];
  if (v === undefined) return '—';
  if (v === null) return '—';
  switch (field.kind) {
    case 'number':
      if (field.name === 'Probability' && typeof v === 'number') return (v / 100).toFixed(v % 100 ? 1 : 0) + '%';
      return fmtNum(v);
    case 'bool': return v ? '是' : '否';
    case 'enum': return state.sem.enums[field.enum]?.[String(v)] || String(v);
    case 'ref': return refLabel(field.target, v) || v;
    case 'actuators': {
      if (!Array.isArray(v)) return '—';
      const first = v[0];
      const one = first ? actuatorShort(first) : '—';
      return v.length > 1 ? one + ' 等 ' + v.length + ' 项' : one;
    }
    case 'objectarray': return Array.isArray(v) ? '[' + v.length + ' 项]' : String(v);
    case 'enumarray': return Array.isArray(v) ? v.map((x) => state.sem.enums[field.enum]?.[String(x)] || x).join(' / ') : String(v);
    case 'primarray': return Array.isArray(v) ? v.join(', ') : String(v);
    case 'poly':
      if (v && typeof v === 'object' && v.Name) return trackerText(v);
      return JSON.stringify(v).slice(0, 60);
    case 'object': {
      const c = condPlain(v);
      return c || JSON.stringify(v).slice(0, 60);
    }
    default: {
      const s = String(v);
      return s.length > 60 ? s.slice(0, 60) + '…' : s;
    }
  }
}

function actuatorShort(a) {
  if (!a || !a.Name) return '—';
  const meta = state.sem.actuators[a.Name];
  const p = a.JsonInput || {};
  const rowKey = Object.keys(p).find((k) => /RowName$/.test(k));
  const amtKey = ['Count', 'Quantity', 'Value', 'Grade'].find((k) => p[k] !== undefined);
  const label = rowKey ? refLabel(meta?.params?.[rowKey]?.target, p[rowKey]) || p[rowKey] : (meta?.desc || a.Name);
  const amt = amtKey ? '×' + fmtNum(p[amtKey]) : '';
  return (label || a.Name) + amt;
}

/* ---------- 条件树 ---------- */
const TRACKER_ZH = { Statistic: '统计', ServerUptime: '开服时长', ArenaRank: '竞技场排名', GuildMember: '公会人数', GuildLevel: '公会等级', GuildBossRank: '公会Boss排名' };

function trackerText(td) {
  if (!td) return '?';
  const meta = state.sem.actuators[td.Name];
  const p = td.JsonInput || {};
  const rowKey = Object.keys(p).find((k) => /RowName$/.test(k));
  const zh = TRACKER_ZH[td.Name] || (/[\u4e00-\u9fa5]/.test(meta?.desc || '') ? meta.desc : td.Name);
  const nice = rowKey ? refLabel(meta?.params?.[rowKey]?.target, p[rowKey]) : null;
  const target = nice || (rowKey ? p[rowKey] : '');
  const rest = Object.entries(p).filter(([k]) => k !== rowKey).map(([k, v]) => k + '=' + v).join(' ');
  return [zh, target, rest].filter(Boolean).join(' ');
}

const CMP_SYM = { 0: '=', 1: '≠', 2: '>', 3: '≥', 4: '<', 5: '≤' };

function condLeaf(c) {
  const sym = CMP_SYM[c.CompareOperator] ?? (state.sem.enums.CompareOperator?.[String(c.CompareOperator)] || '?');
  return trackerText(c.ProgressTrackerData) + ' ' + sym + ' ' + fmtNum(c.CompareValue);
}

function condPlain(node) {
  if (!node || typeof node !== 'object') return '';
  const kids = [];
  for (const c of node.Conditions || []) kids.push(condLeaf(c));
  for (const k of node.LogicalItems || []) { const t = condPlain(k); if (t) kids.push(t); }
  if (!kids.length) return '';
  if (kids.length === 1) return kids[0];
  const op = state.sem.enums.LogicOperator?.[String(node.Operator)] || '与';
  return '(' + kids.join(' ' + op + ' ') + ')';
}

function renderCondNode(node) {
  if (!node || typeof node !== 'object') return '';
  const kids = [];
  for (const c of node.Conditions || []) kids.push('<div class="cond-leaf">' + esc(condLeaf(c)) + '</div>');
  for (const k of node.LogicalItems || []) { const h = renderCondNode(k); if (h) kids.push(h); }
  if (!kids.length) return '';
  if (kids.length === 1) return kids[0];
  const op = state.sem.enums.LogicOperator?.[String(node.Operator)] || '与';
  return '<div class="cond-group"><span class="cond-op">' + esc(op) + '</span><div class="cond-children">' + kids.join('') + '</div></div>';
}

/* 行选中唯一入口：点击、方向键、goTo 都走这里。
   state.selRow 存 RowName 字符串（edit.js 与地址栏同步都按字符串用）。 */
function applySelection(row) {
  document.querySelectorAll('#grid-body tr.sel').forEach((x) => x.classList.remove('sel'));
  if (!row) {
    state.selRow = null;
    renderDetail(null);
    syncHash(state.cur, null);
    return;
  }
  state.selRow = row.RowName;
  const i = state.rows.indexOf(row);
  if (i >= 0) {
    const tr = document.querySelector('#grid-body tr[data-i="' + (state.offset + i) + '"]');
    if (tr) {
      tr.classList.add('sel');
      tr.scrollIntoView({ block: 'nearest' });
    }
  }
  renderDetail(row);
  syncHash(state.cur, row.RowName);
}

/* 移动选中行；到本页边界时自动翻页（上一页末行 / 下一页首行）。
   返回 true 表示按键已被消费，调用方据此 preventDefault。 */
function moveSelection(delta) {
  const n = state.rows.length;
  if (!n || !delta) return false;
  const cur = state.selRow ? state.rows.findIndex((r) => r.RowName === state.selRow) : -1;
  if (cur < 0) {
    applySelection(state.rows[delta > 0 ? 0 : n - 1]);
    return true;
  }
  const next = cur + delta;
  if (next >= 0 && next < n) {
    applySelection(state.rows[next]);
    return true;
  }
  if (delta > 0 && state.offset + state.limit < state.total) {
    state.offset += state.limit;
    loadRows().then(() => { if (state.rows[0]) applySelection(state.rows[0]); });
    return true;
  }
  if (delta < 0 && state.offset > 0) {
    state.offset = Math.max(0, state.offset - state.limit);
    loadRows().then(() => { const r = state.rows[state.rows.length - 1]; if (r) applySelection(r); });
    return true;
  }
  return false;
}

/* Home / End：本页第一行 / 最后一行 */
function jumpSelection(toEnd) {
  const n = state.rows.length;
  if (!n) return false;
  applySelection(state.rows[toEnd ? n - 1 : 0]);
  return true;
}

/* 一屏能放几行：PageUp / PageDown 用它算步长 */
function pageRows() {
  const wrap = document.querySelector('.grid-wrap');
  const tr = document.querySelector('#grid-body tr');
  if (!wrap || !tr) return 10;
  const h = tr.getBoundingClientRect().height || 26;
  return Math.max(1, Math.floor(wrap.clientHeight / h) - 1);
}

$('#grid-body').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  applySelection(state.rows[+tr.dataset.i - state.offset]);
});
$('#grid-head').addEventListener('click', (e) => {
  const th = e.target.closest('th.col-ed');
  if (!th || typeof CE === 'undefined') return;
  CE.open(th.dataset.field, state.filters);
});

$('#prev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); loadRows(); });
$('#next').addEventListener('click', () => { state.offset += state.limit; loadRows(); });
$('#row-search').addEventListener('input', (e) => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => { state.q = e.target.value.trim(); state.offset = 0; loadRows(); }, 250);
});
/* 搜索框里也能逐个跳：不用先点表格再按方向键 */
$('#row-search').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
  // 正在编辑就不能切行：切行会退出表单，没应用的内容会丢
  if (typeof EP !== 'undefined' && EP && (EP.detailMode === 'edit' || EP.detailMode === 'new')) {
    if (e.key !== 'Enter') e.preventDefault();
    setStatus('正在编辑这一行：先「应用修改」或「取消」，再用 ↑↓ 切换');
    return;
  }
  e.preventDefault();
  if (e.key === 'Enter' && state.q !== $('#row-search').value.trim()) {
    // 防抖还没到点，先立即搜一次
    clearTimeout(state.searchTimer);
    state.q = $('#row-search').value.trim();
    state.offset = 0;
    loadRows().then(() => reportLocate());
    return;
  }
  if (moveSelection(e.key === 'ArrowUp' ? -1 : 1)) reportLocate();
});
$('#locate').checked = state.locate;
$('#locate').addEventListener('change', (e) => {
  state.locate = !!e.target.checked;
  localStorage.setItem('wb.locate', state.locate ? '1' : '0');
  if (state.locate) { locateAfterLoad(); reportLocate(); }
});

/* ---------------- 搜索框：清除按钮 / Ctrl+F ---------------- */
function sfSync() {
  document.querySelectorAll('.sf-wrap').forEach((w) => {
    const inp = w.querySelector('input');
    const btn = w.querySelector('[data-sf-clear]');
    if (inp && btn) btn.hidden = !inp.value;
  });
}
document.querySelectorAll('.sf-wrap').forEach((w) => {
  const inp = w.querySelector('input');
  const btn = w.querySelector('[data-sf-clear]');
  if (!inp || !btn) return;
  const clear = (keepFocus) => {
    if (!inp.value) return false;
    inp.value = '';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    sfSync();
    if (keepFocus) inp.focus(); else inp.blur();
    return true;
  };
  btn.addEventListener('click', () => clear(true));
  inp.addEventListener('input', sfSync);
  inp.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!clear(false)) return;   /* 没内容时交给全局 Esc */
    e.preventDefault();
  });
});
/* 焦点落到搜索框；中栏太窄把「本表搜索」藏起来时，退化成全库搜索面板 */
function focusSearch(sel) {
  const el = $(sel);
  if (!el) return;
  if (el.offsetParent === null) { openCmdk(); return; }
  el.focus();
  el.select();
}

/* ---------------- detail ---------------- */
function renderDetail(row) {
  const el = $('#detail');
  if (!row) {
    el.innerHTML = '<div class="detail-empty"><p>← 从中间选一行</p><p class="hint">这里会把这一行配置翻译成人话</p></div>';
    return;
  }
  const t = state.sem.tables[state.cur];
  const summary = row.Notes && row.Notes.trim() ? row.Notes.trim() : autoSummary(t, row) || '（无可用摘要字段）';
  const fields = t.fields.filter((f) => f.name !== 'RowName');

  const html = '<div class="d-head">' +
    '<div class="d-rn">' + esc(row.RowName) + '</div>' +
    '<div class="d-summary">' + esc(summary || '（无摘要）') + '</div>' +
    '<div class="d-tags"><span class="badge">' + t.rowCount + ' 行 · 注释 ' + t.notesRate + '%</span>' +
    (t.increments ? Object.keys(t.increments).map((c) => '<span class="badge ch">' + esc(c) + '</span>').join('') : '') +
    '</div></div><div class="d-body">' +
    fields.map((f) => '<div class="f-row"><div class="f-key">' + fkeyHtml(f) + '</div>' +
      '<div class="f-val' + (f.kind === 'text' ? ' mono' : '') + '">' + renderValue(f, row[f.name]) + '</div>' +
      (f.desc ? '<div class="f-desc" title="' + esc(f.desc) + '">' + esc(f.desc) + '</div>' : '') +
      '</div>').join('') +
    '</div>';
  el.innerHTML = html;
  el.scrollTop = 0;
  el.querySelectorAll('[data-goto]').forEach((n) => n.addEventListener('click', (ev) => {
    ev.stopPropagation();
    goTo(n.dataset.goto, n.dataset.row);
  }));
}

async function goTo(table, rowname) {
  await selectTable(table);
  const idx = state.rows.findIndex((r) => r.RowName === rowname);
  if (idx >= 0) {
    state.offset = Math.floor(idx / state.limit) * state.limit;
    await loadRows();
    const i = state.rows.findIndex((r) => r.RowName === rowname);
    if (i >= 0) {
      const tr = document.querySelector('#grid-body tr[data-i="' + (state.offset + i) + '"]');
      if (tr) { tr.classList.add('sel'); tr.scrollIntoView({ block: 'center' }); renderDetail(state.rows[i]); }
    }
  } else {
    // 目标行可能在其他页：用服务端搜索定位；仍找不到就清空搜索并提示
    state.q = rowname;
    $('#row-search').value = rowname;
    await loadRows();
    if (!state.rows.length) {
      state.q = '';
      $('#row-search').value = '';
      await loadRows();
      setStatus(table + ' 中没有名为 ' + rowname + ' 的行');
      return;
    }
  }
  const hit = state.rows.find((r) => r.RowName === rowname);
  if (hit) state.selRow = hit.RowName;
  syncHash(table, rowname);
  setStatus('跳转到 ' + table + ' / ' + rowname);
}

/* URL 与界面状态保持同步：地址栏 = #/Config_表名/行名。
   用 replaceState 而不是给 location.hash 赋值，避免每点一行就往历史里塞一条，
   否则后退键要按几十次才能回到上一张表。 */
function hashOf(table, row) {
  return '#/' + table + (row ? '/' + encodeURIComponent(row) : '');
}

// 地址栏里的人写表名常常省掉 Config_ 前缀（#/Task/xxx），两种写法都认
function resolveTableName(raw) {
  if (!raw || !state.sem || !state.sem.tables) return null;
  if (state.sem.tables[raw]) return raw;
  const pre = 'Config_' + raw;
  return state.sem.tables[pre] ? pre : null;
}

function syncHash(table, row) {
  const next = hashOf(table, row);
  if (location.hash === next) return;
  try { history.replaceState(null, '', location.pathname + location.search + next); }
  catch (e) { location.hash = next; }
}

// 手改地址栏或前进/后退时跟随；replaceState 不触发 hashchange，所以不会自激。
window.addEventListener('hashchange', () => {
  const raw = decodeURIComponent(location.hash.slice(1)).replace(/^\//, '');
  if (!raw) return;
  if (location.hash === hashOf(state.cur, state.selRow || null)) return;
  const parts = raw.split('/');
  const t = resolveTableName(parts[0]);
  if (!t) return;
  selectTable(t).then(() => { if (parts[1]) goTo(t, parts[1]); });
});

function renderValue(f, v) {
  if (v === undefined || v === '') return '<span class="none">未设置</span>';
  if (v === null) return '<span class="none">未设置</span>';
  if (Array.isArray(v) && v.length === 0) return '<span class="none">空数组</span>';
  switch (f.kind) {
    case 'number':
      return '<span class="num">' + fmtNum(v) + '</span>' + (f.unit ? '<span class="unit">' + esc(f.unit) + '</span>' : '') +
        (f.note ? '<span class="unit">（' + esc(f.note) + '）</span>' : '');
    case 'bool':
      return v ? '<span class="enum-chip">是</span>' : '<span class="badge">否</span>';
    case 'enum': {
      const label = state.sem.enums[f.enum]?.[String(v)] || '未知值';
      return '<span class="enum-chip">' + esc(label) + '<span class="raw">' + esc(v) + '</span></span>';
    }
    case 'ref': {
      const ok = hasRow(f.target, v);
      const label = ok ? refLabel(f.target, v) : null;
      const showRaw = ok && label !== v;
      return '<span class="ref-chip' + (ok ? '' : ' dangling') + (f.implicit ? ' implicit' : '') + '" data-goto="' + esc(f.target) + '" data-row="' + esc(v) + '" title="' + esc(f.target) + ' / ' + esc(v) + (f.implicit ? '（数据推断，未经声明）' : '') + '">' +
        (ok ? esc(label) : '△ 目标不存在') +
        (showRaw ? '<span class="raw">' + esc(v) + '</span>' : '') +
        '<span class="target">→ ' + esc(f.target.replace(/^Config_/, '')) + '</span></span>';
    }
    case 'actuators':
      return '<div class="act-block">' + v.map((a) => renderActuator(a)).join('') + '</div>';
    case 'objectarray':
      return v.map((o, i) => renderObject(f.def, o, i)).join('');
    case 'primarray':
      return esc(v.join(', '));
    case 'enumarray':
      return '<div class="chips">' + v.map((x) => '<span class="enum-chip">' + esc(state.sem.enums[f.enum]?.[String(x)] || x) + '</span>').join('') + '</div>';
    case 'duration':
      return '<span class="mono">' + esc(v) + '</span><span class="unit">天.时:分:秒</span>';
    case 'datetime':
      return '<span class="mono">' + esc(v) + '</span>';
    case 'poly': {
      if (v && typeof v === 'object' && v.Name) return '<span class="act"><b>' + esc(trackerText(v)) + '</b></span>';
      return '<span class="mono">' + esc(JSON.stringify(v)) + '</span>';
    }
    case 'object': {
      const tree = renderCondNode(v);
      if (tree) return tree;
      return '<span class="mono">' + esc(JSON.stringify(v)) + '</span>';
    }
    default:
      return esc(String(v));
  }
}

function renderActuator(a) {
  const meta = state.sem.actuators[a?.Name];
  const p = a?.JsonInput || {};
  const rowKey = Object.keys(p).find((k) => /RowName$/.test(k));
  const label = rowKey
    ? refLabel(meta?.params?.[rowKey]?.target, p[rowKey]) || p[rowKey]
    : meta?.desc || a?.Name || '?';
  const rest = Object.entries(p)
    .filter(([k]) => k !== rowKey)
    .map(([k, v]) => {
      if (k === 'Count' || k === 'Quantity') return '×' + fmtNum(v);
      if (k === 'Grade') return v + ' 阶';
      if (typeof v === 'boolean') return v ? '' : '（否）';
      return typeof v === 'number' ? String(v) : String(v);
    })
    .filter(Boolean)
    .join(' ');
  let restOut = rest;
  if (p.Attribute !== undefined && p.Value !== undefined) {
    restOut = String(p.Attribute) + (Number(p.Value) >= 0 ? ' +' : ' ') + fmtNum(p.Value);
  }
  const tip = (a?.Name || '') + '\n' + Object.entries(p).map(([k, v]) => k + ': ' + JSON.stringify(v)).join('\n');
  return '<span class="act" title="' + esc(tip) + '"><b>' + esc(label) + '</b>' + (restOut ? ' <em>' + esc(restOut) + '</em>' : '') + '</span>';
}

function shortDesc(d, fallback, max = 12) {
  if (!d) return fallback;
  let s = String(d).split(/[。.]/)[0].trim();
  const c = s.search(/[，,]/);
  if (c > 2 && c <= max) s = s.slice(0, c);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/* ---------- 嵌套对象形状渲染 ---------- */
const STEP_KEYS = ['RequiredValue','AtLevel','AtDay','Level','Order','Stage','Day','Grade','Rank','Num','Times','Index','QuantityAchieved','TargetGrade','StartPosition','EndPosition','StartPoints','EndPoints','RewardIndex','Capacity','PityTimes','DrawMaxTimes','AtTurn','LevelRowName','Postion'];
const VAL_KEYS = ['Rewards','Reward','Actuators','Actuator','Cost','CostActuators','Actions','Items','Buffs','Output','Outputs','DailyRewards','SeasonRewards','RankUpRules','RowNames','Tasks','Tags','Gachas','Defines','RandomOuput','Values','GroupDefineName'];
const KEY_CN = {
  Channel: '渠道', Id: 'ID', Name: '名称', Value: '值', Count: '数量', Weight: '权重', Grade: '阶',
  Level: '等级', Index: '序号', Order: '顺序', Date: '日期', IsOffDay: '休息日', Rank: '名次',
  Capacity: '容量', Num: '数量', CostNum: '消耗', Discount: '折扣', Probability: '概率',
  QualityTag: '品质', Tags: '标签', Day: '天', AtDay: '天', RequiredValue: '进度', Type: '类型',
  Duration: '时长', Radius: '半径', Times: '次数', MaxTimes: '最大次数', Speed: '速度',
  IsBasePity: '基础保底', IsTypeB: 'B 池', PityTimes: '保底次数', IfSendToClient: '下发客户端',
  EnvironmentRowName: '环境', StarValue: '星级', ConditionRowName: '条件', EquipmentRowName: '装备',
  RowName: '行', TaskRowName: '任务', ProductRowName: '商品', GiftPackRowName: '礼包', Buffs: 'Buff',
  Tasks: '任务', RowNames: '行', Postion: '位置', GroupDefineName: '分组', RewardIndex: '奖励序号',
  CheckType: '检查方式', GradeLevel: '阶数', RequireCount: '需求数量', StartPosition: '起始位',
  EndPosition: '结束位', X: 'X', Y: 'Y', Z: 'Z'
};

const stepHtml = (key, val, rawKey) =>
  '<div class="step"><span class="step-key">' + (rawKey ? key : esc(String(key))) + '</span>' +
  '<span class="step-arrow">→</span><div class="step-val">' + val + '</div></div>';

function refChip(target, raw) {
  if (raw === undefined || raw === null || raw === '') return '<span class="none">未设置</span>';
  const ok = hasRow(target, raw);
  const label = ok ? refLabel(target, raw) : String(raw);
  return '<span class="ref-chip' + (ok ? '' : ' dangling') + '" data-goto="' + esc(target) + '" data-row="' + esc(raw) +
    '" title="' + esc(target + ' / ' + raw) + '">' + esc(label) +
    '<span class="target">→ ' + esc(target.replace(/^Config_/, '')) + '</span></span>';
}

function shapeVal(v) {
  if (v === undefined || v === null || v === '') return '<span class="none">未设置</span>';
  if (Array.isArray(v)) return v.map((x) => (x && x.Name) ? renderActuator(x) : ((x && typeof x === 'object') ? renderObject('', x, 0) : '<span class="mono">' + esc(String(x)) + '</span>')).join('');
  if (v && typeof v === 'object') return renderObject('', v, 0);
  return '<span class="mono">' + esc(String(v)) + '</span>';
}

function kvPart(k, v) {
  const t = state.sem.refTargets[k] && state.sem.refTargets[k].target;
  const label = '<span class="kv-k">' + esc(KEY_CN[k] || k) + '</span> ';
  if (t && typeof v === 'string' && v !== '') return label + refChip(t, v);
  if (Array.isArray(v)) {
    if (v.length && v[0] && typeof v[0] === 'object') {
      return label + v.map((x) => (x && x.Name) ? renderActuator(x) : '<span class="mono">' + esc(JSON.stringify(x)) + '</span>').join('');
    }
    return label + esc(v.join(', '));
  }
  if (v && typeof v === 'object') return label + shapeVal(v);
  if (v === null || v === '') return label + '<span class="none">未设置</span>';
  return label + esc(String(v));
}

function renderObject(def, obj, i) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
  const kset = new Set(Object.keys(obj));

  if (kset.has('Name') && kset.has('JsonInput')) return renderActuator(obj);

  // 价格：{UnitAmount, Amounts:[{ItemId, Amount}]}
  if (kset.has('Amounts') && kset.has('UnitAmount')) {
    const list = obj.Amounts || [];
    const cost = list.length
      ? list.map((m) => refChip('Config_CatalogItem', m.ItemId) + ' ×' + fmtNum(m.Amount)).join(' + ')
      : '<span class="none">免费</span>';
    return stepHtml('每 ' + fmtNum(obj.UnitAmount) + ' 个', cost);
  }

  // 权重池
  if (kset.has('Weight')) {
    const vk = VAL_KEYS.find((k) => kset.has(k));
    return stepHtml('权重 ' + fmtNum(obj.Weight), vk ? shapeVal(obj[vk]) : '');
  }

  // 坐标
  if (kset.has('X') && kset.has('Y') && kset.has('Z')) {
    return stepHtml('坐标', '<span class="mono">' + esc([obj.X, obj.Y, obj.Z].map((n) => Math.round(n * 10) / 10).join(', ')) + '</span>');
  }

  // 名次区间
  const sPos = obj.StartPosition !== undefined ? 'StartPosition' : (obj.StartPoints !== undefined ? 'StartPoints' : null);
  const ePos = obj.EndPosition !== undefined ? 'EndPosition' : (obj.EndPoints !== undefined ? 'EndPoints' : null);
  if (sPos && ePos) {
    const vk = VAL_KEYS.find((k) => kset.has(k));
    const unit = sPos === 'StartPoints' ? ' 分' : ' 名';
    const extra = ['Rank', 'RobotRankRateValue', 'RankChangeValue', 'SeasonInitDeductRank']
      .filter((k) => kset.has(k) && typeof obj[k] !== 'object').slice(0, 2)
      .map((k) => (KEY_CN[k] || k) + ' ' + obj[k]).join(' · ');
    return stepHtml(fmtNum(obj[sPos]) + '–' + fmtNum(obj[ePos]) + unit,
      (vk ? shapeVal(obj[vk]) : '') + (extra ? '<span class="obj-note">' + esc(extra) + '</span>' : ''));
  }

  // 战力区间：{StartCombatPower, EndCombatPower, ExpectationChallengeTowerValue}
  if (kset.has('StartCombatPower') && kset.has('EndCombatPower')) {
    const rest = Object.entries(obj).filter(([k]) => !/^StartCombatPower|^EndCombatPower/.test(k))
      .map(([k, v]) => k === 'ExpectationChallengeTowerValue'
        ? '<span class="mono">第 ' + v + ' 层</span>'
        : '<span class="mono">' + esc(k + ' ' + v) + '</span>').join(' · ');
    return stepHtml(fmtNum(obj.StartCombatPower) + '–' + fmtNum(obj.EndCombatPower) + ' 战力', rest);
  }

  // 渠道商品：{Channel, Id}
  if (kset.has('Channel') && kset.has('Id')) {
    return stepHtml('渠道 ' + obj.Channel, '<span class="mono">ID ' + esc(String(obj.Id)) + '</span>');
  }

  // 物品数量：{Id, Count}
  if (kset.has('Id') && kset.has('Count')) {
    return stepHtml(refChip('Config_CatalogItem', obj.Id), '<span class="mono">×' + fmtNum(obj.Count) + '</span>', true);
  }

  // 节假日：{Date, IsOffDay, Name}
  if (kset.has('Date') && kset.has('IsOffDay')) {
    return stepHtml(String(obj.Date).slice(0, 10) + ' ' + obj.Name,
      '<span class="mono">' + (obj.IsOffDay ? '休息' : '上班') + '</span>');
  }

  // 条件门控
  if (kset.has('ConditionRowName')) {
    const cond = obj.ConditionRowName;
    const rest = Object.entries(obj).filter(([k]) => k !== 'ConditionRowName')
      .map(([k, v]) => kvPart(k, v)).join('<span class="kv-sep"> · </span>');
    if (!cond) return '<div class="kv-line">' + rest + '</div>';
    return stepHtml(refChip('Config_Condition', cond), rest, true);
  }

  // 单引用 + 附加属性：{GiftPackRowName} / {EnvironmentRowName, StarValue} / {ItemRowName, Level...}
  { 
    const rowKeys = Object.keys(obj).filter((k) => /RowName$/.test(k));
    if (rowKeys.length === 1 && !VAL_KEYS.some((k) => kset.has(k))) {
      const rk = rowKeys[0];
      const rest = Object.entries(obj).filter(([k]) => k !== rk)
        .map(([k, v]) => (KEY_CN[k] || k) + ' ' + (v === null || v === '' ? '—' : v)).join(' · ');
      const tgt = state.sem.refTargets[rk] && state.sem.refTargets[rk].target;
      if (tgt) return stepHtml(refChip(tgt, obj[rk]), rest, true);
      return stepHtml(String(obj[rk] || '—'), rest);
    }
  }

  // 序号 + 等级：{Index, Level}
  if (kset.has('Index') && kset.has('Level') && kset.size === 2) {
    return stepHtml('#' + obj.Index, '<span class="mono">' + obj.Level + ' 级</span>');
  }

  // 阶梯键 + 值键
  const sk = STEP_KEYS.find((k) => kset.has(k) && (obj[k] === null || typeof obj[k] !== 'object'));
  const vk = VAL_KEYS.find((k) => kset.has(k));
  if (sk && vk) {
    let key = String(obj[sk]);
    if (sk === 'LevelRowName') key = refLabel('Config_Level', obj[sk]) || obj[sk];
    else if (sk === 'AtLevel') key = obj[sk] + ' 级';
    else if (sk === 'AtDay') key = obj[sk] + ' 天';
    else if (sk === 'RequiredValue' || sk === 'QuantityAchieved') key = fmtNum(obj[sk]);
    else if (sk === 'Grade') key = obj[sk] + ' 阶';
    else if (sk === 'AtTurn') key = '第 ' + obj[sk] + ' 回合';
    const rest = Object.entries(obj)
      .filter(([k, v]) => k !== sk && k !== vk && v !== undefined && v !== null && v !== '' && typeof v !== 'object')
      .map(([k, v]) => (KEY_CN[k] || k) + ' ' + v).join(' · ');
    return stepHtml(key, shapeVal(obj[vk]) + (rest ? '<span class="obj-note">' + esc(rest) + '</span>' : ''));
  }

  // 纯值列表
  if (vk) {
    const arr = Array.isArray(obj[vk]) ? obj[vk] : null;
    if (arr && arr.length && arr.every((x) => x && typeof x === 'object' && STEP_KEYS.some((k) => x[k] !== undefined))) {
      return arr.map((x) => renderObject('', x, i)).join('');
    }
    return stepHtml('第 ' + (i + 1) + ' 档', shapeVal(obj[vk]));
  }

  // 成长曲线：{Order, BaseValue}
  if (kset.has('Order') && kset.has('BaseValue') && kset.size === 2) {
    return stepHtml(obj.Order + ' 级', '<span class="mono">' + fmtNum(obj.BaseValue) + '</span>');
  }

  // 属性加成：{Name, Value}
  if (kset.has('Name') && kset.has('Value') && kset.size === 2) {
    return '<div class="kv-line"><span class="mono">' + esc(String(obj.Name)) + '</span>' +
      (Number(obj.Value) >= 0 ? ' +' : ' ') + fmtNum(obj.Value) + '</div>';
  }

  // 单独进度：{RequiredValue}
  if (kset.size === 1 && kset.has('RequiredValue')) return stepHtml('进度 ' + fmtNum(obj.RequiredValue), '');

  // 名次容量：{Rank, Capacity}
  if (kset.has('Rank') && kset.has('Capacity') && kset.size === 2) {
    return stepHtml('第 ' + obj.Rank + ' 名', '<span class="mono">容量 ' + obj.Capacity + '</span>');
  }

  // 阶/级：{Grade, Level}
  if (kset.has('Grade') && kset.has('Level') && kset.size === 2) {
    return stepHtml(obj.Grade + ' 阶', '<span class="mono">' + obj.Level + ' 级</span>');
  }

  // 时间区间：{StartTime, EndTime}
  if (kset.has('StartTime') && kset.has('EndTime') && typeof obj.StartTime === 'string' && obj.StartTime.length <= 8) {
    return stepHtml(obj.StartTime + '–' + obj.EndTime, '');
  }

  // 兑换消耗：{Amount, ItemId}
  if (kset.has('Amount') && kset.has('ItemId')) {
    return stepHtml(refChip('Config_CatalogItem', obj.ItemId), '<span class="mono">×' + fmtNum(obj.Amount) + '</span>', true);
  }

  // 兜底：单行键值
  return '<div class="kv-line">' + Object.entries(obj).map(([k, v]) => kvPart(k, v)).join('<span class="kv-sep"> · </span>') + '</div>';
}

function autoSummary(t, row) {
  const parts = [];
  let nums = 0, refs = 0;
  for (const f of t.fields) {
    if (parts.length >= 3) break;
    if (['RowName', 'Notes', 'actuators', 'objectarray', 'poly', 'object', 'primarray', 'enumarray'].includes(f.kind)) continue;
    const v = row[f.name];
    if (v === undefined || v === null || v === '') continue;
    if (f.kind === 'number') {
      if (nums >= 1) continue;
      nums++;
      parts.push(shortDesc(f.desc, f.name, 8) + ' ' + fmtNum(v));
    } else if (f.kind === 'ref') {
      if (refs >= 1) continue;
      refs++;
      parts.push(shortDesc(f.desc, f.name, 8) + ' ' + (refLabel(f.target, v) || v));
    } else if (f.kind === 'enum') {
      parts.push(shortDesc(f.desc, f.name, 8) + ' ' + (state.sem.enums[f.enum]?.[String(v)] || v));
    } else if (f.kind === 'bool') {
      parts.push(shortDesc(f.desc, f.name, 8) + (v ? ' 开' : ' 关'));
    } else if (typeof v === 'string' && v.length <= 12 && f.desc) {
      parts.push(shortDesc(f.desc, f.name, 8) + ' ' + v);
    }
  }
  const rewards = t.fields.find((f) => f.kind === 'actuators');
  if (rewards && Array.isArray(row[rewards.name]) && row[rewards.name].length) {
    const arr = row[rewards.name];
    parts.push(shortDesc(rewards.desc, rewards.name) + ' ' + arr.slice(0, 2).map(actuatorShort).join('、') + (arr.length > 2 ? ' 等 ' + arr.length + ' 项' : ''));
  }
  const s = parts.join(' · ');
  return s.length > 58 ? s.slice(0, 58) + '…' : s;
}

/* ---------------- 全局搜索：页头下拉 + Ctrl+K 命令面板 ---------------- */
// 两套 UI 共用同一套结果渲染与键盘导航；样式全在 CSS（.hit / .cmdk-*），
// 早先 panel 用 inline style 写死 #fff，暗色模式下就是一块白底。

function hitsHtml(hits) {
  if (!hits.length) return '<div class="hit-empty">没有匹配的行</div>';
  return hits.slice(0, 60).map((h) =>
    '<div class="hit" data-t="' + esc(h.table) + '" data-r="' + esc(h.row) + '">' +
      '<div><span class="hit-rn">' + esc(h.row) + '</span>' +
      '<span class="hit-tb">' + esc(h.table.replace(/^Config_/, '')) + '</span></div>' +
      (h.notes ? '<div class="hit-notes">' + esc(h.notes) + '</div>' : '') +
    '</div>').join('');
}

// 容器内 .hit 的键盘导航：idx 从 -1 起（未选中），move 时 clamp，
// 鼠标移入用 setTo 同步，避免"悬停项"和"键盘选中项"同时亮两条。
function makeListNav(container) {
  let idx = -1;
  const items = () => Array.from(container.querySelectorAll('.hit'));
  return {
    reset() { idx = -1; },
    items,
    current() { const l = items(); return idx >= 0 ? l[idx] : null; },
    move(d) {
      const l = items();
      if (!l.length) return;
      idx = Math.max(0, Math.min(l.length - 1, idx + d));
      l.forEach((n, k) => n.classList.toggle('active', k === idx));
      l[idx].scrollIntoView({ block: 'nearest' });
    },
    setTo(n) {
      const l = items();
      const k = l.indexOf(n);
      if (k < 0) return;
      idx = k;
      l.forEach((m, i) => m.classList.toggle('active', i === idx));
    },
  };
}

function chooseHit(n) {
  if (!n) return;
  panel.style.display = 'none';
  $('#global-search').value = '';
  closeCmdk();
  goTo(n.dataset.t, n.dataset.r);
}

/* ---- 页头输入框的下拉 ---- */
const panel = document.createElement('div');
panel.id = 'search-panel';
panel.className = 'search-panel';
document.body.appendChild(panel);
const headNav = makeListNav(panel);
panel.addEventListener('mouseover', (e) => { const n = e.target.closest('.hit'); if (n) headNav.setTo(n); });
panel.addEventListener('mousedown', (e) => {
  const n = e.target.closest('.hit');
  if (n) { e.preventDefault(); chooseHit(n); }
});

$('#global-search').addEventListener('keydown', (e) => {
  const open = panel.style.display === 'block';
  if (e.key === 'ArrowDown') { e.preventDefault(); if (open) headNav.move(1); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); if (open) headNav.move(-1); return; }
  if (e.key === 'Enter') {
    if (!open) return;
    e.preventDefault();
    chooseHit(headNav.current() || panel.querySelector('.hit'));
    return;
  }
  if (e.key === 'Escape') {
    if (open) { e.preventDefault(); panel.style.display = 'none'; headNav.reset(); }
  }
});

$('#global-search').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(state.searchTimer);
  if (!q) { panel.style.display = 'none'; return; }
  state.searchTimer = setTimeout(() => {
    const hits = DS.search(q);
    const box = $('#global-search').getBoundingClientRect();
    panel.style.left = box.left + 'px';
    panel.style.top = (box.bottom + 6) + 'px';
    panel.style.width = Math.max(box.width, 420) + 'px';
    panel.innerHTML = hitsHtml(hits);
    panel.style.display = 'block';
    headNav.reset();
  }, 220);
});

document.addEventListener('click', (e) => {
  if (!panel.contains(e.target) && e.target.id !== 'global-search') panel.style.display = 'none';
});

/* ---- Ctrl+K / Cmd+K 命令面板 ---- */
const cmdk = document.createElement('div');
cmdk.className = 'cmdk-mask';
cmdk.hidden = true;
cmdk.innerHTML =
  '<div class="cmdk" role="dialog" aria-modal="true" aria-label="搜索配置行">' +
    '<div class="cmdk-bar">' +
      '<svg class="cmdk-ico" aria-hidden="true"><use href="#i-search"></use></svg>' +
      '<input class="cmdk-q" id="cmdk-q" placeholder="搜索 RowName 或备注关键字…" autocomplete="off" spellcheck="false" />' +
      '<kbd>Esc</kbd>' +
    '</div>' +
    '<div class="cmdk-list" id="cmdk-list"></div>' +
    '<div class="cmdk-foot">' +
      '<span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>' +
      '<span><kbd>Enter</kbd> 打开</span>' +
      '<span><kbd>Esc</kbd> 关闭</span>' +
    '</div>' +
  '</div>';
document.body.appendChild(cmdk);

const cmdkQ = $('#cmdk-q');
const cmdkList = $('#cmdk-list');
const cmdkNav = makeListNav(cmdkList);
let cmdkTimer;

function cmdkTip() {
  const n = state.sem && state.sem.stats ? state.sem.stats.tables : '';
  return '<div class="cmdk-tip">输入行名或备注关键字开始搜索' + (n ? ' · 共 ' + n + ' 张表' : '') + '</div>';
}

function openCmdk() {
  panel.style.display = 'none';
  cmdk.hidden = false;
  cmdkQ.value = '';
  cmdkList.innerHTML = cmdkTip();
  cmdkNav.reset();
  cmdkQ.focus();
}

function closeCmdk() {
  if (cmdk.hidden) return;
  cmdk.hidden = true;
  cmdkNav.reset();
}

cmdkQ.addEventListener('input', () => {
  clearTimeout(cmdkTimer);
  const q = cmdkQ.value.trim();
  if (!q) { cmdkList.innerHTML = cmdkTip(); cmdkNav.reset(); return; }
  cmdkTimer = setTimeout(() => {
    cmdkList.innerHTML = hitsHtml(DS.search(q));
    cmdkNav.reset();
  }, 120);
});

cmdkQ.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); cmdkNav.move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkNav.move(-1); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    chooseHit(cmdkNav.current() || cmdkList.querySelector('.hit'));
  }
  else if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); }
});

cmdkList.addEventListener('mouseover', (e) => { const n = e.target.closest('.hit'); if (n) cmdkNav.setTo(n); });
cmdkList.addEventListener('mousedown', (e) => {
  const n = e.target.closest('.hit');
  if (n) { e.preventDefault(); chooseHit(n); }
});
cmdk.addEventListener('mousedown', (e) => { if (e.target === cmdk) closeCmdk(); });

// 全局快捷键：Ctrl+K / Cmd+K 开关面板；不在输入状态时 / 也打开面板（与主流站点一致）。
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if (cmdk.hidden) openCmdk(); else closeCmdk();
    return;
  }
  /* Ctrl+F 本表搜索、Ctrl+Shift+F 左侧表筛选（浏览器自带的查找被接管） */
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    focusSearch(e.shiftKey ? '#table-filter' : '#row-search');
    return;
  }
  const el = document.activeElement;
  const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  if (e.key === '/' && !typing) { e.preventDefault(); openCmdk(); return; }
  if (e.key === 'Escape') { closeCmdk(); panel.style.display = 'none'; }

  /* ↑↓ 切换选中行、Home/End 到本页首尾、PageUp/PageDown 翻一屏。
     和 E / Delete 一样要避让输入框、弹层和编辑态；行已进删除队列也照常能选。 */
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (typing) return;
  if (document.querySelector('.rp-mask:not([hidden]), .cmdk-mask:not([hidden]), .cfm-mask, .modal-mask, .ce-mask, .gd-mask:not([hidden])')) return;
  if (document.getElementById('ed-apply')) return;
  let moved = false;
  if (e.key === 'ArrowDown') moved = moveSelection(1);
  else if (e.key === 'ArrowUp') moved = moveSelection(-1);
  else if (e.key === 'PageDown') moved = moveSelection(pageRows());
  else if (e.key === 'PageUp') moved = moveSelection(-pageRows());
  else if (e.key === 'Home') moved = jumpSelection(false);
  else if (e.key === 'End') moved = jumpSelection(true);
  if (moved) e.preventDefault();
});

/* ---------------- 磁盘变化检测 ---------------- */
/* git pull / 别人改文件之后不用重开工作台：切回窗口时比对一次 mtime 与大小。
   当前表变了就直接从磁盘重载；别的表变了只在状态栏提示，不打断正在做的事。 */
let diskCheckedAt = 0;
let semNotified = false;   // schema 变化的提醒只弹一次
async function checkDiskChanges() {
  const t = Date.now();
  if (t - diskCheckedAt < 800) return;          // 焦点来回抖时不要连环查目录
  diskCheckedAt = t;
  if (!state.cur) return;
  if (document.getElementById('ed-apply')) return;               // 正在编辑
  if (window.EP && EP.pending && EP.pending.size) return;        // 有未保存的改动
  /* schema 只在启动时读一次，改了必须重开工作台；这里只负责提醒一次 */
  try {
    const st = await DS.schemaStamp();
    const at = DS.schemaStampAt;
    if (st && at && !semNotified && (st[0] !== at[0] || st[1] !== at[1])) {
      semNotified = true;
      await uiAlert('json-schemas 更新过了',
        'json-schemas 目录在上次启动之后有更新（现在共 ' + st[0] + ' 个 schema 文件）。\n\n' +
        '语义层（字段说明、枚举中文、执行器参数）是启动时算好的，现在显示的还是旧的。\n' +
        '关掉工作台重开一次就会重新算。');
    }
  } catch (e) {}
  let r;
  try { r = await DS.checkDisk(); } catch (e) { return; }
  /* pending 是累积的：别的表变了之后一直留着，直到那张表被重新读过。
     只用本次的 changed/removed 的话，提示会在下一次 focus 就消失。 */
  const dirty = r.pending || [...new Set([].concat(r.changed, r.added, r.removed))];
  if (!dirty.length) return;
  const cur = state.cur;
  if (dirty.indexOf(cur) >= 0) {
    setStatus('磁盘上的 ' + cur + '.json 变了，正在重新加载…');
    try {
      DS.invalidate(cur);
      state.notes[cur] = await DS.notes(cur);
      renderTableList();
      await loadRows();
      const row = state.selRow ? state.rows.find((x) => x.RowName === state.selRow) : null;
      if (row) renderDetail(row);
      else { state.selRow = null; renderDetail(null); }
      setStatus('已从磁盘重新加载 ' + cur + '（外部改动）');
    } catch (e) {
      setStatus('重新加载失败：' + (e.message || e));
    }
    return;
  }
  setStatus(dirty.length + ' 张配置文件在磁盘上变了：' + dirty.slice(0, 3).join('、') +
    (dirty.length > 3 ? ' …' : '') + '　切到那张表或按 R 重新加载');
}

/* 只挂一次：init 成功后由 startApp 调用 */
function watchDisk() {
  if (watchDisk.done) return;
  watchDisk.done = true;
  window.addEventListener('focus', () => { checkDiskChanges(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDiskChanges(); });
}

function setStatus(s) { $('#status').textContent = s; }
pfInit();
/* 桌面版启动器（boot.js）要先让用户选配置目录，选好后才调 __START_APP__ */
function startApp() {
  init()
    .then(() => {
      watchDisk();
      if (window.GIT && window.GIT.refresh) window.GIT.refresh();
      if (window.UPD && window.UPD.start) window.UPD.start();
    })
    .catch((e) => { setStatus('加载失败: ' + e.message); console.error(e); });
}
window.__START_APP__ = startApp;
if (!window.__HOLD_INIT__) startApp();
