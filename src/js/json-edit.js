(function () {
/**
 * 配置工作台 · JSON 精准编辑器
 * 为什么不能整文件重序列化：实测 7 个文件，只有 3 个能和 JSON.stringify(obj,null,2) 逐字节对上。
 *   - Config_CatalogItem / Config_Product 的数组是内联的 ["TreasureChest"]
 *   - Config_Task 有 "}, \r\n" 这种行尾多余空格
 *   - Config_RandomActuator 有 16 空格异常缩进
 * 所以：只替换被改字段的值区间，其余字节原样保留。
 */

const WS = new Set([' ', '\t', '\r', '\n']);

function skipWs(t, i) { while (i < t.length && WS.has(t[i])) i++; return i; }

function skipString(t, i) {
  i++; // 开引号
  while (i < t.length) {
    const c = t[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '"') return i + 1;
    i++;
  }
  throw new Error('未闭合的字符串 @' + i);
}

function skipPrimitive(t, i) {
  while (i < t.length) {
    const c = t[i];
    if (c === ',' || c === '}' || c === ']' || WS.has(c)) break;
    i++;
  }
  return i;
}

/**
 * 扫描整个 JSON，回调每个值区间。
 * cb(path: (string|number)[], vs: number, ve: number, isStringLiteral: boolean)
 */
function walk(t, i, path, cb) {
  i = skipWs(t, i);
  const c = t[i];
  if (c === '{') {
    i++;
    let first = true;
    for (;;) {
      i = skipWs(t, i);
      if (t[i] === '}') { i++; break; }
      if (!first) i = skipWs(t, t[i] === ',' ? i + 1 : i);
      if (t[i] !== '"') throw new Error('期望键名 @' + i);
      const ks = i;
      const ke = skipString(t, i);
      const key = JSON.parse(t.slice(ks, ke));
      i = skipWs(t, ke);
      if (t[i] !== ':') throw new Error('期望冒号 @' + i);
      const vs = skipWs(t, i + 1);
      const ve = walk(t, vs, path.concat([key]), cb);
      cb(path.concat([key]), vs, ve, t[vs] === '"');
      i = skipWs(t, ve);
      first = false;
    }
    return i;
  }
  if (c === '[') {
    i++;
    let idx = 0, first = true;
    for (;;) {
      i = skipWs(t, i);
      if (t[i] === ']') { i++; break; }
      if (!first) i = skipWs(t, t[i] === ',' ? i + 1 : i);
      const vs = i;
      const ve = walk(t, vs, path.concat([idx]), cb);
      cb(path.concat([idx]), vs, ve, t[vs] === '"');
      i = skipWs(t, ve);
      idx++; first = false;
    }
    return i;
  }
  if (c === '"') return skipString(t, i);
  return skipPrimitive(t, i);
}

/** 建立索引：每一行的对象区间 + 字段值区间 */
function scanTable(text) {
  // BOM 不是空白字符，跳过它但位置仍按原文计算
  const start = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  const rows = [];
  let itemsStart = -1, itemsEnd = -1;
  let rootEnd = -1;

  // 第一遍：找 Items 数组的区间
  walk(text, start, [], (path, vs, ve) => {
    if (path.length === 1 && path[0] === 'Items') { itemsStart = vs; itemsEnd = ve; }
    if (path.length === 0) rootEnd = ve;
  });
  if (itemsStart < 0) throw new Error('找不到 Items 数组');

  // 第二遍：扫 Items 的每个元素
  let i = skipWs(text, itemsStart + 1);
  let idx = 0;
  while (i < itemsEnd - 1) {
    i = skipWs(text, i);
    if (text[i] === ']') break;
    if (text[i] === ',') { i = skipWs(text, i + 1); continue; }
    if (text[i] !== '{') throw new Error('Items[' + idx + '] 不是对象 @' + i);
    const objStart = i;
    const fields = Object.create(null);
    let rowName = null;
    const objEnd = walk(text, objStart, ['Items', idx], (path, vs, ve, isStr) => {
      if (path.length !== 3) return;
      const f = path[2];
      fields[f] = { vs, ve, isStr };
      if (f === 'RowName' && isStr) rowName = JSON.parse(text.slice(vs, ve));
    });
    rows.push({ index: idx, objStart, objEnd, rowName, fields });
    i = objEnd;
    idx++;
  }
  return { rows, itemsStart, itemsEnd, rootEnd };
}

/** 探测缩进单位（用于新增字段/对象的格式化） */
function detectIndent(text) {
  const m = text.match(/\r?\n([ \t]+)"/);
  return m ? m[1] : '  ';
}

/** 探测换行符 */
function detectEol(text) { return text.includes('\r\n') ? '\r\n' : '\n'; }

/** 该字段的缩进（键所在行的前导空白） */
function fieldIndent(text, vs, eol) {
  const lineStart = text.lastIndexOf(eol, vs) + eol.length;
  let i = lineStart;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return text.slice(lineStart, i);
}

/**
 * 把值序列化成文本，尽量贴合原值的排版：
 * 原值内联且新值是容器 → 内联；原值多行 → 多行并沿用缩进单位。
 */
function serializeLike(origText, value, indentUnit, baseIndent, eol) {
  const multiline = /[\r\n]/.test(origText);
  const isScalar = value === null || typeof value !== 'object';
  if (isScalar) return JSON.stringify(value);
  if (!multiline) return JSON.stringify(value);
  const body = JSON.stringify(value, null, indentUnit);
  return body.split('\n').join(eol + baseIndent);
}

/** 修改一行的若干字段，返回新文本 */
function setRowFields(text, rowName, patch, { indentUnit, eol } = {}) {
  const idx = scanTable(text);
  const row = idx.rows.find((r) => r.rowName === rowName);
  if (!row) throw new Error('行不存在: ' + rowName);
  indentUnit = indentUnit || detectIndent(text);
  eol = eol || detectEol(text);

  // 从后往前替换，避免偏移失效
  const ops = [];
  for (const [k, v] of Object.entries(patch)) {
    const span = row.fields[k];
    if (!span) { ops.push({ add: true, key: k, value: v }); continue; }
    const orig = text.slice(span.vs, span.ve);
    const base = fieldIndent(text, span.vs, eol);
    ops.push({ vs: span.vs, ve: span.ve, text: serializeLike(orig, v, indentUnit, base, eol) });
  }

  let out = text;
  for (const op of ops.filter((o) => !o.add).sort((a, b) => b.vs - a.vs)) {
    out = out.slice(0, op.vs) + op.text + out.slice(op.ve);
  }
  // 新增字段：插到对象最后一个字段后面
  const adds = ops.filter((o) => o.add);
  if (adds.length) out = addFieldsToRow(out, rowName, adds.map((o) => [o.key, o.value]), { indentUnit, eol });
  return out;
}

/**
 * 批量改多行的字段：一次 scanTable，避免每个 op 都重扫全文件。
 * 为什么需要：Config_Level 2.7MB，scanTable 一次约 0.6 秒；
 * 列编辑一次改 2000+ 格时，逐个 setRowFields 会扫 2000 次（实测 20 行就要 13 秒）。
 */
function setManyRows(text, items, { indentUnit, eol } = {}) {
  if (!items.length) return text;
  const idx = scanTable(text);
  const byName = new Map();
  for (const r of idx.rows) byName.set(r.rowName, r);
  indentUnit = indentUnit || detectIndent(text);
  eol = eol || detectEol(text);

  const edits = [];
  const adds = new Map(); // 行名 -> [[字段, 值]]，缺字段的走 addFieldsToRow（每行只扫一次）
  for (const it of items) {
    const row = byName.get(it.row);
    if (!row) throw new Error('行不存在: ' + it.row);
    for (const [k, v] of Object.entries(it.patch)) {
      const span = row.fields[k];
      if (!span) {
        const arr = adds.get(it.row) || [];
        arr.push([k, v]);
        adds.set(it.row, arr);
        continue;
      }
      const orig = text.slice(span.vs, span.ve);
      const base = fieldIndent(text, span.vs, eol);
      edits.push({ vs: span.vs, ve: span.ve, text: serializeLike(orig, v, indentUnit, base, eol) });
    }
  }

  // 一次 join 拼完：倒序逐段 slice 拼接是 O(文件大小 × 段数)，2000 格会把 2.7MB 复制 2000 遍
  let out = text;
  if (edits.length) {
    edits.sort((a, b) => a.vs - b.vs);
    const parts = [];
    let last = 0;
    for (const e of edits) {
      parts.push(text.slice(last, e.vs), e.text);
      last = e.ve;
    }
    parts.push(text.slice(last));
    out = parts.join('');
  }
  for (const [rowName, pairs] of adds) out = addFieldsToRow(out, rowName, pairs, { indentUnit, eol });
  return out;
}

/** 给行追加字段（保持缩进与逗号） */
function addFieldsToRow(text, rowName, pairs, { indentUnit, eol } = {}) {
  const idx = scanTable(text);
  const row = idx.rows.find((r) => r.rowName === rowName);
  if (!row) throw new Error('行不存在: ' + rowName);
  indentUnit = indentUnit || detectIndent(text);
  eol = eol || detectEol(text);

  // 对象闭括号的位置：objEnd-1 是 }
  const close = row.objEnd - 1;
  const fieldNames = Object.keys(row.fields);
  const lastField = fieldNames.length ? row.fields[fieldNames[fieldNames.length - 1]] : null;
  if (!lastField) throw new Error('空对象暂不支持');
  // 最后一个值的结束位置之后：可能有空格 + 可选逗号
  const afterLast = lastField.ve;
  const between = text.slice(afterLast, close);
  const hasTrailingComma = /,/.test(between) && !/^\s*,?\s*$/.test(between) === false ? /^\s*,/.test(between) : false;

  const base = fieldIndent(text, row.fields[fieldNames[0]].vs, eol);
  const lines = pairs.map(([k, v]) => {
    const ser = serializeLike('', v, indentUnit, base, eol);
    return base + JSON.stringify(k) + ': ' + ser;
  });

  // 情况 A：字段之间没有逗号（最后字段后无逗号）→ 在前面补逗号
  const insertPos = afterLast;
  const prefix = hasTrailingComma ? '' : ',';
  const body = prefix + eol + lines.join(',' + eol);
  return text.slice(0, insertPos) + body + text.slice(insertPos);
}

/** 删除一行 */
function deleteRow(text, rowName, { eol } = {}) {
  const idx = scanTable(text);
  const pos = idx.rows.findIndex((r) => r.rowName === rowName);
  if (pos < 0) throw new Error('行不存在: ' + rowName);
  eol = eol || detectEol(text) || '\n';
  const row = idx.rows[pos];

  // 按「整行」删除，绝不跨过下一行的缩进。
  // 旧实现用 skipWs 往后吃掉空白和换行，end 落到下一行对象开头，
  // 于是上一行与下一行粘连、下一行的缩进丢失（JSON 仍能 parse，所以很难发现）。
  const lineStart = text.lastIndexOf(eol, row.objStart) + eol.length;
  const lead = text.slice(lineStart, row.objStart);

  // 本行结束：对象 → 行尾空格 → 可选逗号 → 行尾空格 → 换行
  let j = row.objEnd;
  while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
  const hasComma = text[j] === ',';
  if (hasComma) j++;
  let e = j;
  while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
  let eolStart = -1;
  if (e < text.length && text.startsWith(eol, e)) eolStart = e;
  else if (e < text.length && (text[e] === '\n' || text[e] === '\r')) eolStart = e;

  if (/^[ \t]*$/.test(lead)) {
    if (hasComma) {
      // 中间行：删本行整行（含换行），下一行的缩进原样保留
      const end = eolStart >= 0 ? eolStart + eol.length : j;
      return text.slice(0, lineStart) + text.slice(end);
    }
    // 最后一行：吃掉上一行末尾的逗号，但保留上一行自己的换行
    let c = lineStart - 1;
    while (c >= 0 && WS.has(text[c])) c--;
    if (text[c] === ',') {
      const end = eolStart >= 0 ? eolStart : j;
      return text.slice(0, c) + text.slice(end);
    }
    // 只有一个元素：整行删掉（含换行）
    const end = eolStart >= 0 ? eolStart + eol.length : j;
    return text.slice(0, lineStart) + text.slice(end);
  }

  // 兜底：行首还有别的内容（格式非常规），只删对象区间
  let start = row.objStart;
  let end = row.objEnd;
  const j2 = skipWs(text, end);
  if (text[j2] === ',') { end = skipWs(text, j2 + 1); }
  else {
    let p = start - 1;
    while (p >= 0 && WS.has(text[p])) p--;
    if (text[p] === ',') start = p;
  }
  return text.slice(0, start) + text.slice(end);
}

/** 新增一行（插到末尾） */
function appendRow(text, obj, { indentUnit, eol } = {}) {
  const idx = scanTable(text);
  indentUnit = indentUnit || detectIndent(text);
  eol = eol || detectEol(text);
  const base = idx.rows.length ? fieldIndent(text, idx.rows[0].fields.Object ? idx.rows[0].fields.Object.vs : idx.rows[0].objStart + 1, eol) : indentUnit + indentUnit;
  const rowIndent = idx.rows.length ? text.slice(text.lastIndexOf(eol, idx.rows[0].objStart) + eol.length, idx.rows[0].objStart).match(/^[ \t]*/)[0] : indentUnit + indentUnit;
  const fieldIndentStr = rowIndent + indentUnit;
  const body = JSON.stringify(obj, null, indentUnit).split('\n').join(eol + rowIndent);
  const block = rowIndent + body;

  // 找 Items 数组的闭括号
  const itemsClose = idx.itemsEnd - 1;
  const before = text.slice(0, itemsClose).replace(/\s+$/, '');
  /* 闭括号 ] 前面的缩进要原样保留：before 已经把尾部空白削掉了，
     不补回来的话新增后的 "]" 会顶格，文件的缩进就被改坏。 */
  const closeLine = text.slice(text.lastIndexOf('\n', itemsClose - 1) + 1, itemsClose);
  const closeIndent = (closeLine.match(/^[ \t]*/) || [''])[0];
  // 若 Items 为空数组 []
  const isEmpty = /\[\s*$/.test(before);
  if (isEmpty) return before + eol + block + eol + closeIndent + text.slice(itemsClose);
  const sep = ',' + eol;
  return before + sep + block + eol + closeIndent + text.slice(itemsClose);
}

/**
 * 批量按「行内完整路径」改值，一次扫描完成。
 * 为什么不能循环调 setRowFields：Config_Level 2380 行 / 2.7MB，逐行 scanTable 会重扫整个文件 2000+ 次。
 * updates: [{ row: 'RowName', path: ['Rewards', 0, 'RequiredValue'], value: 20 }]
 * 返回 { text, applied, missing: [{ row, path, reason }] }
 */
function setManyPaths(text, updates, { indentUnit, eol } = {}) {
  const idx = scanTable(text);
  const rowByName = new Map();
  for (const r of idx.rows) if (r.rowName) rowByName.set(r.rowName, r);

  indentUnit = indentUnit || detectIndent(text);
  eol = eol || detectEol(text);

  const K = (p) => p.join('\u0000');
  const want = new Map();
  const missing = [];
  for (const u of updates) {
    const row = rowByName.get(u.row);
    if (!row) { missing.push({ row: u.row, path: u.path, reason: '行不存在' }); continue; }
    want.set(K(['Items', row.index].concat(u.path)), u);
  }

  const hits = [];
  const seen = new Set();
  const from = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  walk(text, from, [], (p, vs, ve) => {
    const k = K(p);
    const u = want.get(k);
    if (!u) return;
    seen.add(k);
    hits.push({ vs, ve, value: u.value });
  });
  for (const [k, u] of want) if (!seen.has(k)) missing.push({ row: u.row, path: u.path, reason: '路径不存在' });

  hits.sort((a, b) => a.vs - b.vs);
  const parts = [];
  let last = 0;
  for (const h of hits) {
    const orig = text.slice(h.vs, h.ve);
    const base = fieldIndent(text, h.vs, eol);
    parts.push(text.slice(last, h.vs), serializeLike(orig, h.value, indentUnit, base, eol));
    last = h.ve;
  }
  parts.push(text.slice(last));
  return { text: parts.join(''), applied: hits.length, missing };
}

window.JSONEDIT = { scanTable, detectIndent, detectEol, fieldIndent, serializeLike, setRowFields, setManyRows, addFieldsToRow, deleteRow, appendRow, setManyPaths };
})();
