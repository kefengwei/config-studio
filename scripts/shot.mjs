/**
 * CDP 截图工具：node diagnostics/shot.mjs <url> <out.png> [scriptFile]
 * 无第三方依赖，用 Node 22 内置 WebSocket 驱动 Edge headless。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const [url, out, scriptFile] = process.argv.slice(2);
const PROFILE = path.join(os.tmpdir(), 'cdp-profile-' + Date.now());
const PORT = 9333 + Math.floor(Math.random() * 200);

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--window-size=1680,1050', 'about:blank',
], { stdio: 'ignore', detached: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    try { return await fn(); } catch (e) { if (Date.now() - t0 > timeout) throw e; await sleep(200); }
  }
}

const targets = await waitFor(async () => {
  const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
  const list = await r.json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page');
  return page;
});

const ws = new WebSocket(targets.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
};
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });
await sleep(1800);

if (scriptFile) {
  const code = fs.readFileSync(scriptFile, 'utf8');
  const r = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) console.error('SCRIPT ERROR:', JSON.stringify(r.exceptionDetails).slice(0, 500));
  else if (r.result && r.result.value !== undefined) console.log('script →', JSON.stringify(r.result.value).slice(0, 400));
  await sleep(1200);
}

const shotRes = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shotRes.data, 'base64'));
console.log('saved', out, fs.statSync(out).size, 'bytes');
ws.close();
child.kill();
await sleep(300);
process.exit(0);
