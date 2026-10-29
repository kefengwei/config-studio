/* 对拍：用运行时那份实现（src/js/sem-from-schema.js 的 SFS.build）重建语义层，
 * 和 dist/assets/semantics.json 比。和 verify-sem-from-schema.mjs 的区别是：
 * 那个脚本是独立复刻规则，这个直接跑工作台真正会执行的那段代码。
 * 用法：node scripts/verify-runtime-sem.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

function findRepo() {
  const cands = [];
  try { const t = fs.readFileSync(path.join(HERE, '..', 'config-dir.txt'), 'utf8').trim(); if (t) cands.push(t); } catch {}
  if (process.env.DR_CONFIG_REPO) cands.push(process.env.DR_CONFIG_REPO);
  let d = path.resolve(HERE, '..');
  for (let i = 0; i < 8; i++) { cands.push(d); d = path.dirname(d); }
  for (const c of cands) {
    try { if (fs.readdirSync(path.join(c, 'configs')).some((f) => /^Config_.*\.json$/.test(f))) return c; } catch {}
  }
  return null;
}

const ROOT = findRepo();
if (!ROOT) { console.error('找不到配置仓库'); process.exit(1); }
const CONFIG_DIR = path.join(ROOT, 'configs');
const SCHEMA_DIR = path.join(ROOT, 'json-schemas');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const isBase = (f) => f.replace(/\.json$/, '').indexOf('.') === -1;

const t0 = Date.now();
const schemas = {};
for (const f of fs.readdirSync(SCHEMA_DIR).filter((x) => x.endsWith('.json'))) schemas[f.replace(/\.json$/, '')] = readJson(path.join(SCHEMA_DIR, f));
const configs = {};
for (const f of fs.readdirSync(CONFIG_DIR).filter((x) => x.endsWith('.json'))) configs[f.replace(/\.json$/, '')] = readJson(path.join(CONFIG_DIR, f));
const baseTables = Object.keys(configs).filter(isBase);

/* 与 src/js/data.js 的 aggregateItems 同一套逻辑 */
const agg = { rowIndex: {}, refValues: {}, strValues: {}, paramValues: {}, tableMeta: {}, increments: {} };
const REF_SUFFIX = /RowName$/;
const SKIP_IMPLICIT = new Set(['Name','Type','Desc','Description','Notes','Title','Icon','Path','Key','Value','Comment','Text','Url','Color','Sound','Effect','Prefab','Anim','Bundle','Address','Group','Category','Tag','RowName','Id','Ids','Channel','DataType']);
for (const k of Object.keys(configs)) {
  if (isBase(k)) continue;
  const [table, channel] = k.split('.');
  (agg.increments[table] ||= {})[channel] = (configs[k].Items || []).length;
}
for (const base of baseTables) {
  const items = configs[base].Items || [];
  const idx = agg.rowIndex[base] = new Set();
  const meta = agg.tableMeta[base] = { count: 0, notesFilled: 0, keys: new Set() };
  let withNotes = 0;
  const walk = (v) => {
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) walk(v[i]); return; }
    if (!v || typeof v !== 'object') return;
    if (typeof v.Name === 'string' && v.JsonInput && typeof v.JsonInput === 'object' && !Array.isArray(v.JsonInput)) {
      const m = agg.paramValues[v.Name] || (agg.paramValues[v.Name] = {});
      for (const [k, pv] of Object.entries(v.JsonInput)) { if (typeof pv === 'string' && pv) (m[k] || (m[k] = new Set())).add(pv); }
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
    for (const k of Object.keys(it)) meta.keys.add(k);
    walk(it);
  }
  meta.count = items.length;
  meta.notesFilled = withNotes;
}
const tLoad = Date.now() - t0;

/* 跑工作台真正用的那段代码 */
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(HERE, '..', 'src', 'js', 'sem-from-schema.js'), 'utf8'), sandbox);
const SFS = sandbox.window.SFS;
if (!SFS) { console.error('sem-from-schema.js 没有导出 window.SFS'); process.exit(1); }

const t1 = Date.now();
const SEM = SFS.build({ schemas, baseTables, agg });
const tBuild = Date.now() - t1;

const OLD = readJson(path.join(HERE, '..', 'dist', 'assets', 'semantics.json'));
const out = [];
const line = (s) => out.push(s);
line('加载 ' + tLoad + 'ms · SFS.build ' + tBuild + 'ms');
line('旧: tables=' + Object.keys(OLD.tables).length + ' fields=' + Object.values(OLD.tables).reduce((n, t) => n + t.fields.length, 0) + ' actuators=' + Object.keys(OLD.actuators).length + ' refs=' + Object.keys(OLD.refTargets).length + ' enums=' + Object.keys(OLD.enums).length);
line('新: tables=' + Object.keys(SEM.tables).length + ' fields=' + Object.values(SEM.tables).reduce((n, t) => n + t.fields.length, 0) + ' actuators=' + Object.keys(SEM.actuators).length + ' refs=' + Object.keys(SEM.refTargets).length + ' enums=' + Object.keys(SEM.enums).length + ' rows=' + SEM.stats.rows);

let fTotal = 0, fSame = 0; const fDiff = {};
for (const t of Object.keys(OLD.tables)) {
  const nt = SEM.tables[t]; if (!nt) continue;
  const om = new Map(OLD.tables[t].fields.map((f) => [f.name, f]));
  const nm = new Map(nt.fields.map((f) => [f.name, f]));
  for (const [n, of] of om) {
    const nf = nm.get(n); if (!nf) { (fDiff.missing ||= []).push(t + '.' + n); continue; }
    fTotal++;
    let bad = null;
    for (const k of ['kind','desc','format','def','unit','note','target','implicit','confidence','hits','total']) {
      if (JSON.stringify(of[k]) !== JSON.stringify(nf[k])) { bad = k + ':' + JSON.stringify(of[k]) + '->' + JSON.stringify(nf[k]); break; }
    }
    if (bad) (fDiff[bad.split(':')[0]] ||= []).push(t + '.' + n + ' (' + bad + ')'); else fSame++;
  }
  for (const [n] of nm) if (!om.has(n)) (fDiff.extraField ||= []).push(t + '.' + n);
}
line('字段 ' + fTotal + ' 项，一致 ' + fSame + '（' + (100 * fSame / fTotal).toFixed(2) + '%）');
for (const [k, v] of Object.entries(fDiff)) line('  ' + k + ': ' + v.length + '｜例 ' + v.slice(0, 3).join(' ; '));

let aTotal = 0, aSame = 0; const aDiff = {};
for (const [n, oa] of Object.entries(OLD.actuators)) {
  const na = SEM.actuators[n]; if (!na) { (aDiff.missing ||= []).push(n); continue; }
  for (const k of ['base','desc']) { aTotal++; if (oa[k] === na[k]) aSame++; else (aDiff[k] ||= []).push(n); }
  const op = oa.params || {}, np = na.params || {};
  for (const pn of Object.keys(op)) {
    aTotal++; const x = op[pn], y = np[pn];
    if (!y) { (aDiff.missingParam ||= []).push(n + '.' + pn); continue; }
    let bad = null;
    for (const k of ['type','desc','target']) if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) { bad = k; break; }
    if (bad) (aDiff['param.' + bad] ||= []).push(n + '.' + pn); else aSame++;
  }
  for (const pn of Object.keys(np)) if (!op[pn]) (aDiff.extraParam ||= []).push(n + '.' + pn);
}
line('执行器 ' + aTotal + ' 项，一致 ' + aSame + '（' + (100 * aSame / aTotal).toFixed(2) + '%）');
for (const [k, v] of Object.entries(aDiff)) line('  ' + k + ': ' + v.length + '｜例 ' + v.slice(0, 5).join(', '));

let rTotal = 0, rSame = 0; const rDiff = [];
for (const [k, ov] of Object.entries(OLD.refTargets)) {
  const nv = SEM.refTargets[k]; rTotal++;
  if (!nv) { rDiff.push(k + ' 新缺失'); continue; }
  let bad = null;
  for (const kk of ['target','confidence','hits','total','reason']) if (JSON.stringify(ov[kk]) !== JSON.stringify(nv[kk])) { bad = kk + ':' + JSON.stringify(ov[kk]) + '->' + JSON.stringify(nv[kk]); break; }
  if (bad) rDiff.push(k + ' ' + bad); else rSame++;
}
line('引用目标 ' + rTotal + ' 个，一致 ' + rSame + '，差异 ' + rDiff.length);
for (const x of rDiff.slice(0, 6)) line('  ' + x);

let tTotal = 0, tSame = 0; const tDiff = [];
for (const [t, ot] of Object.entries(OLD.tables)) {
  const nt = SEM.tables[t]; if (!nt) continue;
  tTotal++; let bad = null;
  for (const k of ['rowCount','notesRate','hasSchema']) if (JSON.stringify(ot[k]) !== JSON.stringify(nt[k])) { bad = k + ':' + JSON.stringify(ot[k]) + '->' + JSON.stringify(nt[k]); break; }
  if (!bad && JSON.stringify(ot.increments) !== JSON.stringify(nt.increments)) bad = 'increments';
  if (!bad && JSON.stringify((ot.extraKeys || []).slice().sort()) !== JSON.stringify((nt.extraKeys || []).slice().sort())) bad = 'extraKeys:' + JSON.stringify(ot.extraKeys) + '->' + JSON.stringify(nt.extraKeys);
  if (bad) tDiff.push(t + ' ' + bad); else tSame++;
}
line('表元数据 ' + tTotal + ' 张，一致 ' + tSame + '，差异 ' + tDiff.length);
for (const x of tDiff.slice(0, 6)) line('  ' + x);

let eTotal = 0, eSame = 0, eZh = 0;
for (const [n, oe] of Object.entries(OLD.enums)) {
  const ne = SEM.enums[n]; if (!ne) continue;
  for (const v of Object.keys(oe)) { eTotal++; if (oe[v] === ne[v]) eSame++; if (/[\u4e00-\u9fa5]/.test(ne[v] || '')) eZh++; }
}
line('枚举 ' + eTotal + ' 值，一致 ' + eSame + '，新解析出中文 ' + eZh + ' 个');

console.log(out.join('\n'));