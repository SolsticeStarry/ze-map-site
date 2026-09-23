#!/usr/bin/env node
/**
 * 把「地图实体预览」单文件（10MB，base64+gzip 内嵌全量 645 张地图）拆成
 * 按图分片的数据文件，供网站按需加载。
 *
 * 输入：--src <单文件 HTML 路径>（默认 data/entity-preview-source.html）
 * 输出：
 *   public/entity/catalog.json          全部地图的索引（列表页只需这一个文件）
 *   public/entity/data/<slug>.bin       每张图一个 gzip 分片：[4B 小端 JSON 长度][JSON][BIN]
 *
 * 分片内的 JSON 结构（与原文件一致，但做了两处精简）：
 *   - 只含该图自己的记录
 *   - A/C（属性/连线）在构建期把字符串表索引解析成可读文本，改为 A2 / C2，
 *     于是分片不再需要携带 tp(3.2MB) / pp(1.5MB) 两张全局字符串表
 *
 * 用法：
 *   node scripts/entity-data/build-entity-data.mjs --src "path/to/预览.html"
 *   node scripts/entity-data/build-entity-data.mjs --src ... --mode 2001   # 只导出 ZE
 *   node scripts/entity-data/build-entity-data.mjs --src ... --stats
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const SRC = path.resolve(ROOT, opt('src', 'data/entity-preview-source.html'));
const OUT = path.resolve(ROOT, opt('out', 'public/entity'));
const MODE = opt('mode', null); // 例如 2001 = ZE
const STATS = has('stats');
const GZ_LEVEL = Number(opt('level', 9));

/* ---------------- 读取并解包原始单文件 ---------------- */
if (!fs.existsSync(SRC)) {
  console.error(`找不到源文件：${SRC}`);
  console.error('用 --src 指定「地图实体预览-3D视图.html」的路径，或把它放到 data/entity-preview-source.html');
  process.exit(1);
}
const html = fs.readFileSync(SRC, 'utf8');
const payloadMatch = html.match(/<script id="payload" type="text\/plain">([\s\S]*?)<\/script>/);
if (!payloadMatch) {
  console.error('源文件里没有找到 <script id="payload">，确认一下是不是那个单文件预览。');
  process.exit(1);
}
const gz = zlib.gunzipSync(Buffer.from(payloadMatch[1].trim(), 'base64'));
const jlen = gz.readUInt32LE(0);
const DATA = JSON.parse(gz.subarray(4, 4 + jlen).toString('utf8'));
const BIN = gz.subarray(4 + jlen);

console.log(`源文件   ${path.relative(ROOT, SRC)}  (${(html.length / 1048576).toFixed(2)} MB)`);
console.log(`解包后   JSON ${(jlen / 1048576).toFixed(2)} MB + BIN ${(BIN.length / 1048576).toFixed(2)} MB`);
console.log(`数据     构建于 ${DATA.meta.built} · 来源 ${DATA.meta.source}`);
console.log(`规模     ${DATA.meta.maps} 张图 / ${DATA.meta.entities_all} 实体\n`);

/* ---------------- 字符串表（构建期解析，不进分片） ---------------- */
const KP = DATA.kp || [];
const OP = DATA.op || [];
const IP = DATA.ip || [];
const TP = DATA.tp || [];
const PP = DATA.pp || [];

const parseAttrs = (s) =>
  !s
    ? []
    : s
        .split(';')
        .map((x) => {
          const j = x.indexOf('=');
          if (j < 0) return null;
          const ki = +x.slice(0, j);
          return [KP[ki] ?? String(ki), x.slice(j + 1)];
        })
        .filter(Boolean);

const parseConns = (s) =>
  !s
    ? []
    : s.split('\n').map((line) => {
        const p = line.split('|');
        const oi = +p[0] || 0;
        const ti = +p[1] || 0;
        const ii = +p[2] || 0;
        const pi = +p[3];
        return [OP[oi] ?? String(oi), TP[ti] ?? '', IP[ii] ?? String(ii), pi >= 0 ? PP[pi] ?? '' : '', p[4] || 0];
      });

const slugOf = (key) => key.replace(/\//g, '-');

/* ---------------- 逐图拆分 ---------------- */
fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });

const catalog = [];
let rawTotal = 0;
let gzTotal = 0;
let maxRec = { slug: '', bytes: 0 };

const keys = Object.keys(DATA.maps).filter((k) => !MODE || k.startsWith(`${MODE}/`));

for (const key of keys) {
  const rec = DATA.maps[key];
  const slug = slugOf(key);

  // A / C 解析成可读文本
  const A2 = (rec.A || []).map(parseAttrs);
  const C2 = (rec.C || []).map(parseConns);

  // BIN 分片：把这张图用到的位图拼在一起，并记录新偏移
  const chunks = [];
  let off = 0;
  let bgOut = null;
  if (rec.bg) {
    const [o, l] = rec.bg;
    chunks.push(BIN.subarray(o, o + l));
    bgOut = [off, l];
    off += l;
  }
  let rbOut = null;
  if (Array.isArray(rec.rb) && rec.rb.length === 2) {
    const [o, l] = rec.rb;
    chunks.push(BIN.subarray(o, o + l));
    rbOut = [off, l];
    off += l;
  }
  const bin = Buffer.concat(chunks);

  const map = { ...rec, A2, C2, bg: bgOut, rb: rbOut };
  delete map.A;
  delete map.C;

  const json = JSON.stringify({
    meta: { ...DATA.meta, maps: 1, key },
    groups: DATA.groups,
    classes: DATA.classes,
    clsHalf: DATA.clsHalf,
    map,
  });

  const jsonBuf = Buffer.from(json, 'utf8');
  const framed = Buffer.alloc(4 + jsonBuf.length + bin.length);
  framed.writeUInt32LE(jsonBuf.length, 0);
  jsonBuf.copy(framed, 4);
  bin.copy(framed, 4 + jsonBuf.length);
  const packed = zlib.gzipSync(framed, { level: GZ_LEVEL });

  fs.writeFileSync(path.join(OUT, 'data', `${slug}.bin`), packed);

  rawTotal += framed.length;
  gzTotal += packed.length;
  if (packed.length > maxRec.bytes) maxRec = { slug, bytes: packed.length };

  catalog.push({
    k: key,
    s: slug,
    m: rec.m,
    i: rec.i,
    cn: rec.cn || '',
    a: rec.a,
    f: rec.f,
    d: rec.d,
    st: rec.st || 0,
    n: rec.n || 0,
    k2: rec.k || 0,
    c: rec.c || {},
    b: rec.b,
    t: (rec.t || []).slice(0, 6),
    bg: !!bgOut,
    rb: !!rbOut,
  });
}

catalog.sort((x, y) => x.a.localeCompare(y.a) || x.m.localeCompare(y.m));
const catalogJson = JSON.stringify({
  meta: DATA.meta,
  groups: DATA.groups,
  count: catalog.length,
  maps: catalog,
});
fs.writeFileSync(path.join(OUT, 'catalog.json'), catalogJson);

console.log(`导出 ${keys.length} 张地图${MODE ? `（模式 ${MODE}）` : ''}`);
console.log(`分片总计  ${(gzTotal / 1048576).toFixed(2)} MB（解压后 ${(rawTotal / 1048576).toFixed(2)} MB）`);
console.log(`最大分片  ${maxRec.slug} = ${(maxRec.bytes / 1024).toFixed(1)} KB`);
console.log(`索引文件  catalog.json = ${(catalogJson.length / 1024).toFixed(1)} KB`);

if (STATS) {
  const byMode = {};
  for (const c of catalog) byMode[c.a] = (byMode[c.a] ?? 0) + 1;
  console.log(`\n按模式： ${JSON.stringify(byMode)}`);
  const withCn = catalog.filter((c) => c.cn).length;
  const withSt = catalog.filter((c) => c.st > 0).length;
  const withRb = catalog.filter((c) => c.rb).length;
  const withBg = catalog.filter((c) => c.bg).length;
  console.log(`中文名 ${withCn} · 有关卡划分 ${withSt} · 有密度底图 ${withBg} · 有雷达图 ${withRb}`);
}
