// 发版助手：把版本号同步到四处清单，然后打印打 tag 的命令。
//
// 用法：
//   node scripts/release.mjs            查看当前四处版本是否一致
//   node scripts/release.mjs 0.2.0      把四处都改成 0.2.0
//
// 不会提交、不会打 tag、不会推送 —— 只改文件和打印下一步命令。

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const F = {
  pkg: join(ROOT, 'package.json'),
  conf: join(ROOT, 'src-tauri/tauri.conf.json'),
  cargo: join(ROOT, 'src-tauri/Cargo.toml'),
  lock: join(ROOT, 'src-tauri/Cargo.lock'),
};

function lockVersion(lines) {
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i] === 'name = "config-studio"' && lines[i + 1].startsWith('version = "')) {
      return i + 1;
    }
  }
  return -1;
}

function current() {
  const pkg = JSON.parse(readFileSync(F.pkg, 'utf8')).version;
  const conf = JSON.parse(readFileSync(F.conf, 'utf8')).version;
  const cargo = (readFileSync(F.cargo, 'utf8').match(/^version = "([^"]+)"/m) || [])[1];
  const lines = readFileSync(F.lock, 'utf8').split('\n');
  const i = lockVersion(lines);
  const lock = i < 0 ? null : lines[i].slice(11, -1);
  return { pkg, conf, cargo, lock };
}

function apply(v) {
  // JSON 只替换 version 那一行，避免整体重排格式
  const reJson = /("version"\s*:\s*")[^"]+(")/;
  for (const p of [F.pkg, F.conf]) {
    const s = readFileSync(p, 'utf8');
    if (!reJson.test(s)) throw new Error('没找到 version 字段：' + p);
    writeFileSync(p, s.replace(reJson, (m, a, b) => a + v + b), 'utf8');
  }

  // Cargo.toml：第一个 version = "x" 就是 [package] 的
  const src = readFileSync(F.cargo, 'utf8');
  const reCargo = /^version = "[^"]+"/m;
  if (!reCargo.test(src)) throw new Error('没找到 Cargo.toml 的 version');
  writeFileSync(F.cargo, src.replace(reCargo, 'version = "' + v + '"'), 'utf8');

  // Cargo.lock：只改 config-studio 这一包的 version
  const lines = readFileSync(F.lock, 'utf8').split('\n');
  const i = lockVersion(lines);
  if (i < 0) throw new Error('没找到 Cargo.lock 里 config-studio 的 version');
  lines[i] = 'version = "' + v + '"';
  writeFileSync(F.lock, lines.join('\n'), 'utf8');
}

const want = process.argv[2];

if (!want) {
  const c = current();
  console.log('当前版本：');
  for (const [k, v] of Object.entries(c)) console.log('  ' + k.padEnd(12) + v);
  const all = new Set(Object.values(c));
  console.log(all.size === 1 ? '\n四处一致。' : '\n不一致，跑 node scripts/release.mjs <版本号> 同步。');
  process.exit(0);
}

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(want)) {
  console.error('版本号格式不对，要 semver，例如 0.2.0 或 0.2.0-beta.1');
  process.exit(1);
}

apply(want);
console.log('已把四处清单改成 ' + want + '：');
for (const [k, v] of Object.entries(current())) console.log('  ' + k.padEnd(12) + v);

console.log('\n确认无误后依次执行（CI 会在 tag 推上去后自动构建并发布）：');
console.log('  git add -A && git commit -m "chore: 发布 v' + want + '"');
console.log('  git tag v' + want);
console.log('  git push github main --tags');
console.log('\n注意：tag 名必须和 tauri.conf.json 的 version 一致。');

