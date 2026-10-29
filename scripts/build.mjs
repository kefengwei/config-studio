import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');       // 项目根（config-studio）
const DIST = path.join(ROOT, 'dist');
const ASSETS = path.join(DIST, 'assets');
const SRC = path.join(ROOT, 'src');

const t0 = Date.now();
const step = (msg) => console.log('· ' + msg);

fs.mkdirSync(ASSETS, { recursive: true });

/* 1. 语义层：C# 定义 + 配置数据 + 枚举 → semantics.json */
step('生成语义层 semantics.json');
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-semantics.mjs')], { stdio: 'inherit', cwd: ROOT });

/* 2. 样式：Tailwind 4 */
step('构建 Tailwind CSS');
const cli = path.join(ROOT, 'node_modules', '@tailwindcss', 'cli', 'dist', 'index.mjs');
execFileSync(process.execPath, [cli, '-i', path.join(SRC, 'styles', 'input.css'), '-o', path.join(ASSETS, 'app.css'), '--minify'], { stdio: 'inherit', cwd: ROOT });

/* 3. 前端脚本：原样拷贝（无打包步骤，浏览器直接跑 IIFE） */
step('拷贝前端脚本');
for (const f of fs.readdirSync(path.join(SRC, 'js'))) {
  if (f.endsWith('.js')) fs.copyFileSync(path.join(SRC, 'js', f), path.join(ASSETS, f));
}

/* 3b. 字体：随包分发，不依赖系统安装。
 * 源文件在 src/fonts/*.woff2；这里只是拷贝，字体本身已按 GB2312 + 仓库字符做过子集。 */
step('拷贝字体');
const FONTS = path.join(SRC, 'fonts');
const FONT_OUT = path.join(ASSETS, 'fonts');
fs.mkdirSync(FONT_OUT, { recursive: true });
let fontBytes = 0;
for (const f of fs.readdirSync(FONTS)) {
  if (!f.endsWith('.woff2')) continue;
  fs.copyFileSync(path.join(FONTS, f), path.join(FONT_OUT, f));
  fontBytes += fs.statSync(path.join(FONT_OUT, f)).size;
}

/* 4. 页面
 * 给 assets 的 css/js 统一追加 ?v=<构建时间>：
 * Tauri 的 WebView2 会按 URL 缓存 /assets/*，没有版本号时改了前端重启 exe 还是旧代码。 */
step('拷贝 index.html');
const stamp = 'v' + Date.now().toString(36);
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
  .replace(/(src="\/assets\/[^"?]+\.js)(\?[^"]*)?(")/g, '$1?' + stamp + '$3')
  .replace(/(href="\/assets\/[^"?]+\.css)(\?[^"]*)?(")/g, '$1?' + stamp + '$3');
fs.writeFileSync(path.join(DIST, 'index.html'), html);

/* 5. 防回归：组件 class 名不得与 Tailwind utility 同名（utility 层优先级更高会盖掉组件样式） */
step('检查 class 名冲突');
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-classes.mjs')], { stdio: 'inherit', cwd: ROOT });

const size = (p) => (fs.statSync(p).size / 1024).toFixed(1) + ' KB';
console.log('');
console.log('构建完成：' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('  dist/index.html          ' + size(path.join(DIST, 'index.html')));
console.log('  dist/assets/app.css      ' + size(path.join(ASSETS, 'app.css')));
console.log('  dist/assets/semantics.json ' + size(path.join(ASSETS, 'semantics.json')));
console.log('  dist/assets/fonts/*.woff2  ' + (fontBytes / 1024 / 1024).toFixed(2) + ' MB');