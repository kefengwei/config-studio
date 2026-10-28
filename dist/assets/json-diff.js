(function () {
/**
 * 局部行 diff：配置编辑只影响少数行，用前缀/后缀剥离 + 贪心对齐，
 * 避免对 11 万行的 Config_Level 做 O(n*m) 的 LCS。
 */
function diffLines(a, b, { ctx = 2, maxHunks = 40, look = 40 } = {}) {
  const al = a.split(/\r?\n/);
  const bl = b.split(/\r?\n/);
  const n = al.length, m = bl.length;

  // 先剥公共前缀/后缀，缩小范围
  let lo = 0;
  while (lo < n && lo < m && al[lo] === bl[lo]) lo++;
  let hiA = n, hiB = m;
  while (hiA > lo && hiB > lo && al[hiA - 1] === bl[hiB - 1]) { hiA--; hiB--; }

  const hunks = [];
  let i = lo, j = lo;
  let cur = null;
  const push = (type, text) => {
    if (!cur) { cur = { aStart: i + 1, aLines: [], bLines: [], start: i }; hunks.push(cur); }
    if (type === 'add') cur.bLines.push(text); else cur.aLines.push(text);
  };
  const flush = () => {
    if (cur && (cur.aLines.length || cur.bLines.length)) {
      // 补上下文
      const before = [];
      for (let k = Math.max(0, cur.start - ctx); k < cur.start; k++) before.push(al[k]);
      cur.before = before;
      const afterIdx = cur.start + cur.aLines.length;
      const after = [];
      for (let k = afterIdx; k < Math.min(n, afterIdx + ctx); k++) after.push(al[k]);
      cur.after = after;
    }
    cur = null;
  };

  while (i < hiA || j < hiB) {
    // 一侧已到达公共后缀：只补另一侧的增/删。
    // 曾在这里越界取到被剥离的后缀行，把没变的 "}," 误报成删除。
    if (i >= hiA) { push('add', bl[j++]); continue; }
    if (j >= hiB) { push('del', al[i++]); continue; }
    if (al[i] === bl[j]) { flush(); i++; j++; continue; }
    // 找最近的重新同步点
    let si = -1, sj = -1;
    for (let k = 1; k <= look; k++) {
      if (i + k < hiA && al[i + k] === bl[j]) { si = i + k; sj = j; break; }
    }
    for (let k = 1; k <= look; k++) {
      if (j + k < hiB && al[i] === bl[j + k]) { if (si < 0 || k < si - i) { si = i; sj = j + k; } break; }
    }
    if (si < 0) {
      // 找不到重新同步点：只并排推进 1 行（推进多了会把未变的中间行误判成删除）
      push('del', al[i]); push('add', bl[j]);
      i++; j++;
      continue;
    }
    while (i < si) push('del', al[i++]);
    while (j < sj) push('add', bl[j++]);
  }
  flush();

  const changedRows = hunks.reduce((s, h) => s + Math.max(h.aLines.length, h.bLines.length), 0);
  return {
    hunks: hunks.slice(0, maxHunks),
    truncated: hunks.length > maxHunks,
    hunkCount: hunks.length,
    removedLines: hunks.reduce((s, h) => s + h.aLines.length, 0),
    addedLines: hunks.reduce((s, h) => s + h.bLines.length, 0),
    changedRows,
  };
}

/** 生成 git 风格的 unified diff 文本（给「导出补丁」用） */
function toUnified(a, b, opts) {
  const d = diffLines(a, b, opts);
  const out = [];
  for (const h of d.hunks) {
    const aLen = h.before.length + h.aLines.length + h.after.length;
    const bLen = h.before.length + h.bLines.length + h.after.length;
    const aStart = Math.max(1, h.aStart - h.before.length);
    const bStart = Math.max(1, h.aStart - h.before.length);
    out.push('@@ -' + aStart + ',' + aLen + ' +' + bStart + ',' + bLen + ' @@');
    for (const l of h.before) out.push(' ' + l);
    for (const l of h.aLines) out.push('-' + l);
    for (const l of h.bLines) out.push('+' + l);
    for (const l of h.after) out.push(' ' + l);
  }
  return out.join('\n');
}
window.JSONDIFF = { diffLines, toUnified };
})();
