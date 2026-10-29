/**
 * 重新生成字体子集：node scripts/subset-font.mjs --ttf <ttf目录> --out src/fonts
 *
 * 步骤：收集字符（GB2312 全集 + 本仓库 + 前端源码）→ 调 python fontTools 子集 → 写 woff2。
 * 依赖：python + `pip install fonttools brotli`。
 *
 * 为什么子集：官方 NF-CN 单字重 TTF 20MB / woff2 6.1MB，三档 18MB，exe 会到 25MB。
 * GB2312 + 仓库字符共约 7.5k 字，每档 1.7MB。代价是 GB2312 之外的字会 fallback 到系统字体。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const TTF_DIR = path.resolve(arg('ttf', ''));
const OUT_DIR = path.resolve(arg('out', path.join(ROOT, 'src', 'fonts')));
const CFG_DIR = path.resolve(arg('repo', 'G:/Github/dr_config_repo'));
const WEIGHTS = ['Regular', 'Medium', 'SemiBold'];

if (!arg('ttf')) {
  console.error('用法：node scripts/subset-font.mjs --ttf <解压出的 ttf 目录> [--out src/fonts] [--repo <配置仓库>]');
  process.exit(1);
}
for (const w of WEIGHTS) {
  const p = path.join(TTF_DIR, 'MapleMono-NF-CN-' + w + '.ttf');
  if (!fs.existsSync(p)) {
    console.error('缺少字重文件：' + p);
    process.exit(1);
  }
}

/* ---------- 1. 收集字符 ---------- */
const chars = new Set();
for (let c = 0x20; c <= 0x7e; c++) chars.add(String.fromCharCode(c));   // ASCII 可打印
// 中文标点、全角符号、货币、数学符号
for (const ch of '　、。，．·；：？！（）【】《》〈〉「」『』…—～￥×÷≤≥≠→←↑↓△○●◆■□※§¶†‡‰°′″⁄€£¥©®™') chars.add(ch);
// 常见拉丁重音（人名、外来词）
for (const ch of 'àáâãäåæçèéêëìíîïñòóôõöøùúûüýÿ') chars.add(ch);

// GB2312 全集（6763 汉字 + 符号区）—— 覆盖日常中文 99.9%
for (let b1 = 0xa1; b1 < 0xf8; b1++) {
  for (let b2 = 0xa1; b2 < 0xff; b2++) {
    try { chars.add(new TextDecoder('gbk').decode(new Uint8Array([b1, b2]))); } catch (e) { /* 空位跳过 */ }
  }
}

const files = [];
const walk = (dir) => {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { walk(p); continue; }
    if (/\.(json|js|html|css|md)$/i.test(ent.name)) files.push(p);
  }
};
walk(path.join(CFG_DIR, 'configs'));
walk(path.join(CFG_DIR, 'json-schemas'));
walk(path.join(ROOT, 'src'));
files.push(path.join(ROOT, 'README.md'));

for (const f of files) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp > 0x7e && cp < 0x3000) continue;   // 跳过拉丁扩展区之外的杂符号
    if (cp >= 0x3000) chars.add(ch);
  }
}

const tmp = path.join(OUT_DIR, '.charset.txt');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(tmp, [...chars].sort().join(''), 'utf8');
console.log('· 字符集 ' + chars.size + ' 个（' + files.length + ' 个文件）');

/* ---------- 2. 子集 ---------- */
const PY = process.env.PYTHON || 'python';
for (const w of WEIGHTS) {
  const src = path.join(TTF_DIR, 'MapleMono-NF-CN-' + w + '.ttf');
  const dst = path.join(OUT_DIR, 'MapleMono-NF-CN-' + w + '.woff2');
  process.stdout.write('· ' + w + ' … ');
  execFileSync(PY, [
    '-m', 'fontTools.subset', src,
    '--text-file=' + tmp,
    '--flavor=woff2',
    '--output-file=' + dst,
    '--layout-features=*',
    '--no-hinting',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  console.log((fs.statSync(dst).size / 1024 / 1024).toFixed(2) + ' MB');
}

/* ---------- 3. 许可证 ---------- */
const lic = ['LICENSE.txt', 'OFL.txt', 'OFL-MapleMono.txt']
  .map((n) => path.join(TTF_DIR, n))
  .find((p) => fs.existsSync(p));
if (lic) {
  fs.copyFileSync(lic, path.join(OUT_DIR, 'OFL-MapleMono.txt'));
  console.log('· 许可证 → OFL-MapleMono.txt');
} else {
  console.warn('! ttf 目录里没有 LICENSE.txt，请手动补 OFL 文本（OFL 1.1 要求随字体分发）');
}

fs.unlinkSync(tmp);
console.log('完成：' + OUT_DIR);
