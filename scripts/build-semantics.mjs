/**
 * 生成 semantics.json —— 配置语义层（一次性构建，产物入库）
 * 输入：配置仓库的 configs/*.json、json-schemas/*.json，以及 C# 枚举源码
 * 输出：dist/assets/semantics.json
 *
 * 配置仓库的位置按这个顺序找：
 *   1. 环境变量 DR_CONFIG_REPO
 *   2. 项目根或 dist/ 下的 config-dir.txt（一行，写配置仓库根目录或它的 configs 目录）
 *   3. 从项目根向上最多 6 级，找第一个含 configs/Config_*.json 的目录
 */
import fs from 'node:fs';
import path from 'node:path';

const PROJECT = path.resolve(import.meta.dirname, '..');

function hasConfigs(dir) {
  try {
    return fs.readdirSync(path.join(dir, 'configs')).some((f) => /^Config_.+\.json$/.test(f));
  } catch {
    return false;
  }
}

function readConfigDirFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0].trim();
    if (!raw) return null;
    const p = path.resolve(PROJECT, raw);
    if (hasConfigs(p)) return p;
    if (path.basename(p).toLowerCase() === 'configs' && hasConfigs(path.dirname(p))) return path.dirname(p);
    return null;
  } catch {
    return null;
  }
}

function findConfigRepo() {
  const env = process.env.DR_CONFIG_REPO;
  if (env && hasConfigs(env)) return path.resolve(env);
  for (const f of [path.join(PROJECT, 'config-dir.txt'), path.join(PROJECT, 'dist', 'config-dir.txt')]) {
    const hit = readConfigDirFile(f);
    if (hit) return hit;
  }
  let d = PROJECT;
  for (let i = 0; i < 6; i++) {
    if (hasConfigs(d)) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

const ROOT = findConfigRepo();
if (!ROOT) {
  console.error([
    '找不到配置仓库（含 configs/Config_*.json 的目录）。两种解决方式：',
    '  1. 在项目根创建 config-dir.txt，写一行配置仓库路径，例如：',
    '     G:/Github/dr_config_repo',
    '  2. 设置环境变量 DR_CONFIG_REPO，构建前临时指定。',
  ].join('\n'));
  process.exit(1);
}

const CONFIG_DIR = path.join(ROOT, 'configs');
const SCHEMA_DIR = path.join(ROOT, 'json-schemas');
const CS_DIR = process.env.DR_CS_DIR || 'G:/Github/DoriDori.Backend/src/DoriDori.Backend.Config';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const isBase = (f) => f.replace(/\.json$/, '').indexOf('.') === -1;

/* ---------- 1. C# 枚举 → 中文标签 ---------- */
function parseMembers(body) {
  const members = [];
  let desc = null;
  let summary = [];
  let auto = 0;
  for (const raw of body.split(/\r?\n/)) {
    let line = raw.trim();
    if (line.startsWith('///')) {
      const t = line.replace(/^\/\/\/\s?/, '').replace(/<\/?summary>/g, '').trim();
      if (t) summary.push(t);
      continue;
    }
    if (!line || line.startsWith('//')) continue;
    // 同一行可能既带 attribute 又带成员声明：[Description("与")] And = 0,
    let guard = 0;
    while (line.startsWith('[') && guard++ < 6) {
      let depth = 0;
      let stop = -1;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '[') depth++;
        else if (line[i] === ']') { if (--depth === 0) { stop = i; break; } }
      }
      if (stop < 0) break;
      const dm = line.slice(0, stop + 1).match(/Description\(\s*"([^"]*)"\s*\)/);
      if (dm) desc = dm[1];
      line = line.slice(stop + 1).trim();
    }
    const mm = line.match(/^([A-Za-z_]\w*)\s*(?:=\s*(-?\d+))?\s*,?\s*$/);
    if (!mm) continue;
    const v = mm[2] !== undefined ? +mm[2] : auto;
    auto = v + 1;
    let label = desc || summary[0] || mm[1];
    if (label.length > 32) label = label.slice(0, 32) + '…';
    members.push({ v, name: mm[1], label });
    desc = null;
    summary = [];
  }
  return members;
}


function parseEnums() {
  const dir = path.join(CS_DIR, 'Enums');
  const enums = {};
  if (!fs.existsSync(dir)) return enums;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.cs'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const re = /enum\s+([A-Za-z_]\w*)\s*(?::\s*[\w.]+)?\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
      let depth = 1;
      let i = re.lastIndex;
      const start = i;
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
      }
      const members = parseMembers(src.slice(start, i - 1));
      if (members.length) enums[m[1]] = { members, file: f, hasChinese: members.some((x) => /[\u4e00-\u9fa5]/.test(x.label)) };
    }
  }
  return enums;
}

/* ---------- 2. 加载 schema / 数据 ---------- */
const schemaFiles = fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.json'));
const schemas = {};
for (const f of schemaFiles) {
  const key = f.replace(/\.json$/, '');
  try { schemas[key] = readJson(path.join(SCHEMA_DIR, f)); } catch (e) { console.error('schema 解析失败', f, e.message); }
}

const configFiles = fs.readdirSync(CONFIG_DIR).filter((f) => f.endsWith('.json'));
const configs = {};
for (const f of configFiles) {
  try { configs[f.replace(/\.json$/, '')] = readJson(path.join(CONFIG_DIR, f)); } catch (e) { console.error('配置解析失败', f, e.message); }
}

const baseTables = Object.keys(configs).filter(isBase);
const increments = {};
for (const k of Object.keys(configs)) {
  if (isBase(k)) continue;
  const [table, channel] = k.split('.');
  (increments[table] ||= {})[channel] = (configs[k].Items || []).length;
}

// RowName 索引
const rowIndex = {};
for (const t of baseTables) {
  rowIndex[t] = new Map();
  for (const item of configs[t].Items || []) {
    if (item && typeof item.RowName === 'string') rowIndex[t].set(item.RowName, item);
  }
}

/* ---------- 3. 引用字段收集 + 数据驱动推断目标表 ---------- */
function walkRefs(o, cb) {
  if (Array.isArray(o)) return o.forEach((x) => walkRefs(x, cb));
  if (!o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    if (/RowName$/.test(k) && k !== 'RowName' && typeof v === 'string' && v) cb(k, v);
    walkRefs(v, cb);
  }
}

const refValues = {};
for (const t of baseTables) walkRefs(configs[t].Items || [], (k, v) => (refValues[k] ||= new Set()).add(v));

// description 里的目标提示，如 "灵宠行名称(Config_SpiritPet.RowName)"
function hintTarget(desc) {
  if (!desc) return null;
  const m = desc.match(/Config_([A-Za-z0-9_]+)\.RowName/) || desc.match(/Config_([A-Za-z0-9_]+)\s*中/);
  if (!m) return null;
  const t = 'Config_' + m[1];
  return schemas[t] ? t : null;
}

const refTargets = {};
for (const [field, values] of Object.entries(refValues)) {
  const vals = [...values];
  let best = null;
  for (const t of baseTables) {
    const idx = rowIndex[t];
    if (!idx || !idx.size) continue;
    const hit = vals.reduce((n, v) => n + (idx.has(v) ? 1 : 0), 0);
    const rate = hit / vals.length;
    if (!best || rate > best.rate) best = { target: t, rate, hit };
  }
  // 命名规则候选
  const guess = 'Config_' + field.replace(/RowName$/, '');
  let reason = 'data';
  if (schemas[guess]) { reason = 'naming'; if (!best || best.rate < 1) best = { target: guess, rate: best ? best.rate : 0, hit: best ? best.hit : 0 }; }
  refTargets[field] = {
    target: best && best.rate > 0.5 ? best.target : guess,
    confidence: best ? +best.rate.toFixed(3) : 0,
    hits: best ? best.hit : 0,
    total: vals.length,
    reason,
    sample: vals.slice(0, 5),
  };
}

/* ---------- 3b. 隐式引用：非 *RowName 后缀，但数据高命中某张表 ---------- */
const SKIP_IMPLICIT = new Set(['Name', 'Type', 'Desc', 'Description', 'Notes', 'Title', 'Icon', 'Path', 'Key', 'Value', 'Comment', 'Text', 'Url', 'Color', 'Sound', 'Effect', 'Prefab', 'Anim', 'Bundle', 'Address', 'Group', 'Category', 'Tag', 'RowName', 'Id', 'Ids', 'Channel', 'DataType']);
function walkStrings(o, cb) {
  if (Array.isArray(o)) return o.forEach((x) => walkStrings(x, cb));
  if (!o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && v && !SKIP_IMPLICIT.has(k) && !/RowName$/.test(k)) cb(k, v);
    walkStrings(v, cb);
  }
}
const strValues = {};
for (const t of baseTables) walkStrings(configs[t].Items || [], (k, v) => (strValues[k] ||= new Set()).add(v));

for (const [field, set] of Object.entries(strValues)) {
  if (refTargets[field]) continue;
  if (set.size < 5 || set.size > 3000) continue;
  const vals = [...set];
  let best = null;
  for (const t of baseTables) {
    const idx = rowIndex[t];
    if (!idx || !idx.size) continue;
    const hit = vals.reduce((n, v) => n + (idx.has(v) ? 1 : 0), 0);
    const rate = hit / vals.length;
    if (!best || rate > best.rate || (rate === best.rate && hit > best.hit)) best = { target: t, rate, hit };
  }
  if (best && best.rate >= 0.95) {
    refTargets[field] = { target: best.target, confidence: +best.rate.toFixed(3), hits: best.hit, total: vals.length, reason: 'implicit', sample: vals.slice(0, 5) };
  }
}

/* ---------- 4. 枚举映射（schema $ref → 中文成员） ---------- */
const enumBySchemaDef = {};
for (const [name, e] of Object.entries(parseEnums())) {
  enumBySchemaDef[name] = Object.fromEntries(e.members.map((m) => [String(m.v), m.label]));
}

/* ---------- 5. 执行器目录（遍历所有 schema 的 oneOf 分支） ---------- */
/* schema 里「Name 是 const + 有 JsonInput」的多态容器有四个，必须按容器区分：
   - ActuatorInstanceData      = 真正的执行器（发放物品、加属性…），共 52 个
   - ProgressTrackerInstanceData = 进度追踪器分支（Statistic / ArenaRank / TimeControlTurn…）
   - StatisticDefineInstanceData = 统计定义分支（StatisticDefineGiftPackBuy…，104 个）
   - ExtraActionDefineInstanceData = 额外行为定义分支（ExtraActionDefine_BattleFailed…）
   旧实现不分容器，把后三类也写进 actuators，导致执行器下拉里出现上百个统计定义名。
   现在每条都记 base（所属多态容器），前端只把 base = ActuatorInstanceData 的列进下拉；
   其余三类仍保留在目录里，因为详情/编辑卡片要靠它拿到 desc 与参数元数据。 */
const actuators = {};
const POLY_BASES = new Set([
  'ActuatorInstanceData',
  'ProgressTrackerInstanceData',
  'StatisticDefineInstanceData',
  'ExtraActionDefineInstanceData',
]);
function collectActuators(node, table, base) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((x) => collectActuators(x, table, base));
  const np = node.properties && node.properties.Name;
  if (np && np.const && node.properties.JsonInput) {
    const name = np.const;
    if (!actuators[name]) {
      const params = {};
      for (const [pn, pv] of Object.entries(node.properties.JsonInput.properties || {})) {
        params[pn] = { type: pv.type || 'any', desc: pv.description || '', target: hintTarget(pv.description) };
      }
      actuators[name] = { name, base: base || '', desc: np.description || '', params, definedIn: table };
    }
  }
  for (const v of Object.values(node)) collectActuators(v, table, base);
}
for (const [table, sc] of Object.entries(schemas)) {
  for (const [dn, dv] of Object.entries(sc.definitions || {})) {
    collectActuators(dv, table, POLY_BASES.has(dn) ? dn : '');
  }
}

/* ---------- 5b. 数据驱动：推断执行器参数 → 目标表 ---------- */
const paramValues = {};
(function walkAct(o) {
  if (Array.isArray(o)) return o.forEach(walkAct);
  if (!o || typeof o !== 'object') return;
  if (typeof o.Name === 'string' && o.JsonInput && typeof o.JsonInput === 'object') {
    for (const [k, v] of Object.entries(o.JsonInput)) {
      if (typeof v !== 'string' || !v) continue;
      ((paramValues[o.Name] ||= {})[k] ||= new Set()).add(v);
    }
  }
  for (const v of Object.values(o)) walkAct(v);
})(baseTables.map((t) => configs[t].Items || []));

for (const [actName, params] of Object.entries(paramValues)) {
  const meta = actuators[actName];
  if (!meta) continue;
  for (const [pn, set] of Object.entries(params)) {
    if (meta.params[pn]?.target) continue;
    if (!/RowName$/.test(pn) && set.size < 3) continue;
    const vals = [...set];
    if (vals.length < 3) continue;
    let best = null;
    for (const t of baseTables) {
      const idx = rowIndex[t];
      if (!idx || !idx.size) continue;
      const hit = vals.reduce((n, v) => n + (idx.has(v) ? 1 : 0), 0);
      const rate = hit / vals.length;
      if (!best || rate > best.rate) best = { target: t, rate, hit };
    }
    if (best && best.rate >= 0.8) {
      meta.params[pn] = { ...(meta.params[pn] || {}), target: best.target, confidence: +best.rate.toFixed(2), samples: vals.length };
    }
  }
}

/* ---------- 6. 字段语义分类 ---------- */
const UNIT_HINTS = {
  Count: { unit: '个', note: '负数=扣除' },
  Probability: { unit: '万分比', note: '10000 = 100%' },
  Weight: { unit: '权重', note: '相对权重,非百分比' },
  Order: { unit: '序号', note: '' },
  Grade: { unit: '阶', note: '' },
  Level: { unit: '级', note: '' },
  RecommendedCombatPower: { unit: '战力', note: '' },
  StandardCoinBase: { unit: '金币', note: '' },
  RequiredValue: { unit: '', note: '' },
  Value: { unit: '', note: '可为负' },
  Amount: { unit: '', note: '' },
};

function classify(p, defs) {
  if (!p) return { kind: 'any' };
  if (p['$ref']) {
    const ref = p['$ref'].split('/').pop();
    const target = defs[ref];
    if (target && target.enum) {
      return { kind: 'enum', enum: ref, values: enumBySchemaDef[ref] || null, desc: p.description || target.description || '' };
    }
    if (target && target.oneOf) return { kind: 'poly', def: ref, desc: p.description || '' };
    return { kind: 'object', def: ref, desc: p.description || '' };
  }
  if (p.oneOf) {
    /* 内联 oneOf 常常只是「外层包一层，里面一个 $ref」：
       Config_Task.ProgressTracker = { description:'进度追踪器', oneOf:[{$ref:'#/definitions/ProgressTrackerInstanceData'}] }
       若只记 variants 就丢掉容器名，前端无法把「进度追踪器」和「执行器」区分开。 */
    const refs = p.oneOf.map((x) => (x && x['$ref'] ? x['$ref'].split('/').pop() : null)).filter(Boolean);
    const polyDef = refs.find((r) => defs[r] && defs[r].oneOf) || undefined;
    return { kind: 'poly', ...(polyDef ? { def: polyDef } : {}), desc: p.description || '', variants: p.oneOf.length };
  }
  if (p.type === 'array') {
    const it = p.items || {};
    if (it['$ref']) {
      const ref = it['$ref'].split('/').pop();
      if (ref === 'ActuatorInstanceData') return { kind: 'actuators', desc: p.description || '' };
      if (enumBySchemaDef[ref]) return { kind: 'enumarray', enum: ref, desc: p.description || '' };
      return { kind: 'objectarray', def: ref, desc: p.description || '' };
    }
    return { kind: 'primarray', desc: p.description || '' };
  }
  if (p.type === 'integer' || p.type === 'number') return { kind: 'number', desc: p.description || '', format: p.format || null };
  if (p.type === 'boolean') return { kind: 'bool', desc: p.description || '' };
  if (p.type === 'string') {
    if (p.format === 'duration') return { kind: 'duration', desc: p.description || '' };
    if (p.format === 'date-time') return { kind: 'datetime', desc: p.description || '' };
    return { kind: 'text', desc: p.description || '', format: p.format || null };
  }
  if (Array.isArray(p.type)) return { kind: 'nullable', types: p.type, desc: p.description || '' };
  if (p.const) return { kind: 'const', value: p.const, desc: p.description || '' };
  return { kind: 'any', desc: p.description || '' };
}

const tables = {};
for (const t of baseTables) {
  const sc = schemas[t];
  const def = sc?.definitions?.[t];
  const items = configs[t].Items || [];
  const notesFilled = items.filter((i) => i && typeof i.Notes === 'string' && i.Notes.trim()).length;
  const fields = [];
  if (def?.properties) {
    for (const [name, p] of Object.entries(def.properties)) {
      const c = classify(p, sc.definitions);
      // 引用字段覆盖
      if (name !== 'RowName' && refTargets[name]) {
        fields.push({ name, kind: 'ref', target: refTargets[name].target, confidence: refTargets[name].confidence, hits: refTargets[name].hits, total: refTargets[name].total, implicit: refTargets[name].reason === 'implicit', desc: p.description || '' });
        continue;
      }
      if (UNIT_HINTS[name] && c.kind === 'number') { c.unit = UNIT_HINTS[name].unit; c.note = UNIT_HINTS[name].note; }
      fields.push({ name, ...c });
    }
  }
  // 数据里存在但 schema 没有的键（脏数据/计算字段）
  const extra = new Set();
  for (const it of items) if (it && typeof it === 'object') for (const k of Object.keys(it)) if (!fields.some((f) => f.name === k)) extra.add(k);
  tables[t] = {
    name: t,
    rowCount: items.length,
    notesFilled,
    notesRate: items.length ? +(notesFilled / items.length * 100).toFixed(0) : 0,
    fields,
    extraKeys: [...extra],
    increments: increments[t] || null,
    hasSchema: !!def,
  };
}

/* ---------- 7. 输出 ---------- */
const outDir = path.join(import.meta.dirname, '../dist/assets');
fs.mkdirSync(outDir, { recursive: true });
const semantics = {
  generatedAt: new Date().toISOString(),
  source: { configDir: 'configs', schemaDir: 'json-schemas', csharpDir: CS_DIR },
  stats: {
    tables: baseTables.length,
    rows: baseTables.reduce((n, t) => n + (configs[t].Items || []).length, 0),
    actuators: Object.values(actuators).filter((a) => a.base === 'ActuatorInstanceData').length,
    polyEntries: Object.values(actuators).filter((a) => a.base !== 'ActuatorInstanceData').length,
    refFields: Object.keys(refTargets).length,
    enums: Object.keys(enumBySchemaDef).length,
    enumsWithChinese: Object.values(enumBySchemaDef).filter((m) => Object.values(m).some((l) => /[\u4e00-\u9fa5]/.test(l))).length,
  },
  enums: enumBySchemaDef,
  refTargets,
  actuators,
  tables,
};
fs.writeFileSync(path.join(outDir, 'semantics.json'), JSON.stringify(semantics, null, 1));
console.log(JSON.stringify(semantics.stats, null, 2));
console.log('引用字段推断（置信度<1 的）:');
for (const [k, v] of Object.entries(refTargets)) if (v.confidence < 1) console.log(' ', k, '->', v.target, 'conf=' + v.confidence, '(' + v.hits + '/' + v.total + ')', 'reason=' + v.reason);
