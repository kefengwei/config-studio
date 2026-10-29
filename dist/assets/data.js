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
  let semMode = 'builtin';   // 'schema' = 运行时从 json-schemas 现算；'builtin' = 内嵌 semantics.json
  let schemasRaw = null;
  let fileList = [];
  let staleTables = { added: [], removed: [] };
  let aggScan = false;       // 只在 init 扫描那 6 路并发里聚合数据，之后不再重复遍历
  /* 数据聚合：schema 模式的语义层要靠它推断引用目标与表元数据。
     一次递归同时收四样东西，避免对 7.6k 行扫四遍。 */
  const agg = { rowIndex: {}, refValues: {}, strValues: {}, paramValues: {}, tableMeta: {}, increments: {} };
  const REF_SUFFIX = /RowName$/;
  const SKIP_IMPLICIT = new Set(['Name', 'Type', 'Desc', 'Description', 'Notes', 'Title', 'Icon', 'Path', 'Key', 'Value', 'Comment', 'Text', 'Url', 'Color', 'Sound', 'Effect', 'Prefab', 'Anim', 'Bundle', 'Address', 'Group', 'Category', 'Tag', 'RowName', 'Id', 'Ids', 'Channel', 'DataType']);
  let missingTables = [];   // 磁盘上没有对应文件的表（切到配置更少的分支时会出现）
  let current = null;
  const MAX_OPEN = 4;

  /* Tauri 桌面版走进程内命令（window.__TAURI__.core.invoke）；
     浏览器里继续走 启动.bat 起的 PowerShell HTTP 服务。两条路的接口一一对应。 */
  const isTauri = typeof window !== 'undefined' && !!(window.__TAURI__ && window.__TAURI__.core);
  const invoke = isTauri ? (cmd, args) => window.__TAURI__.core.invoke(cmd, args) : null;

  async function listTables() {
    if (invoke) {
      try { return { tables: await invoke('list_tables') }; }
      catch (e) { throw new Error('读取配置目录失败：' + e); }
    }
    return await fetch('/api/tables').then((x) => x.json());
  }

  /* 配置仓库的 json-schemas/ 一次性读全：桌面版由 Rust 拼成一个 JSON 对象，
     浏览器版走 /api/schemas。一个文件一个请求太慢（94 个文件）。 */
  async function readSchemasText() {
    if (invoke) return await invoke('read_schemas');
    const res = await fetch('/api/schemas');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  }

  const fileName = (n) => (/\.json$/.test(n) ? n : n + '.json');
  const baseName = (n) => n.replace(/\.json$/, '');
  const stripBom = (s) => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);
  const byteLen = (s) => new TextEncoder().encode(s).length;

  /* 数据聚合（仅 schema 模式需要）：一遍递归同时收
       rowIndex    —— 每张表的 RowName 集合，用来算引用命中率
       refValues   —— 每个 *RowName 字段里出现过的值
       strValues   —— 其它字符串字段的值（隐式引用靠它）
       paramValues —— 执行器 {Name,JsonInput} 里每个参数的取值
       tableMeta   —— 行数 / 填了 Notes 的行数 / 出现过的键
     内嵌模式的语义层是构建期写死的，用不上这些，所以只在 init 扫描期打开。 */
  function aggregateItems(items, base) {
    const idx = agg.rowIndex[base] || (agg.rowIndex[base] = new Set());
    const meta = agg.tableMeta[base] || (agg.tableMeta[base] = { count: 0, notesFilled: 0, keys: null });
    const keys = new Set();
    let withNotes = 0;
    const walk = (v) => {
      if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) walk(v[i]); return; }
      if (!v || typeof v !== 'object') return;
      /* 执行器节点：参数名要看定义才知道是不是引用，先按名字全部收下 */
      if (typeof v.Name === 'string' && v.JsonInput && typeof v.JsonInput === 'object' && !Array.isArray(v.JsonInput)) {
        const m = agg.paramValues[v.Name] || (agg.paramValues[v.Name] = {});
        for (const [k, pv] of Object.entries(v.JsonInput)) {
          if (typeof pv !== 'string' || !pv) continue;
          (m[k] || (m[k] = new Set())).add(pv);
        }
      }
      for (const [k, val] of Object.entries(v)) {
        if (typeof val === 'string' && val) {
          if (k !== 'RowName' && REF_SUFFIX.test(k)) (agg.refValues[k] || (agg.refValues[k] = new Set())).add(val);
          else if (!REF_SUFFIX.test(k) && !SKIP_IMPLICIT.has(k)) (agg.strValues[k] || (agg.strValues[k] = new Set())).add(val);
        }
        walk(val);
      }
    };
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      if (it.RowName !== undefined && it.RowName !== null) idx.add(String(it.RowName));
      if (it.Notes !== undefined && it.Notes !== null && String(it.Notes).trim()) withNotes++;
      for (const k of Object.keys(it)) keys.add(k);
      walk(it);
    }
    meta.count = items.length;
    meta.notesFilled = withNotes;
    meta.keys = keys;
  }

  async function init(onProgress) {
    const list = await listTables();
    fileList = list.tables || [];
    const onDisk = new Set();
    for (const f of fileList) {
      const n = baseName(f.name);
      if (n.indexOf('.') === -1) onDisk.add(n);   // 只要基表，Config_X.<channel>.json 是增量
    }

    /* 语义层来源：优先从配置仓库的 json-schemas/ 现算（后端改字段只需重导 schema 并提交），
       老仓库没有 json-schemas/ 时回落到构建期产物 assets/semantics.json。 */
    let schemas = null;
    try {
      const txt = await readSchemasText();
      const parsed = JSON.parse(stripBom(txt));
      if (parsed && Object.keys(parsed).length) schemas = parsed;
    } catch (e) {
      console.warn('[语义层] 读 json-schemas 失败，改用内嵌语义层：', e);
    }

    let names;
    if (schemas) {
      semMode = 'schema';
      schemasRaw = schemas;
      aggScan = true;
      names = [...onDisk].filter((n) => schemas[n]).sort();
      const noSchema = [...onDisk].filter((n) => !schemas[n]).sort();
      const noFile = Object.keys(schemas).filter((n) => !onDisk.has(n)).sort();
      staleTables = { added: noSchema, removed: noFile };
      /* 先放一个空骨架：扫描期间 setNotes 会往里写行数/注释率，缺 table 时它会自己跳过 */
      SEM = { tables: {}, enums: {}, refTargets: {}, actuators: {}, stats: {}, generatedAt: null, source: { mode: 'schema' } };
    } else {
      semMode = 'builtin';
      SEM = await fetch('assets/semantics.json').then((x) => x.json());
      names = Object.keys(SEM.tables);
      /* 语义层只在构建时生成，所以"新增/删除配置文件"它不会自己跟上。
         这里只做零误报的检测：目录里有但语义层没有的表、语义层有但文件没了的表。
         （工作台自己写文件只会改 mtime，不会触发这个提示） */
      const semSet = new Set(names);
      staleTables = {
        added: [...onDisk].filter((n) => !semSet.has(n)).sort(),
        removed: [...semSet].filter((n) => !onDisk.has(n)).sort(),
      };
    }

    let done = 0;
    const missing = [];
    const queue = names.slice();
    const worker = async () => {
      while (queue.length) {
        const n = queue.shift();
        try { await ensureNotes(n); } catch (e) { missing.push(n); }
        done++;
        if (onProgress && done % 8 === 0) onProgress(done, names.length);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
    aggScan = false;
    missingTables = missing.sort();
    if (missingTables.length) console.warn('[缺表] 磁盘上没有对应文件的表：', missingTables);

    if (semMode === 'schema') {
      SEM = window.SFS.build({ schemas: schemasRaw, baseTables: names, agg: agg });
      if (staleTables.added.length) console.warn('[无 schema] 这些配置表没有对应的 json-schemas 定义（后端没导出？）：', staleTables.added);
    }
    if (onProgress) onProgress(names.length, names.length);
    return SEM;
  }

  async function readText(name) {
    const fn = fileName(name);
    if (invoke) {
      try { return await invoke('read_file', { name: fn }); }
      catch (e) { throw new Error('读取失败：' + name + '（' + e + '）'); }
    }
    const res = await fetch('/api/file?name=' + encodeURIComponent(fn));
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

  /* 把一份 RowName->Notes 索引登记为当前真相，同时刷新侧栏用的行数/注释率。
     语义层是构建期快照，行数与注释率会随配置改动过期；这里每次拿到新索引都回写。 */
  function setNotes(base, map) {
    notes.set(base, map);
    const def = SEM && SEM.tables ? SEM.tables[base] : null;
    if (!def) return map;
    const keys = Object.keys(map);
    let withNotes = 0;
    for (const k of keys) {
      const v = map[k];
      if (v !== undefined && v !== null && String(v).trim()) withNotes++;
    }
    def.rowCount = keys.length;
    def.notesRate = keys.length ? Math.round((withNotes / keys.length) * 100) : 0;
    return map;
  }

  async function ensureNotes(name) {
    const base = baseName(name);
    /* 命中缓存也回写一次统计：apply() 刚改过的那张表缓存是新的，
       但语义层里的 rowCount/notesRate 可能还停在构建期的旧值。 */
    if (notes.has(base)) return setNotes(base, notes.get(base));
    let data;
    if (files.has(base)) data = files.get(base).data;
    else data = JSON.parse(stripBom(await readText(base)));
    if (aggScan) {
      try { aggregateItems(Array.isArray(data.Items) ? data.Items : [], base); } catch (e) { }
    }
    return setNotes(base, indexOf(data));
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
    // 一次扫描处理所有 set：列编辑可能一次改几千格，逐个扫描会让 2.7MB 的表变成分钟级
    const sets = ops.filter((o) => o.type === 'set');
    if (sets.length) {
      text = JE.setManyRows(text, sets.map((o) => ({ row: o.row, patch: o.patch })));
      for (const o of sets) touched.push(o.row);
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
    /* 保存前重新读一次磁盘：文件可能被 git pull / 切分支 / 别人改过。
       拿打开时的旧全文做区间替换，会把那些改动整段覆盖掉 —— 先比对，不一致就拒绝写盘。 */
    const disk = await readText(base);
    const cached = files.has(base) ? files.get(base).text : null;
    if (cached !== null && cached !== disk) {
      files.delete(base); notes.delete(base); fills.delete(base); allCache.delete(base);
      const err = new Error('磁盘上的 ' + base + '.json 已经变了（git pull / 切分支 / 别人改过）。' +
        '为避免覆盖掉这些改动，本次没有写入。请重新打开这张表再改一次。');
      err.conflict = true;
      throw err;
    }
    const before = disk;
    const after = applyOpsText(before, ops).text;
    const check = validate(base, after);
    if (check.errors.length) throw new Error('校验未通过：' + check.errors.join('；'));
    let r;
    if (invoke) {
      try { r = { ok: true, backup: (await invoke('save_file', { name: fileName(base), contents: after })).backup }; }
      catch (e) { throw new Error('写入失败：' + e); }
    } else {
      const res = await fetch('/api/save?name=' + encodeURIComponent(fileName(base)), { method: 'POST', body: after });
      r = await res.json();
      if (!res.ok || !r.ok) throw new Error((r && r.error) || '写入失败');
    }
    files.delete(base); notes.delete(base); fills.delete(base); allCache.delete(base);
    try { setNotes(base, indexOf(JSON.parse(stripBom(after)))); } catch (e) { }
    return { ok: true, table: base, backup: r.backup, opCount: ops.length, warnings: check.warnings };
  }

  async function ping() {
    if (invoke) {
      try { return { ok: true, ...(await invoke('ping')) }; } catch { return null; }
    }
    try { return await fetch('/api/ping').then((x) => x.json()); } catch { return null; }
  }

  async function backups() {
    if (invoke) return { ok: true, backups: await invoke('list_backups') };
    return await fetch('/api/backups').then((x) => x.json());
  }
  async function undo(id) {
    let r;
    if (invoke) {
      try { r = await invoke('undo', { id }); } catch (e) { throw new Error('还原失败：' + e); }
    } else {
      const res = await fetch('/api/undo?id=' + encodeURIComponent(id), { method: 'POST' });
      r = await res.json();
      if (!res.ok || !r.ok) throw new Error((r && r.error) || '还原失败');
    }
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
    get semMode() { return semMode; },
    get files() { return fileList; },
    get stale() { return staleTables; },
    get missing() { return missingTables; },
  };
})();
