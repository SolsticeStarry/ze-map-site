#!/usr/bin/env node
/**
 * 把云朵小铺预览数据里的实体包围盒表合并进本站按图分片。
 *
 * 用法：
 *   node scripts/entity-data/import-bounds.mjs --src "D:/AIG/云朵小铺-FYS通关奖励看板/preview3d.html"
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const src = path.resolve(ROOT, arg('src') || '');
const catalogPath = path.join(ROOT, 'public/entity/catalog.json');
if (!arg('src') || !fs.existsSync(src)) {
  console.error('请用 --src 指定云朵小铺 preview3d.html');
  process.exit(1);
}

const html = fs.readFileSync(src, 'utf8');
const match = html.match(/<script id="payload" type="text\/plain">([\s\S]*?)<\/script>/);
if (!match) throw new Error('源文件中没有找到 payload');
const gz = zlib.gunzipSync(Buffer.from(match[1].trim(), 'base64'));
const jsonLength = gz.readUInt32LE(0);
const source = JSON.parse(gz.subarray(4, 4 + jsonLength));
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

let updated = 0;
let records = 0;
let skipped = 0;
for (const entry of catalog.maps) {
  const sourceMap = source.maps[entry.k];
  const file = path.join(ROOT, 'public/entity/data', `${entry.s}.bin`);
  if (!sourceMap?.bb || !sourceMap?.bbm || !fs.existsSync(file)) {
    skipped++;
    continue;
  }

  const packed = fs.readFileSync(file);
  const framed = zlib.gunzipSync(packed);
  const n = framed.readUInt32LE(0);
  const payload = JSON.parse(framed.subarray(4, 4 + n));
  if (!payload.map?.e || payload.map.e.length !== sourceMap.e.length) {
    skipped++;
    continue;
  }
  payload.map.bb = sourceMap.bb;
  payload.map.bbm = sourceMap.bbm;
  const outJson = Buffer.from(JSON.stringify(payload), 'utf8');
  const binLength = framed.length - 4 - n;
  const out = Buffer.alloc(4 + outJson.length + binLength);
  out.writeUInt32LE(outJson.length, 0);
  outJson.copy(out, 4);
  /* 分片 BIN 位于 JSON 之后，保留原始二进制尾部。 */
  framed.subarray(4 + n).copy(out, 4 + outJson.length);
  fs.writeFileSync(file, zlib.gzipSync(out, { level: 9 }));
  updated++;
  records += sourceMap.bbm.filter((x) => x >= 0).length;
}

console.log(`已合并 ${updated} 张地图、${records.toLocaleString()} 个实体包围盒`);
console.log(`跳过 ${skipped} 张地图（无包围盒、文件不存在或实体数量不一致）`);
