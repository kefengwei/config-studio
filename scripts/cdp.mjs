/* 调试用：连已启动的桌面版（带 --remote-debugging-port=9333）执行一段 JS。
   用法：node scripts/cdp.mjs "document.title"
        node scripts/cdp.mjs scripts/probe.js   （.js 结尾时按文件读取）
   配套截图：node scripts/cdp-shot.mjs out.png */
import { readFileSync } from 'node:fs';
const arg = process.argv[2] || '';
const expr = arg.endsWith('.js') ? readFileSync(arg, 'utf8') : arg;
const PORT = process.env.CDP_PORT || '9333';
const list = await fetch('http://127.0.0.1:' + PORT + '/json').then((r) => r.json());
const page = list.find((t) => t.type === 'page');
if (!page) { console.error('no page'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const r = await new Promise((res) => {
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) res(m); };
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  setTimeout(() => res({ result: {} }), 40000);
});
ws.close();
if (r.result && r.result.result) console.log(typeof r.result.result.value === 'string' ? r.result.result.value : JSON.stringify(r.result.result.value));
else console.log('(no value) ' + JSON.stringify(r).slice(0, 400));
process.exit(0);