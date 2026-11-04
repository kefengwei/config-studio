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
  let schemaStampAt = null;   // init 时 json-schemas 的 [文件数, 最新 mtime]
  /* 磁盘上变了、但还没被重新读取的表。一直留着，直到 invalidate() 把它们清掉 ——
     否则「别的表变了」的提示只出现一次，用户忘了按 R 就再也看不到了。 */
  const dirtyTables = new Set();
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

  /* json-schemas 目录的指纹：[文件数, 最新修改时间]。
     语义层只在 init 时算一次，靠它判断后端有没有重新导出过 schema。 */
  async function schemaStamp() {
    if (invoke) {
      try { return await invoke('schema_stamp'); } catch (e) { return null; }
    }
    try {
      const r = await fetch('/api/schema-stamp').then((x) => x.json());
      return [r.count, r.max];
    } catch (e) { return null; }
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
      schemaStampAt = await schemaStamp();
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
    /* 磁盘上变过的表不许用内存里的旧副本：切过去就是最新的 */
    if (dirtyTables.has(base)) invalidate(base);
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
    /* 淘汰最久没用的那张，但永远保留 current。
       原写法 `files.delete(first); files.set(first, files.get(first))` 在 delete 之后才 get，
       取到的是 undefined —— 当前表一旦成为最久未用，缓存里就留下一个 undefined 条目，
       下一次 open() 命中它直接返回 undefined，上层 `t.data` 就炸了。 */
    while (files.size > MAX_OPEN) {
      let victim = null;
      for (const k of files.keys()) { if (k !== current) { victim = k; break; } }
      if (!victim) break;          // 只剩当前表，没有可淘汰的
      files.delete(victim);
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
    if (dirtyTables.has(base)) invalidate(base);
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

  /* 丢掉一张表在内存里的全部副本，让下一次读取真的落到磁盘上。
     R 键（重新加载当前表）走这里；外部改了文件、git pull 之后手动刷新也走这里。 */
  function invalidate(name) {
    const base = baseName(name);
    files.delete(base);
    notes.delete(base);
    fills.delete(base);
    allCache.delete(base);
    dirtyTables.delete(base);   // 这张表已经重新读过，不该再被提示
    return base;
  }

  /* 磁盘上变了、还没被重新读的表（给状态栏提示用） */
  function diskDirty() { return [...dirtyTables]; }

  /* 磁盘上的配置文件有没有变：拿 listTables 的 mtime/size 跟 init 时的快照比。
     只做元数据比对、不读文件内容，95 张表也就一次目录遍历。
     Config_X.<渠道>.json 这种增量文件不算「表」，只统计基表。 */
  async function checkDisk() {
    const list = await listTables();
    const now = list.tables || [];
    const prev = new Map(fileList.map((f) => [f.name, f]));
    const next = new Map(now.map((f) => [f.name, f]));
    const isBase = (n) => baseName(n).indexOf('.') === -1;
    const changed = [];
    for (const [name, f] of next) {
      const p = prev.get(name);
      if (!p || !isBase(name)) continue;
      if (p.mtime !== f.mtime || p.size !== f.size) {
        changed.push(baseName(name));
        dirtyTables.add(baseName(name));
      }
    }
    const added = [...next.keys()].filter((n) => !prev.has(n) && isBase(n)).map(baseName);
    const removed = [...prev.keys()].filter((n) => !next.has(n) && isBase(n)).map(baseName);
    added.forEach((n) => dirtyTables.add(n));
    removed.forEach((n) => dirtyTables.add(n));
    fileList = now;
    invalidateChannels();   // 渠道文件可能整套变了（切分支 / git pull）
    /* pending 是累积的「还没重新读过的表」；本次新增的放 changed/added/removed。
       调用方按 pending 提示，才不会因为快照已更新而丢掉提醒。 */
    return { changed, added, removed, pending: [...dirtyTables] };
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
    let ops = null, stats = null;
    if (o.channel) {
      const p = await patchOf(o.channel, base);
      const merged = mergeItems(items, p.data.Items || []);
      stats = merged.stats;
      ops = new Map();
      for (const x of merged.items) {
        if (x.op) ops.set(String(x.item && x.item.RowName), x.op);
      }
      items = merged.items.map((x) => x.item);
    }
    if (filters0(o).length) items = items.filter((it) => filters0(o).every((f) => matchRowField(it, f)));
    const q = String(o.q || '').toLowerCase();
    if (q) items = items.filter((it) => JSON.stringify(it).toLowerCase().includes(q));
    const offset = o.offset || 0;
    const limit = Math.min(o.limit || 100, 500);
    return { total: items.length, offset: offset, limit: limit, filters: filters0(o).length, rows: items.slice(offset, offset + limit), ops: ops, stats: stats };
  }

  function filters0(o) { return Array.isArray(o.filters) ? o.filters : []; }

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
      invalidate(base);
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
    invalidate(base);
    /* 自己刚写完的文件不该被下次 focus 当成「外部改动」：顺手刷新一次快照 */
    try { fileList = (await listTables()).tables || fileList; } catch (e) { }
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
    invalidate(r.table);
    try { fileList = (await listTables()).tables || fileList; } catch (e) { }
    return r;
  }

  /* ---------- 渠道覆盖（Config_<表>.<渠道>.json） ----------
     服务端语义（DoriDori.Backend.Admin/Services/ConfigCacheService.cs:516 ApplyConfigPatchItems）：
       Add     基础表没有这个 RowName 才追加；已存在则报错跳过
       Replace 整行替换（不是字段级 merge），并去掉 Operation 字段
       Delete  按 RowName 删除整行
       缺 Operation 整行跳过；同一文件里 RowName 重复时这些行全被忽略
     行名比较用 OrdinalIgnoreCase。 */
  const CH_RE = /^Config_([A-Za-z]+)[.](.+)[.]json$/;
  let channelList = null;             // [{ name, files: [{ table, file }] }]
  const patches = new Map();          // channel/table -> { text, data, missing }

  function scanChannels() {
    const byName = new Map();
    for (const f of fileList) {
      const m = CH_RE.exec(f.name);
      if (!m) continue;
      const ch = m[2], table = m[1];
      if (!byName.has(ch)) byName.set(ch, []);
      byName.get(ch).push({ table: table, file: f.name });
    }
    const out = [];
    for (const pair of byName) {
      out.push({ name: pair[0], files: pair[1].sort((a, b) => (a.table < b.table ? -1 : 1)) });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  async function listChannels() {
    if (channelList) return channelList;
    channelList = scanChannels();
    return channelList;
  }

  /* 渠道文件清单/内容都要作废：git pull 或新建渠道文件之后调 */
  function invalidateChannels() {
    channelList = null;
    patches.clear();
  }

  /* table 参数两种写法都收："Config_Task" 或 "Task"（scanChannels 里存的是后者） */
  const normTable = (t) => (String(t).indexOf('Config_') === 0 ? String(t) : 'Config_' + t);
  const patchName = (channel, table) => normTable(table) + '.' + channel + '.json';

  async function patchOf(channel, table) {
    const key = channel + '/' + normTable(table);
    if (patches.has(key)) {
      const hit = patches.get(key);
      patches.delete(key); patches.set(key, hit);   // LRU 触达
      return hit;
    }
    let entry;
    try {
      const text = await readText(patchName(channel, table));
      entry = { text: text, data: JSON.parse(stripBom(text)), missing: false };
    } catch (e) {
      entry = { text: null, data: { Items: [] }, missing: true };   // 这个渠道还没覆盖过这张表
    }
    patches.set(key, entry);
    while (patches.size > 40) patches.delete(patches.keys().next().value);
    return entry;
  }

  function stripOp(it) {
    if (!it || typeof it !== 'object') return it;
    if (it.Operation === undefined) return it;
    const copy = Object.assign({}, it);
    delete copy.Operation;
    return copy;
  }

  /* 基础行 + 补丁行 → 生效内容。op: null | replace | add | delete；delete 行带 ghost=真 */
  function mergeItems(baseItems, patchItems) {
    const byName = new Map();
    const dup = new Set();
    for (const it of patchItems || []) {
      if (!it || typeof it !== 'object') continue;
      const rn = it.RowName == null ? '' : String(it.RowName);
      if (!rn) continue;
      const k = rn.toLowerCase();
      if (byName.has(k)) { dup.add(k); continue; }
      byName.set(k, it);
    }
    for (const k of dup) byName.delete(k);
    const stats = { replace: 0, add: 0, del: 0, noOp: 0, dup: dup.size, conflict: 0, miss: 0 };
    const items = [];
    const used = new Set();
    for (const it of baseItems || []) {
      if (!it || typeof it !== 'object') { items.push({ item: it, op: null }); continue; }
      const k = String(it.RowName == null ? '' : it.RowName).toLowerCase();
      const p = byName.get(k);
      if (!p) { items.push({ item: it, op: null }); continue; }
      used.add(k);
      const op = String(p.Operation || '').trim();
      if (op === 'Replace') { stats.replace++; items.push({ item: stripOp(p), op: 'replace' }); }
      else if (op === 'Delete') { stats.del++; items.push({ item: it, op: 'delete', ghost: true }); }
      else if (op === 'Add') { stats.conflict++; items.push({ item: it, op: 'conflict' }); }
      else { stats.noOp++; items.push({ item: it, op: 'noop' }); }
    }
    for (const pair of byName) {
      const k = pair[0], p = pair[1];
      if (used.has(k)) continue;
      const op = String(p.Operation || '').trim();
      if (op === 'Add') { stats.add++; items.push({ item: stripOp(p), op: 'add' }); }
      else stats.miss++;
    }
    return { items: items, stats: stats, dupNames: dup };
  }

  /* 每个渠道里各张表有多少条补丁、按 Operation 分布。侧栏角标用，不读基础表，只读补丁文件 */
  async function channelSummary(channel) {
    const out = {};
    const chans = await listChannels();
    const c = chans.find((x) => x.name === channel);
    if (!c) return out;
    for (const f of c.files) {
      const t = normTable(f.table);
      const p = await patchOf(channel, t);
      const s = { replace: 0, del: 0, add: 0, noOp: 0, other: 0, total: 0 };
      for (const it of p.data.Items || []) {
        if (!it || typeof it !== "object") continue;
        s.total++;
        const op = String(it.Operation || "").trim();
        if (op === "Replace") s.replace++;
        else if (op === "Delete") s.del++;
        else if (op === "Add") s.add++;
        else if (!op) s.noOp++;
        else s.other++;
      }
      out[t] = s;
    }
    return out;
  }

  /* 渠道合并后按 RowName 反查补丁行（渠道视图/右栏对比用） */
  async function patchMap(channel, table) {
    const p = await patchOf(channel, table);
    const m = new Map();
    for (const it of p.data.Items || []) {
      if (!it || typeof it !== 'object' || !it.RowName) continue;
      m.set(String(it.RowName).toLowerCase(), it);
    }
    return { map: m, entry: p };
  }

  /* ---------------- 渠道覆盖文件：写盘 ----------------
     渠道文件不存在时自动新建（第一次提覆盖就是新建）。
     Replace 是「整行替换」，所以补丁行必须带完整字段，不能只写改动的那个。 */
  async function saveChannel(channel, table, items) {
    const tbl = normTable(table);
    const fn = patchName(channel, tbl);
    const key = channel + '/' + tbl;
    const doc = { $schema: '../json-schemas/' + tbl + '.json', ConfigName: tbl, Items: items || [] };
    const after = JSON.stringify(doc, null, 2);
    /* 冲突检测：打开之后补丁文件可能被 git pull / 切分支改过 */
    const cached = patches.has(key) ? patches.get(key).text : null;
    let disk = null;
    try { disk = await readText(fn); } catch (e) { disk = null; }
    if (cached !== null && cached !== disk) {
      patches.delete(key);
      const err = new Error('磁盘上的 ' + fn + ' 已经变了（git pull / 切分支 / 别人改过）。为避免覆盖，本次没有写入。');
      err.conflict = true;
      throw err;
    }
    let r;
    if (invoke) {
      try { r = { ok: true, backup: (await invoke('save_file', { name: fn, contents: after })).backup }; }
      catch (e) { throw new Error('写入失败：' + e); }
    } else {
      const res = await fetch('/api/save?name=' + encodeURIComponent(fn), { method: 'POST', body: after });
      r = await res.json();
      if (!res.ok || !r.ok) throw new Error((r && r.error) || '写入失败');
    }
    patches.delete(key);
    channelList = null;
    try { fileList = (await listTables()).tables || fileList; } catch (e) { }
    return { ok: true, file: fn, created: disk === null, backup: r.backup, rows: (items || []).length };
  }

  /* 把基础表的一整行提成某渠道的覆盖行（已覆盖则原位替换）。返回写入结果 */
  async function promoteRow(channel, table, row, op) {
    const p = await patchOf(channel, table);
    const items = (p.data.Items || []).filter((x) => x && typeof x === 'object').slice();
    const rn = String((row && row.RowName) || '');
    if (!rn) throw new Error('这行没有 RowName');
    const patch = { Operation: op === 'add' ? 'Add' : 'Replace' };
    for (const k of Object.keys(row)) if (k !== 'Operation') patch[k] = row[k];
    const lc = rn.toLowerCase();
    const i = items.findIndex((x) => String(x.RowName || '').toLowerCase() === lc);
    const existed = i >= 0;
    if (existed) items[i] = patch; else items.push(patch);
    const r = await saveChannel(channel, table, items);
    return Object.assign(r, { replaced: existed, rowName: rn });
  }

  /* 渠道体检：把 14 个覆盖文件里所有「不会生效」或「指向不存在目标」的行找出来。
     判据与服务端 ConfigCacheService 一致：缺 Operation 整行跳过、Replace/Delete 找不到目标、
     Add 撞基础表、同一文件里 RowName 重复则全部忽略。 */
  async function checkAllChannels() {
    const chans = await listChannels();
    const out = [];
    const baseCache = new Map();
    const rowSetOf = async (table) => {
      const base = normTable(table);
      if (!baseCache.has(base)) {
        let set = new Set();
        try {
          const d = await open(base);
          set = new Set((d.data.Items || []).map((x) => String((x && x.RowName) || '').toLowerCase()));
        } catch (e) { /* 表不存在时按空集处理 */ }
        baseCache.set(base, set);
      }
      return baseCache.get(base);
    };
    for (const ch of chans) {
      for (const t of ch.files) {
        const p = await patchOf(ch.name, t.table);
        const items = p.data.Items || [];
        const rows = await rowSetOf(t.table);
        const seen = new Map();
        for (const it of items) {
          const lc = String((it && it.RowName) || '').toLowerCase();
          seen.set(lc, (seen.get(lc) || 0) + 1);
        }
        for (const it of items) {
          const rn = String((it && it.RowName) || '');
          const lc = rn.toLowerCase();
          const op = String((it && it.Operation) || '').toLowerCase();
          const hit = rows.has(lc);
          let issue = null;
          if (!op) issue = 'noOp';
          else if (op !== 'add' && op !== 'replace' && op !== 'delete') issue = 'badOp';
          else if ((seen.get(lc) || 0) > 1) issue = 'dup';
          else if (op === 'replace' && !hit) issue = 'miss';
          else if (op === 'delete' && !hit) issue = 'miss';
          else if (op === 'add' && hit) issue = 'conflict';
          if (issue) out.push({ channel: ch.name, table: normTable(t.table), rowName: rn, op: op || '', issue: issue });
        }
      }
    }
    const order = { noOp: 0, badOp: 1, dup: 2, miss: 3, conflict: 4 };
    out.sort((a, b) => (order[a.issue] - order[b.issue]) || a.channel.localeCompare(b.channel) || a.rowName.localeCompare(b.rowName));
    return out;
  }

  /* 从渠道补丁里去掉这一行：覆盖过的回到基础表内容，被删掉的重新出现 */
  async function removePatchRow(channel, table, rowName) {
    const p = await patchOf(channel, table);
    const lc = String(rowName || '').toLowerCase();
    const items = (p.data.Items || []).filter((x) => String((x && x.RowName) || '').toLowerCase() !== lc);
    if (items.length === (p.data.Items || []).length) return { ok: false, reason: '补丁里没有这一行' };
    const r = await saveChannel(channel, table, items);
    return Object.assign(r, { removed: true, rowName: rowName });
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
    init, open, page, fill, search, refs, preview, apply, backups, undo, column, ping, invalidate, checkDisk, diskDirty, schemaStamp,
    listChannels, patchOf, patchMap, channelSummary, patchName, mergeItems, saveChannel, promoteRow, removePatchRow, checkAllChannels, channelText: (c, t) => patchOf(c, t).then((x) => x.text), invalidateChannels,
    findRefsTo: findRefsTo, loadAll: loadAll,
    notes: ensureNotes, rowNames, hasRow, labelOf, textOf, matchRowField,
    get sem() { return SEM; },
    get semMode() { return semMode; },
    get files() { return fileList; },
    get schemaStampAt() { return schemaStampAt; },
    get stale() { return staleTables; },
    get missing() { return missingTables; },
  };
})();
