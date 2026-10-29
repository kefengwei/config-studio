/* 对拍：只用 json-schemas + configs 重建语义层，与 dist/assets/semantics.json 逐字段比较
 * 目的：验证「运行时直接从 schema 解析」的覆盖率，找出真正缺失的信息。
 * 用法：node scripts/verify-sem-from-schema.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

function findRepo() {
  const cands = [];
  try {
    const t = fs.readFileSync(path.join(HERE, '..', 'config-dir.txt'), 'utf8').trim();
    if (t) cands.push(t);
  } catch {}
  if (process.env.DR_CONFIG_REPO) cands.push(process.env.DR_CONFIG_REPO);
  let d = path.resolve(HERE, '..');
  for (let i = 0; i < 8; i++) {
    cands.push(d);
    d = path.dirname(d);
  }
  for (const c of cands) {
    try {
      const hit = fs.readdirSync(path.join(c, 'configs')).some((f) => /^Config_.*\.json$/.test(f));
      if (hit) return c;
    } catch {}
  }
  return null;
}

const ROOT = findRepo();
if (!ROOT) { console.error('找不到配置仓库'); process.exit(1); }
const CONFIG_DIR = path.join(ROOT, 'configs');
const SCHEMA_DIR = process.env.VERIFY_SCHEMA_DIR ? path.resolve(process.env.VERIFY_SCHEMA_DIR) : path.join(ROOT, 'json-schemas');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const isBase = (f) => f.replace(/\.json$/, '').indexOf('.') === -1;

/* ---------- 加载 ---------- */
const schemas = {};
for (const f of fs.readdirSync(SCHEMA_DIR).filter((x) => x.endsWith('.json'))) {
  try { schemas[f.replace(/\.json$/, '')] = readJson(path.join(SCHEMA_DIR, f)); } catch (e) { console.error('schema 解析失败', f, e.message); }
}
const configs = {};
for (const f of fs.readdirSync(CONFIG_DIR).filter((x) => x.endsWith('.json'))) {
  try { configs[f.replace(/\.json$/, '')] = readJson(path.join(CONFIG_DIR, f)); } catch (e) { console.error('配置解析失败', f, e.message); }
}
const baseTables = Object.keys(configs).filter(isBase);

const increments = {};
for (const k of Object.keys(configs)) {
  if (isBase(k)) continue;
  const [table, channel] = k.split('.');
  (increments[table] ||= {})[channel] = (configs[k].Items || []).length;
}

const rowIndex = {};
for (const t of baseTables) {
  rowIndex[t] = new Set();
  for (const it of configs[t].Items || []) if (it && typeof it.RowName === 'string') rowIndex[t].add(it.RowName);
}

/* ---------- 1. 引用推断（纯数据，schema 里没有） ---------- */
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
  const guess = 'Config_' + field.replace(/RowName$/, '');
  let reason = 'data';
  if (schemas[guess]) { reason = 'naming'; if (!best || best.rate < 1) best = { target: guess, rate: best ? best.rate : 0, hit: best ? best.hit : 0 }; }
  refTargets[field] = {
    target: best && best.rate > 0.5 ? best.target : guess,
    confidence: best ? +best.rate.toFixed(3) : 0,
    hits: best ? best.hit : 0,
    total: vals.length,
    reason,
  };
}

const SKIP_IMPLICIT = new Set(['Name','Type','Desc','Description','Notes','Title','Icon','Path','Key','Value','Comment','Text','Url','Color','Sound','Effect','Prefab','Anim','Bundle','Address','Group','Category','Tag','RowName','Id','Ids','Channel','DataType']);
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
    refTargets[field] = { target: best.target, confidence: +best.rate.toFixed(3), hits: best.hit, total: vals.length, reason: 'implicit' };
  }
}

/* ---------- 2. 枚举：只用 schema（英文标签） ---------- */
const enumBySchemaDef = {};
for (const [tname, sc] of Object.entries(schemas)) {
  for (const [dn, dv] of Object.entries(sc.definitions || {})) {
    if (!dv || !Array.isArray(dv.enum)) continue;
    const names = dv['x-enumNames'] || [];
    const descs = dv['enumDescriptions'] || {};
    const map = {};
    dv.enum.forEach((v, i) => { map[String(v)] = descs[String(v)] || names[i] || String(v); });
    enumBySchemaDef[dn] = map;
  }
}

/* ---------- 3. 执行器目录：schema oneOf ---------- */
const POLY_BASES = new Set(['ActuatorInstanceData', 'ProgressTrackerInstanceData', 'StatisticDefineInstanceData', 'ExtraActionDefineInstanceData']);
const actuators = {};
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

/* ---------- 3b. 执行器参数 → 目标表（数据驱动，schema 无约束） ---------- */
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
    if (meta.params[pn] && meta.params[pn].target) continue;
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

/* ---------- 4. 字段分类 ---------- */
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
    if (target && target.enum) return { kind: 'enum', enum: ref, values: enumBySchemaDef[ref] || null, desc: p.description || target.description || '' };
    if (target && target.oneOf) return { kind: 'poly', def: ref, desc: p.description || '' };
    return { kind: 'object', def: ref, desc: p.description || '' };
  }
  if (p.oneOf) {
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
  const def = sc && sc.definitions && sc.definitions[t];
  const items = configs[t].Items || [];
  const notesFilled = items.filter((i) => i && typeof i.Notes === 'string' && i.Notes.trim()).length;
  const fields = [];
  if (def && def.properties) {
    for (const [name, p] of Object.entries(def.properties)) {
      const c = classify(p, sc.definitions);
      if (name !== 'RowName' && refTargets[name]) {
        fields.push({ name, kind: 'ref', target: refTargets[name].target, confidence: refTargets[name].confidence, hits: refTargets[name].hits, total: refTargets[name].total, implicit: refTargets[name].reason === 'implicit', desc: p.description || '' });
        continue;
      }
      if (UNIT_HINTS[name] && c.kind === 'number') { c.unit = UNIT_HINTS[name].unit; c.note = UNIT_HINTS[name].note; }
      fields.push({ name, ...c });
    }
  }
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

const rebuilt = { tables, actuators, enums: enumBySchemaDef, refTargets };

/* ---------- 5. 对拍 ---------- */
const OLD = readJson(path.join(HERE, '..', 'dist', 'assets', 'semantics.json'));
const report = [];
function head(t) { report.push(''); report.push('## ' + t); }
function line(s) { report.push(s); }

head('规模');
line('  旧: tables=' + Object.keys(OLD.tables).length + ' fields=' + Object.values(OLD.tables).reduce((n, t) => n + t.fields.length, 0) + ' actuators=' + Object.keys(OLD.actuators).length + ' enums=' + Object.keys(OLD.enums).length + ' refTargets=' + Object.keys(OLD.refTargets).length);
line('  新: tables=' + Object.keys(tables).length + ' fields=' + Object.values(tables).reduce((n, t) => n + t.fields.length, 0) + ' actuators=' + Object.keys(actuators).length + ' enums=' + Object.keys(enumBySchemaDef).length + ' refTargets=' + Object.keys(refTargets).length);

function diffSet(label, a, b, samples) {
  const A = new Set(a), B = new Set(b);
  const onlyA = [...A].filter((x) => !B.has(x));
  const onlyB = [...B].filter((x) => !A.has(x));
  line('  ' + label + ': 旧缺 ' + onlyA.length + ' / 新缺 ' + onlyB.length + (onlyA.length ? ' | 旧有: ' + onlyA.slice(0, 4).join(',') : '') + (onlyB.length ? ' | 新有: ' + onlyB.slice(0, 4).join(',') : ''));
  return { onlyA, onlyB };
}

head('表集合');
diffSet('tables', Object.keys(OLD.tables), Object.keys(tables));

head('字段');
let fTotal = 0, fSame = 0;
const fieldDiff = {};
for (const t of Object.keys(OLD.tables)) {
  if (!tables[t]) continue;
  const om = new Map(OLD.tables[t].fields.map((f) => [f.name, f]));
  const nm = new Map(tables[t].fields.map((f) => [f.name, f]));
  for (const [n, of] of om) {
    const nf = nm.get(n);
    if (!nf) { (fieldDiff.missing ||= []).push(t + '.' + n); continue; }
    fTotal++;
    const keys = ['kind', 'desc', 'format', 'def', 'unit', 'note', 'target', 'implicit', 'confidence', 'hits', 'total'];
    let bad = null;
    for (const k of keys) {
      const a = of[k], b = nf[k];
      if (JSON.stringify(a) !== JSON.stringify(b)) { bad = k + ': ' + JSON.stringify(a) + ' -> ' + JSON.stringify(b); break; }
    }
    if (bad) (fieldDiff[bad.split(':')[0]] ||= []).push(t + '.' + n + ' (' + bad + ')');
    else fSame++;
  }
  for (const [n] of nm) if (!om.has(n)) (fieldDiff.extraField ||= []).push(t + '.' + n);
}
line('  字段总数 ' + fTotal + '，完全一致 ' + fSame + '，差异 ' + (fTotal - fSame) + '（' + (100 * fSame / fTotal).toFixed(2) + '%）');
for (const [k, v] of Object.entries(fieldDiff)) line('    ' + k + ': ' + v.length + '｜例 ' + v.slice(0, 3).join(' ; '));

head('执行器');
diffSet('actuators', Object.keys(OLD.actuators), Object.keys(actuators));
let aTotal = 0, aSame = 0;
const actDiff = {};
for (const [n, oa] of Object.entries(OLD.actuators)) {
  const na = actuators[n];
  if (!na) continue;
  for (const k of ['base', 'desc']) {
    aTotal++;
    if (oa[k] === na[k]) aSame++; else (actDiff[k] ||= []).push(n + ': ' + JSON.stringify(oa[k]) + ' -> ' + JSON.stringify(na[k]));
  }
  const op = oa.params || {}, np = na.params || {};
  for (const pn of Object.keys(op)) {
    aTotal++;
    const x = op[pn], y = np[pn];
    if (!y) { (actDiff.missingParam ||= []).push(n + '.' + pn); continue; }
    const keys = ['type', 'desc', 'target'];
    let bad = null;
    for (const k of keys) if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) { bad = k + ':' + JSON.stringify(x[k]) + '->' + JSON.stringify(y[k]); break; }
    if (bad) (actDiff['param.' + bad.split(':')[0]] ||= []).push(n + '.' + pn + ' ' + bad);
    else aSame++;
  }
  for (const pn of Object.keys(np)) if (!op[pn]) (actDiff.extraParam ||= []).push(n + '.' + pn);
}
line('  比对项 ' + aTotal + '，一致 ' + aSame + '（' + (100 * aSame / aTotal).toFixed(2) + '%）');
for (const [k, v] of Object.entries(actDiff)) line('    ' + k + ': ' + v.length + '｜例 ' + v.slice(0, 3).join(' ; '));

head('枚举');
diffSet('enumNames', Object.keys(OLD.enums), Object.keys(enumBySchemaDef));
let eTotal = 0, eSame = 0, eChinese = 0, eOldChinese = 0;
for (const [n, oe] of Object.entries(OLD.enums)) {
  const ne = enumBySchemaDef[n];
  if (!ne) continue;
  for (const v of Object.keys(oe)) {
    eTotal++;
    if (/[\u4e00-\u9fa5]/.test(oe[v])) eOldChinese++;
    if (oe[v] === ne[v]) eSame++;
    if (/[\u4e00-\u9fa5]/.test(ne[v])) eChinese++;
  }
}
line('  枚举值 ' + eTotal + '，标签一致 ' + eSame + '（旧中文标签 ' + eOldChinese + ' 个，新解析出中文 ' + eChinese + ' 个）');
const sampleEnum = Object.entries(OLD.enums).find(([, m]) => Object.values(m).some((x) => /[\u4e00-\u9fa5]/.test(x)));
if (sampleEnum) line('  例 ' + sampleEnum[0] + ': 旧=' + JSON.stringify(sampleEnum[1]).slice(0, 120) + ' 新=' + JSON.stringify(enumBySchemaDef[sampleEnum[0]]).slice(0, 120));

head('引用目标');
let rTotal = 0, rSame = 0;
const rDiff = [];
for (const [k, ov] of Object.entries(OLD.refTargets)) {
  const nv = refTargets[k];
  rTotal++;
  if (!nv) { rDiff.push(k + ' 新缺失'); continue; }
  const keys = ['target', 'confidence', 'hits', 'total', 'reason'];
  let bad = null;
  for (const kk of keys) if (JSON.stringify(ov[kk]) !== JSON.stringify(nv[kk])) { bad = kk + ':' + JSON.stringify(ov[kk]) + '->' + JSON.stringify(nv[kk]); break; }
  if (bad) rDiff.push(k + ' ' + bad); else rSame++;
}
line('  旧 refTargets ' + rTotal + ' 个，一致 ' + rSame + '，差异 ' + rDiff.length);
for (const x of rDiff.slice(0, 6)) line('    ' + x);

head('表级元数据（rowCount / notesRate / increments / extraKeys / hasSchema）');
let tTotal = 0, tSame = 0;
const tDiff = [];
for (const [t, ot] of Object.entries(OLD.tables)) {
  const nt = tables[t];
  if (!nt) continue;
  tTotal++;
  let bad = null;
  for (const k of ['rowCount', 'notesRate', 'hasSchema']) if (JSON.stringify(ot[k]) !== JSON.stringify(nt[k])) { bad = k + ':' + JSON.stringify(ot[k]) + '->' + JSON.stringify(nt[k]); break; }
  if (!bad && JSON.stringify(ot.increments) !== JSON.stringify(nt.increments)) bad = 'increments:' + JSON.stringify(ot.increments) + '->' + JSON.stringify(nt.increments);
  if (!bad && JSON.stringify((ot.extraKeys || []).sort()) !== JSON.stringify((nt.extraKeys || []).sort())) bad = 'extraKeys:' + JSON.stringify(ot.extraKeys) + '->' + JSON.stringify(nt.extraKeys);
  if (bad) tDiff.push(t + ' ' + bad); else tSame++;
}
line('  表 ' + tTotal + '，完全一致 ' + tSame + '，差异 ' + tDiff.length);
for (const x of tDiff.slice(0, 6)) line('    ' + x);

console.log(report.join('\n'));
console.log('\n' + '='.repeat(60));
console.log('SUMMARY ' + JSON.stringify({
  tables: { old: Object.keys(OLD.tables).length, new: Object.keys(tables).length },
  fields: { total: fTotal, same: fSame, pct: +(100 * fSame / fTotal).toFixed(2) },
  actuators: { total: aTotal, same: aSame, pct: +(100 * aSame / aTotal).toFixed(2) },
  enums: { total: eTotal, same: eSame, oldChinese: eOldChinese, newChinese: eChinese },
  refTargets: { total: rTotal, same: rSame },
  tableMeta: { total: tTotal, same: tSame, diff: tDiff.length },
}));
