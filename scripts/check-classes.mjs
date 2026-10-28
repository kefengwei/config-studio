/**
 * 构建后防回归：src 里用到的 class 名，如果和 Tailwind 生成的 utility 同名，
 * utilities 层的优先级高于组件样式，会把组件样式覆盖掉。
 * 典型事故：<table class="grid"> 被 .grid{display:grid} 命中，表头与数据行错位。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'dist/assets/app.css'), 'utf8');

/* 取出 @layer utilities{...} 的完整内容（大括号配对，压缩后仍可解析） */
function layerBody(text, name) {
  const head = '@layer ' + name + '{';
  const i = text.indexOf(head);
  if (i < 0) return '';
  let depth = 1;
  let j = i + head.length;
  while (j < text.length && depth > 0) {
    const ch = text[j];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    j++;
  }
  return text.slice(i + head.length, Math.max(i + head.length, j - 1));
}

const utils = new Set();
for (const m of layerBody(css, 'utilities').matchAll(/\.([a-zA-Z_][-a-zA-Z0-9_\\[\\].%]*)\{/g)) {
  utils.add(m[1].replace(/\\/g, ''));
}

const files = [
  path.join(ROOT, 'src/index.html'),
  ...fs.readdirSync(path.join(ROOT, 'src/js')).map((f) => path.join(ROOT, 'src/js', f)),
];
const used = new Map();
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c && !used.has(c)) used.set(c, path.basename(f));
  }
}

const clash = [...used].filter(([c]) => utils.has(c));
if (clash.length) {
  console.error('x class 名与 Tailwind 工具类冲突（组件样式会被覆盖）：');
  for (const [c, f] of clash) console.error('   .' + c + '  ← ' + f);
  process.exit(1);
}
console.log('· class 名检查通过（' + used.size + ' 个类，0 冲突）');
