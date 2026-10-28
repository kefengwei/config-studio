/* 配置工作台 · 前端数据层
 * 服务端只做三件事：供静态文件、读原文、写原文。
 * 解析 / 缓存 / 筛选 / 编辑 / 校验 / diff 全部在浏览器里完成。
 */
const DS = (() => {
  const files = new Map();   // name -> { text, data }
  const notes = new Map();   // name -> { RowName: Notes }
  const fills = new Map();   // name -> { total, fields }
  const allCache = new Map(); // name -> Items[]（只在「删除前查引用」时全量加载，一次性）
  let SEM = null;
  let fileList = [];
  let staleTables = { added: [], removed: [] };
  let current = null;
  const MAX_OPEN = 4;

  const fileName = (n) => (/\.json$/.test(n) ? n : n + '.json');
  const baseName = (n) => n.replace(/\.json$/, '');
  const stripBom = (s) => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);
  const byteLen = (s) => new TextEncoder().encode(s).length;

  async function init(onProgress) {
    const r = await fetch('/assets/semantics.json').then((x) => x.json());
    SEM = r;
    const list = await fetch('/api/tables').then((x) => x.json());
    fileList = list.tables || [];
    const names = Object.keys(SEM.tables);
    /* 语义层只在构建时生成，所以"新增/删除配置文件"它不会自己跟上。
       这里只做零误报的检测：目录里有但语义层没有的表、语义层有但文件没了的表。
       （工作台自己写文件只会改 mtime，不会触发这个提示） */
    const onDisk = new Set();
    for (const f of fileList) {
      const n = baseName(f.name);
      if (n.indexOf('.') === -1) onDisk.add(n);   // 只要基表，Config_X.<channel>.json 是增量
    }
    const semSet = new Set(names);
    staleTables = {
      added: [...onDisk].filter((n) => !semSet.has(n)).sort(),
      removed: [...semSet].filter((n) => !onDisk.has(n)).sort(),
    };
    let done = 0;
    const queue = names.slice();
    const worker = async () => {
      while (queue.length) {
        const n = queue.shift();
        try { await ensureNotes(n); } catch (e) { /* 单表失败不影响整体 */ }
        done++;
        if (onProgress && done % 8 === 0) onProgress(done, names.length);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
    if (onProgress) onProgress(names.length, names.length);
    return SEM;
  }

  async function readText(name) {
    const res = await fetch('/api/file?name=' + encodeURIComponent(fileName(name)));
    if (!res.ok) throw new Error('读取失败：' + name + '（HTTP ' + res.status + '）');
    return await res.text();
  }

  async function open(name) {
    const base = baseName(name);
    if (files.has(base)) {
      const hit = files.get(base);
      files.delete(base);
      files.set(base, hit);
      return hit;
    }
    const text = await readText(base);
    const data = JSON.parse(stripBom(text));
    const entry = { text, data };
    files.set(base, entry);
    while (files.size > MAX_OPEN) {
      const first = files.keys().next().value;
      if (first === current) { files.delete(first); files.set(first, files.get(first)); continue; }
      files.delete(first);
    }
    return entry;
  }

  function touch(name) { current = baseName(name); }

  function indexOf(data) {
    const map = {};
    for (const it of data.Items || []) {
      if (!it || typeof it !== 'object') continue;
      const rn = it.RowName;
      if (rn === undefined || rn === null) continue;
      map[String(rn)] = it.Notes === undefined || it.Notes === null ? '' : String(it.Notes);
    }
    return map;
  }

  async function ensureNotes(name) {
    const base = baseName(name);
    if (notes.has(base)) return notes.get(base);
    let data;
    if (files.has(base)) data = files.get(base).data;
    else data = JSON.parse(stripBom(await readText(base)));
    const map = indexOf(data);
    notes.set(base, map);
    /* 顺手把统计回写语义层。语义层是构建期快照，行数/注释率会随配置改动过期；
       而 init 为了算 Notes 索引本来就要读全文，这里零额外 IO 就能让侧栏数字保持真实。 */
    const def = SEM && SEM.tables ? SEM.tables[base] : null;
    if (def) {
      const items = Array.isArray(data.Items) ? data.Items : [];
      let withNotes = 0;
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const nt = it.Notes === undefined || it.Notes === null ? '' : String(it.Notes).trim();
        if (nt) withNotes++;
      }
      def.rowCount = items.length;
      def.notesRate = items.length ? Math.round((withNotes / items.length) * 100) : 0;
    }
    return map;
  }

  function rowNames(name) {
    const base = baseName(name);
    const m = notes.get(base);
    return m ? new Set(Object.keys(m)) : new Set();
  }

  const hasRow = (target, raw) => {
    const base = baseName(target);
    const m = notes.get(base);
    return !!m && Object.prototype.hasOwnProperty.call(m, raw);
  };

  const labelOf = (target, raw) => {
    const base = baseName(target);
    const m = notes.get(base);
    if (!m || !Object.prototype.hasOwnProperty.call(m, raw)) return null;
    const n = m[raw];
    return n && String(n).trim() ? n : raw;
  };

  /* ---------- 行属性筛选（与原型同一套语义） ---------- */
  function toNumLike(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return isFinite(n) ? n : null; }
    return null;
  }
  function arrElems(raw) {
    return raw.map((e) => (e !== null && typeof e === 'object' ? JSON.stringify(e) : String(e)).toLowerCase());
  }
  function matchRowField(row, f) {
    const raw = row ? row[f.field] : undefined;
    const isArr = Array.isArray(raw);
    const empty = raw === undefined || raw === null || raw === '' || (isArr && raw.length === 0);
    if (f.op === 'empty') return empty;
    if (f.op === 'notempty') return !empty;
    if (empty) return false;
    const w = String(f.val === undefined || f.val === null ? '' : f.val).toLowerCase();
    if (isArr) {
      const elems = arrElems(raw);
      if (f.op === 'contains') return elems.some((e) => e.includes(w));
      if (f.op === '=') return elems.some((e) => e === w);
      if (f.op === '!=') return !elems.some((e) => e === w);
      return false;
    }
    const isStruct = typeof raw === 'object';
    const s = (isStruct ? JSON.stringify(raw) : String(raw)).toLowerCase();
    if (f.op === 'contains') return s.includes(w);
    if (!isStruct) {
      const a = toNumLike(raw), b = toNumLike(f.val);
      if (a !== null && b !== null) {
        if (f.op === '=') return a === b;
        if (f.op === '!=') return a !== b;
        if (f.op === '>') return a > b;
        if (f.op === '>=') return a >= b;
        if (f.op === '<') return a < b;
        if (f.op === '<=') return a <= b;
      }
    }
    if (f.op === '=') return s === w;
    if (f.op === '!=') return s !== w;
    return false;
  }

  async function page(name, opts) {
    const o = opts || {};
    const base = baseName(name);
    touch(base);
    const t = await open(base);
    let items = t.data.Items || [];
    const filters = Array.isArray(o.filters) ? o.filters : [];
    if (filters.length) items = items.filter((it) => filters.every((f) => matchRowField(it, f)));
    const q = String(o.q || '').toLowerCase();
    if (q) items = items.filter((it) => JSON.stringify(it).toLowerCase().includes(q));
    const offset = o.offset || 0;
    const limit = Math.min(o.limit || 100, 500);
    return { total: items.length, offset: offset, limit: limit, filters: filters.length, rows: items.slice(offset, offset + limit) };
  }

  async function fill(name) {
    const base = baseName(name);
    if (fills.has(base)) return fills.get(base);
    touch(base);
    const t = await open(base);
    const items = (t.data.Items || []).filter(Boolean);
    const def = (SEM.tables || {})[base];
    const out = {};
    if (def && Array.isArray(def.fields)) {
      const n = items.length;
      for (const f of def.fields) {
        let filled = 0, same = 0;
        for (const it of items) {
          const v = it[f.name];
          const blank = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
          if (!blank) filled++;
          if (v !== undefined && v === it.RowName) same++;
        }
        out[f.name] = { fill: n ? filled / n : 0, filled: filled, sameAsRowName: n > 0 && same === n };
      }
    }
    const res = { ok: true, table: base, total: items.length, fields: out };
    fills.set(base, res);
    return res;
  }

  function search(q) {
    const w = String(q || '').toLowerCase();
    if (!w) return [];
    const hits = [];
    for (const name of Object.keys(SEM.tables)) {
      const m = notes.get(name);
      if (!m) continue;
      for (const row of Object.keys(m)) {
        const nt = m[row] || '';
        if (row.toLowerCase().includes(w) || String(nt).toLowerCase().includes(w)) hits.push({ table: name, row: row, notes: nt });
        if (hits.length >= 300) return hits;
      }
    }
    return hits;
  }

  function refs(target, q) {
    const base = baseName(target);
    const m = notes.get(base) || {};
    const w = String(q || '').toLowerCase();
    let rows = Object.keys(m).map((r) => ({ row: r, notes: m[r] }));
    if (w) rows = rows.filter((x) => x.row.toLowerCase().includes(w) || String(x.notes || '').toLowerCase().includes(w));
    return { target: base, total: rows.length, rows: rows.slice(0, 500) };
  }

  /* ---------- 本地编辑：区间替换 + 校验 + diff ---------- */
  function applyOpsText(text0, ops) {
    const JE = window.JSONEDIT;
    let text = text0;
    const touched = [];
    for (const op of ops) {
      if (op.type === 'set') { text = JE.setRowFields(text, op.row, op.patch); touched.push(op.row); }
    }
    const paths = ops.filter((o) => o.type === 'setpath');
    if (paths.length) {
      const res = JE.setManyPaths(text, paths.map((o) => ({ row: o.row, path: o.path, value: o.value })));
      if (res.missing.length) {
        const head = res.missing.slice(0, 5).map((m) => m.row + ' → ' + m.path.join('.') + '（' + m.reason + '）').join('；');
        throw new Error('有 ' + res.missing.length + ' 处路径不存在：' + head + (res.missing.length > 5 ? ' …' : ''));
      }
      text = res.text;
      for (const o of paths) touched.push(o.row);
    }
    for (const op of ops) {
      if (op.type === 'delete') { text = JE.deleteRow(text, op.row); touched.push(op.row); }
    }
    for (const op of ops) {
      if (op.type === 'append') { text = JE.appendRow(text, op.value); touched.push(op.value && op.value.RowName); }
    }
    return { text, touched };
  }

  function validate(name, text) {
    const errors = [], warnings = [];
    let obj;
    try { obj = JSON.parse(stripBom(text)); } catch (e) { return { errors: ['JSON 非法：' + e.message], warnings: [] }; }
    if (!Array.isArray(obj.Items)) return { errors: ['缺少 Items 数组'], warnings: [] };
    const seen = new Set();
    for (const it of obj.Items) {
      if (!it || typeof it !== 'object') { errors.push('存在非对象行'); continue; }
      const rn = it.RowName;
      if (!rn) { errors.push('存在没有 RowName 的行'); continue; }
      if (seen.has(rn)) errors.push('RowName 重复：' + rn);
      seen.add(rn);
    }
    const def = SEM.tables[baseName(name)];
    if (def) {
      const fieldMap = new Set(def.fields.map((f) => f.name));
      const unknown = new Map();
      for (const it of obj.Items) {
        if (!it) continue;
        for (const k of Object.keys(it)) {
          if (!fieldMap.has(k)) unknown.set(k, (unknown.get(k) || 0) + 1);
        }
      }
      for (const [k, cnt] of unknown) {
        warnings.push('字段「' + k + '」不在 schema 定义中（出现 ' + cnt + ' 次）' + (k !== k.trim() ? '，注意首尾空格' : ''));
      }
      for (const f of def.fields) {
        if (f.kind !== 'ref' || !f.target) continue;
        const known = rowNames(f.target);
        let miss = 0; const samples = [];
        for (const it of obj.Items) {
          if (!it) continue;
          const v = it[f.name];
          if (typeof v !== 'string' || !v) continue;
          if (!known.has(v)) { miss++; if (samples.length < 3) samples.push(v); }
        }
        if (miss) warnings.push(f.name + ' 有 ' + miss + ' 个值找不到目标行（' + f.target + '）：' + samples.join(', '));
      }
    }
    return { errors, warnings };
  }

  async function textOf(name) {
    const base = baseName(name);
    if (files.has(base)) return files.get(base).text;
    return await readText(base);
  }

  async function preview(name, ops) {
    const base = baseName(name);
    const before = await textOf(base);
    let after;
    try { after = applyOpsText(before, ops).text; } catch (e) { return { ok: false, error: '编辑失败：' + e.message, errors: [e.message], warnings: [], diff: [], sizeBefore: byteLen(before), sizeAfter: byteLen(before) }; }
    const check = validate(base, after);
    const d = window.JSONDIFF.diffLines(before, after);
    return {
      ok: check.errors.length === 0,
      table: base, opCount: ops.length,
      errors: check.errors, warnings: check.warnings,
      sizeBefore: byteLen(before), sizeAfter: byteLen(after),
      // 注意：edit.js 的 showDiffDialog 直接读 data.diff.hunks / hunkCount 等，必须是完整对象而非 hunks 数组
      diff: d,
    };
  }

  async function apply(name, ops) {
    const base = baseName(name);
    const before = await textOf(base);
    const after = applyOpsText(before, ops).text;
    const check = validate(base, after);
    if (check.errors.length) throw new Error('校验未通过：' + check.errors.join('；'));
    const res = await fetch('/api/save?name=' + encodeURIComponent(fileName(base)), { method: 'POST', body: after });
    const r = await res.json();
    if (!res.ok || !r.ok) throw new Error((r && r.error) || '写入失败');
    files.delete(base); notes.delete(base); fills.delete(base); allCache.delete(base);
    try { notes.set(base, indexOf(JSON.parse(stripBom(after)))); } catch (e) { }
    return { ok: true, table: base, backup: r.backup, opCount: ops.length, warnings: check.warnings };
  }

  async function ping() {
    try { return await fetch('/api/ping').then((x) => x.json()); } catch { return null; }
  }

  async function backups() { return await fetch('/api/backups').then((x) => x.json()); }
  async function undo(id) {
    const res = await fetch('/api/undo?id=' + encodeURIComponent(id), { method: 'POST' });
    const r = await res.json();
    if (!res.ok || !r.ok) throw new Error((r && r.error) || '还原失败');
    files.delete(r.table); notes.delete(r.table); fills.delete(r.table); allCache.delete(r.table);
    return r;
  }

  /* ---------- 列编辑：按路径模式展开成二维网格 ---------- */
  function matchCond(item, cond) {
    if (!item || typeof item !== 'object') return false;
    for (const k of Object.keys(cond)) if (item[k] !== cond[k]) return false;
    return true;
  }

  function collectPath(obj, pattern, prefix, out, when, depth) {
    if (!pattern.length) return;
    const head = pattern[0];
    const rest = pattern.slice(1);
    if (head === '*') {
      if (!Array.isArray(obj)) return;
      const cond = when && when[depth];
      for (let i = 0; i < obj.length; i++) {
        const item = obj[i];
        if (cond && !matchCond(item, cond)) continue;
        const p = prefix.concat([i]);
        if (!rest.length) out.push({ path: p, value: item });
        else collectPath(item, rest, p, out, when, depth + 1);
      }
      return;
    }
    if (!obj || typeof obj !== 'object') return;
    if (!(head in obj)) return;
    const v = obj[head];
    const p = prefix.concat([head]);
    if (!rest.length) out.push({ path: p, value: v });
    else collectPath(v, rest, p, out, when, depth + 1);
  }

  async function column(name, pattern, when, expand) {
    const base = baseName(name);
    touch(base);
    const t = await open(base);
    const notesMap = await ensureNotes(base);
    const actName = when ? Object.values(when).map((c) => c && c.Name).find(Boolean) : null;
    const actMeta = actName ? (SEM.actuators[actName] || null) : null;
    const starPositions = [];
    pattern.forEach((x, i) => { if (x === '*') starPositions.push(i); });
    const whenDepth = when ? Number(Object.keys(when)[0]) : -1;
    const isActObj = (v) => v && typeof v === 'object' && !Array.isArray(v) &&
      typeof v.Name === 'string' && v.JsonInput && typeof v.JsonInput === 'object' && !Array.isArray(v.JsonInput);
    let paramOrder = expand && actMeta && actMeta.params ? Object.keys(actMeta.params) : [];
    const HIDE_KINDS = ['objectarray', 'array', 'poly', 'object', 'actuators'];
    const semTable = (SEM.tables || {})[base];
    const rowFields = (semTable ? semTable.fields : [])
      .filter((f) => f.name !== 'RowName' && !HIDE_KINDS.includes(f.kind))
      .map((f) => ({ name: f.name, kind: f.kind, desc: f.desc || '' }));
    const colMap = new Map();
    const rows = [];
    let missing = 0;
    for (const it of t.data.Items || []) {
      if (!it) continue;
      const found = [];
      collectPath(it, pattern, [], found, when, 0);
      if (!found.length) missing++;
      const seq = new Map();
      const cells = [];
      for (const f of found) {
        let col;
        if (when && whenDepth >= 0) {
          const outer = starPositions.filter((p) => p !== whenDepth).map((p) => f.path[p]);
          const key = JSON.stringify(outer);
          const n = seq.get(key) || 0;
          seq.set(key, n + 1);
          col = starPositions.map((p) => (p === whenDepth ? n : f.path[p]));
        } else {
          col = starPositions.map((p) => f.path[p]);
        }
        if (expand && isActObj(f.value)) {
          for (const k of Object.keys(f.value.JsonInput)) {
            const pv = f.value.JsonInput[k];
            if (!paramOrder.includes(k)) paramOrder.push(k);
            const c = col.concat([k]);
            colMap.set(JSON.stringify(c), c);
            cells.push({ col: c, path: f.path.concat(['JsonInput', k]), value: pv });
          }
        } else {
          colMap.set(JSON.stringify(col), col);
          cells.push({ col: col, path: f.path, value: f.value });
        }
      }
      const scalars = {};
      for (const f of rowFields) if (it[f.name] !== undefined) scalars[f.name] = it[f.name];
      rows.push({ row: it.RowName, notes: notesMap[it.RowName] || '', cells: cells, scalars: scalars });
    }
    const paramIdx = (k) => { const i = paramOrder.indexOf(k); return i < 0 ? 999 : i; };
    const cmp = (a, b) => {
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const x = a[i], y = b[i];
        if (x === y) continue;
        if (typeof x === 'number' && typeof y === 'number') return x - y;
        if (typeof x === 'string' && typeof y === 'string') return paramIdx(x) - paramIdx(y) || (x < y ? -1 : 1);
        return typeof x === 'number' ? -1 : 1;
      }
      return a.length - b.length;
    };
    const cols = [...colMap.values()].sort(cmp);
    return {
      ok: true, table: base, pattern: pattern, when: when, starPositions: starPositions,
      cols: cols, rows: rows, total: rows.length, missing: missing,
      expand: !!expand, paramOrder: paramOrder, rowFields: rowFields,
      actuator: actName ? { name: actName, desc: actMeta ? actMeta.desc : '', params: actMeta ? actMeta.params : {} } : null,
    };
  }
  /* ---------- 反向引用：谁引用了某张表的某一行 ----------
     用于「删除本行」前提示。语义层只给了正向关系（字段 → 目标表），
     这里把它翻成 targetTable → [{table, field}] 与 targetTable → [{act, param}]，
     然后扫全库。执行器参数也是引用（22k 次调用），不能漏。 */
  let REF_MAP = null;
  function refMap() {
    if (REF_MAP) return REF_MAP;
    const m = new Map();
    const get = (t) => { if (!m.has(t)) m.set(t, { fields: [], acts: [] }); return m.get(t); };
    for (const [tn, def] of Object.entries(SEM.tables || {})) {
      for (const f of def.fields || []) {
        if (f.kind === 'ref' && f.target) get(baseName(f.target)).fields.push({ table: tn, field: f.name });
      }
    }
    for (const [an, a] of Object.entries(SEM.actuators || {})) {
      for (const [pn, p] of Object.entries(a.params || {})) {
        if (p && p.target) get(baseName(p.target)).acts.push({ act: an, param: pn });
      }
    }
    REF_MAP = m;
    return m;
  }

  async function loadAll() {
    const todo = Object.keys(SEM.tables || {}).filter((n) => !allCache.has(n));
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const n = todo[i++];
        try {
          const data = JSON.parse(stripBom(await readText(n)));
          allCache.set(n, Array.isArray(data.Items) ? data.Items : []);
        } catch (e) { allCache.set(n, []); }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  }

  async function findRefsTo(targetTable, targetRow) {
    const base = baseName(targetTable);
    await loadAll();
    const idx = refMap().get(base) || { fields: [], acts: [] };
    if (!idx.fields.length && !idx.acts.length) return [];

    const fieldByTable = new Map();
    for (const f of idx.fields) {
      if (!fieldByTable.has(f.table)) fieldByTable.set(f.table, new Set());
      fieldByTable.get(f.table).add(f.field);
    }
    const actParams = new Map();
    for (const a of idx.acts) {
      if (!actParams.has(a.act)) actParams.set(a.act, new Set());
      actParams.get(a.act).add(a.param);
    }

    const want = String(targetRow);
    const seen = new Set();
    const hits = [];
    const push = (table, row, field, act) => {
      const k = table + '\u0000' + row + '\u0000' + field + '\u0000' + (act || '');
      if (seen.has(k)) return;
      seen.add(k);
      hits.push({ table: table, row: row, field: field, act: act || null });
    };

    const walk = (node, tableName, rowName) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (let k = 0; k < node.length; k++) walk(node[k], tableName, rowName); return; }
      /* 执行器：{ Name, JsonInput }，参数含义由执行器定义决定 */
      if (typeof node.Name === 'string' && node.JsonInput && typeof node.JsonInput === 'object' && !Array.isArray(node.JsonInput)) {
        const params = actParams.get(node.Name);
        if (params) {
          for (const k of Object.keys(node.JsonInput)) {
            if (params.has(k) && String(node.JsonInput[k]) === want) push(tableName, rowName, k, node.Name);
          }
        }
        walk(node.JsonInput, tableName, rowName);
        return;
      }
      const fs = fieldByTable.get(tableName);
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (typeof v === 'string' && fs && fs.has(k) && v === want) push(tableName, rowName, k, null);
        else if (v && typeof v === 'object') walk(v, tableName, rowName);
      }
    };

    for (const [tn, items] of allCache) {
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const rn = String(it.RowName == null ? '' : it.RowName);
        walk(it, tn, rn);
      }
    }
    /* 自己引用自己不算：删掉这行之后这个引用也不存在了 */
    return hits.filter((h) => !(h.table === base && h.row === want));
  }

  return {
    init, open, page, fill, search, refs, preview, apply, backups, undo, column, ping,
    findRefsTo: findRefsTo, loadAll: loadAll,
    notes: ensureNotes, rowNames, hasRow, labelOf, textOf, matchRowField,
    get sem() { return SEM; },
    get files() { return fileList; },
    get stale() { return staleTables; },
  };
})();
