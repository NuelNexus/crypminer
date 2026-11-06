// Draws the Kiln mark (dark tile, orange kiln outline) to PNG + ICO with no dependencies.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets');
fs.mkdirSync(OUT, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Geometry in a 32-unit box, same as the in-app SVG mark.
const SEGMENTS = [[8, 22, 24, 22], [10, 22, 10, 12], [10, 12, 16, 8], [16, 8, 22, 12], [22, 12, 22, 22]];

function draw(size, { tile = true } = {}) {
  const s = size / 32;
  const buf = Buffer.alloc(size * size * 4);
  const stroke = (size <= 16 ? 3.2 : size <= 32 ? 2.9 : 2.5) * s;
  const radius = 6 * s;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      // rounded-square coverage
      const qx = Math.abs(px - size / 2) - (size / 2 - radius);
      const qy = Math.abs(py - size / 2) - (size / 2 - radius);
      const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
      const tileA = tile ? Math.max(0, Math.min(1, 0.5 - sd)) : 0;
      // stroke coverage
      let d = Infinity;
      for (const [ax, ay, bx, by] of SEGMENTS) d = Math.min(d, segDist(px, py, ax * s, ay * s, bx * s, by * s));
      const strokeA = Math.max(0, Math.min(1, stroke / 2 - d + 0.5));
      // composite orange over dark tile
      const bg = [0x11, 0x14, 0x13], fg = [0xff, 0x4d, 0x12];
      const a = strokeA + tileA * (1 - strokeA);
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        buf[i + c] = a ? Math.round((fg[c] * strokeA + bg[c] * tileA * (1 - strokeA)) / a) : 0;
      }
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, buf);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((n) => draw(n));
fs.writeFileSync(path.join(OUT, 'icon.png'), pngs[sizes.indexOf(256)]);
fs.writeFileSync(path.join(OUT, 'tray.png'), pngs[sizes.indexOf(32)]);
fs.writeFileSync(path.join(OUT, 'tray@2x.png'), pngs[sizes.indexOf(64)]);

// ICO with embedded PNG images
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
const dir = Buffer.alloc(16 * sizes.length);
let offset = 6 + dir.length;
sizes.forEach((n, i) => {
  const e = i * 16;
  dir[e] = n >= 256 ? 0 : n; dir[e + 1] = n >= 256 ? 0 : n;
  dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(pngs[i].length, e + 8); dir.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
fs.writeFileSync(path.join(OUT, 'icon.ico'), Buffer.concat([header, dir, ...pngs]));
console.log('icons written to', OUT);
