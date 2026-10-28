
/* 生成 src-tauri/icons/icon.ico + icon.png（零依赖：手写 PNG 编码 + ICO 容器）。
   图案：橙底圆角方块 + 白色 3 列网格，呼应「配置表」。 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
/* 画一个 size×size 的图标 */
function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const r = size * 0.22;              // 圆角半径
  const pad = size * 0.06;            // 外边缘留白
  const x0 = pad, y0 = pad, x1 = size - pad, y1 = size - pad;
  const inRounded = (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
    const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const s = size / 512;                // 以 512 为设计基准
  // 网格：3 列 2 行的白色圆角小格
  const cellW = 96 * s, cellH = 96 * s, gap = 22 * s;
  const gridW = cellW * 3 + gap * 2;
  const gx = (size - gridW) / 2, gy = (size - (cellH * 2 + gap)) / 2;
  const cells = [];
  for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) {
    cells.push({ x: gx + col * (cellW + gap), y: gy + row * (cellH + gap), w: cellW, h: cellH, rr: 12 * s });
  }
  const inCell = (x, y, c) => {
    const cx = Math.max(c.x + c.rr, Math.min(x, c.x + c.w - c.rr));
    const cy = Math.max(c.y + c.rr, Math.min(y, c.y + c.h - c.rr));
    if (x < c.x || x > c.x + c.w || y < c.y || y > c.y + c.h) return false;
    return (x - cx) ** 2 + (y - cy) ** 2 <= c.rr * c.rr;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRounded(x + 0.5, y + 0.5)) { buf[i + 3] = 0; continue; }
      // 橙底 #c2410c → 上方稍亮 #e2571a 的竖向渐变
      const t = y / size;
      buf[i] = Math.round(194 + (226 - 194) * (1 - t));
      buf[i + 1] = Math.round(65 + (87 - 65) * (1 - t));
      buf[i + 2] = Math.round(12 + (26 - 12) * (1 - t));
      buf[i + 3] = 255;
      for (const c of cells) {
        if (inCell(x + 0.5, y + 0.5, c)) { buf[i] = 255; buf[i + 1] = 252; buf[i + 2] = 246; buf[i + 3] = 255; break; }
      }
    }
  }
  return buf;
}

const outDir = join(import.meta.dirname, '..', 'src-tauri', 'icons');
mkdirSync(outDir, { recursive: true });

const sizes = [16, 32, 48, 64, 128, 256];
const entries = sizes.map((s) => ({ s, data: png(s, s, draw(s)) }));
const head = Buffer.alloc(6);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
let offset = 6 + entries.length * 16;
const dir = [];
for (const e of entries) {
  const b = Buffer.alloc(16);
  b[0] = e.s >= 256 ? 0 : e.s; b[1] = e.s >= 256 ? 0 : e.s;
  b[2] = 0; b[3] = 0;
  b.writeUInt16LE(1, 4); b.writeUInt16LE(32, 6);
  b.writeUInt32LE(e.data.length, 8); b.writeUInt32LE(offset, 12);
  dir.push(b); offset += e.data.length;
}
const ico = Buffer.concat([head, ...dir, ...entries.map((e) => e.data)]);
writeFileSync(join(outDir, 'icon.ico'), ico);
writeFileSync(join(outDir, 'icon.png'), png(512, 512, draw(512)));
writeFileSync(join(outDir, '32x32.png'), png(32, 32, draw(32)));
writeFileSync(join(outDir, '128x128.png'), png(128, 128, draw(128)));
console.log('icon.ico ' + ico.length + ' bytes, sizes=' + sizes.join(','));
