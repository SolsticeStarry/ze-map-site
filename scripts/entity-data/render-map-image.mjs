#!/usr/bin/env node
/**
 * 用实体数据生成地图俯视分布图（PNG），并给出可用的热点坐标。
 *
 *   node scripts/entity-data/render-map-image.mjs \
 *     --slug 2001-ze_ffvii_mako_reactor_v6_p-3273375829 \
 *     --out public/images/maps/ze_ffvii_mako_reactor/overview.png \
 *     --size 1200
 *
 * 输出：PNG 文件 + 终端里的热点百分比坐标（可直接粘进 MDX 的 <RouteMap hotspots={...} />）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const SLUG = opt('slug');
const OUT = opt('out');
const SIZE = Number(opt('size', 1100));
if (!SLUG || !OUT) {
  console.error('用法: --slug <分片名> --out <png 路径> [--size 1100]');
  process.exit(1);
}

/* ---------- 读分片 ---------- */
const binFile = path.join(ROOT, 'public/entity/data', `${SLUG}.bin`);
const raw = zlib.gunzipSync(fs.readFileSync(binFile));
const jlen = raw.readUInt32LE(0);
const payload = JSON.parse(raw.subarray(4, 4 + jlen).toString('utf8'));
const BIN = raw.subarray(4 + jlen);
const m = payload.map;
const groups = Object.fromEntries(payload.groups.map((g) => [g.id, g]));

/* ---------- 世界 → 图像坐标 ---------- */
const bb = m.fb || m.b;
const [minX, minY, , maxX, maxY] = [bb[0], bb[1], bb[2], bb[3], bb[4]];
const pad = 0.02;
const spanX = (maxX - minX) * (1 + pad * 2);
const spanY = (maxY - minY) * (1 + pad * 2);
const W = SIZE;
const H = Math.round(SIZE * (spanY / spanX));
const toPx = (x, y) => [
  ((x - minX + spanX * pad / 2) / spanX) * W,
  ((maxY - y + spanY * pad / 2) / spanY) * H,
];

/* ---------- 画布 ---------- */
const canvas = Buffer.alloc(W * H * 4);
const setPx = (px, py, r, g, b, a) => {
  if (px < 0 || py < 0 || px >= W || py >= H) return;
  const i = (py * W + px) * 4;
  const na = a / 255;
  canvas[i] = Math.round(canvas[i] * (1 - na) + r * na);
  canvas[i + 1] = Math.round(canvas[i + 1] * (1 - na) + g * na);
  canvas[i + 2] = Math.round(canvas[i + 2] * (1 - na) + b * na);
  canvas[i + 3] = 255;
};
// 底色
for (let i = 0; i < canvas.length; i += 4) {
  canvas[i] = 6; canvas[i + 1] = 7; canvas[i + 2] = 11; canvas[i + 3] = 255;
}

/* ---------- 密度底图（128×128，2bit/像素，双线性放大） ---------- */
if (m.bg) {
  const u8 = BIN.subarray(m.bg[0], m.bg[0] + m.bg[1]);
  const R = payload.meta.bg_res || 128;
  const lv = (ix, iy) => {
    ix = Math.max(0, Math.min(R - 1, ix)); iy = Math.max(0, Math.min(R - 1, iy));
    const i = iy * R + ix;
    return (u8[i >> 2] >> ((i & 3) * 2)) & 3;
  };
  const tint = [[0, 0, 0, 0], [96, 106, 138, 105], [138, 152, 190, 165], [196, 208, 240, 225]];
  for (let py = 0; py < H; py++) {
    const fy = (py / H) * R - 0.5;
    const y0 = Math.floor(fy), ty = fy - y0;
    for (let px = 0; px < W; px++) {
      const fx = (px / W) * R - 0.5;
      const x0 = Math.floor(fx), tx = fx - x0;
      const v =
        lv(x0, y0) * (1 - tx) * (1 - ty) + lv(x0 + 1, y0) * tx * (1 - ty) +
        lv(x0, y0 + 1) * (1 - tx) * ty + lv(x0 + 1, y0 + 1) * tx * ty;
      if (v < 0.12) continue;
      const t = Math.max(0, Math.min(3, v));
      const lo = Math.floor(t), hi = Math.min(3, lo + 1), f = t - lo;
      const c = [0, 1, 2, 3].map((k) => tint[lo][k] * (1 - f) + tint[hi][k] * f);
      setPx(px, py, c[0], c[1], c[2], c[3]);
    }
  }
}

/* ---------- 实体点 ---------- */
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
// 画点顺序：环境点先画，玩法实体后画（覆盖在上面）
const order = ['env', 'prop', 'item', 'spawn', 'logic', 'misc', 'path', 'trig', 'mech', 'hurt', 'break', 'tele'];
const pts = [];
for (const e of m.e) {
  const gid = payload.groups.find((g) => g.id === groupOf(payload.classes[e[3]]))?.id;
  pts.push({ x: e[0], y: e[1], z: e[2], gid });
}
function groupOf(cn) {
  const RULES = [
    ['tele', ['trigger_teleport', 'point_teleport', 'info_teleport_destination']],
    ['break', ['func_breakable', 'func_physbox', 'prop_physics']],
    ['hurt', ['trigger_hurt', 'env_fire', 'env_explosion', 'trigger_ignite', 'trigger_waterydeath']],
    ['trig', ['trigger_']],
    ['mech', ['func_button', 'func_door', 'prop_door_rotating', 'func_movelinear', 'func_rotating', 'func_wall_toggle', 'func_tracktrain', 'phys_thruster', 'func_water', 'func_brush', 'func_wall', 'func_']],
    ['path', ['path_']],
    ['spawn', ['info_player_']],
    ['item', ['weapon_', 'item_', 'game_']],
    ['prop', ['prop_']],
    ['logic', ['logic_', 'math_', 'point_', 'env_entity_maker', 'game_player_equip']],
  ];
  for (const [gid, pats] of RULES) for (const p of pats) if (cn.startsWith(p)) return gid;
  if (/^(light_|info_particle|env_|point_sound|ambient_|snd_|sky_|shadow_|color_|water_lod|worldspawn|filter_|cable_|post_processing|cs_minimap)/.test(cn)) return 'env';
  return 'misc';
}
const R = Math.max(2, Math.round(SIZE / 420));
for (const gid of order) {
  const g = groups[gid];
  if (!g) continue;
  const [r, gg, b] = hex(g.color);
  const alpha = gid === 'env' ? 90 : 235;
  for (const p of pts) {
    if (p.gid !== gid) continue;
    const [px, py] = toPx(p.x, p.y);
    const rad = gid === 'env' ? 1 : R;
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++) {
        if (dx * dx + dy * dy > rad * rad) continue;
        setPx(Math.round(px) + dx, Math.round(py) + dy, r, gg, b, alpha);
      }
  }
}

/* ---------- 输出（含图例） ---------- */
fs.mkdirSync(path.dirname(path.resolve(ROOT, OUT)), { recursive: true });

const counts = {};
for (const p of pts) counts[p.gid] = (counts[p.gid] || 0) + 1;
const legend = order
  .filter((gid) => counts[gid] && gid !== 'env' && gid !== 'misc')
  .sort((a, b) => counts[b] - counts[a])
  .slice(0, 8);
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const rowH = 25;
const boxH = 34 + legend.length * rowH + 26;
const boxW = Math.min(360, Math.round(W * 0.42));
const boxY = H - boxH - 18;
const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
<style>text{font-family:'Microsoft YaHei','PingFang SC','Segoe UI',sans-serif}</style>
<rect x="18" y="${boxY}" width="${boxW}" height="${boxH}" rx="12" fill="rgba(6,7,11,0.78)" stroke="#2a3040"/>
<text x="${18 + 16}" y="${boxY + 24}" fill="#e6e9f0" font-size="${Math.round(SIZE / 62)}" font-weight="700">${esc(m.cn || m.m)}</text>
${legend
  .map(
    (gid, i) =>
      `<circle cx="${18 + 22}" cy="${boxY + 44 + i * rowH}" r="${Math.round(SIZE / 190)}" fill="${groups[gid].color}"/>` +
      `<text x="${18 + 36}" y="${boxY + 49 + i * rowH}" fill="#cfd6e4" font-size="${Math.round(SIZE / 84)}">${esc(groups[gid].label)} ${counts[gid]}</text>`
  )
  .join('')}
<text x="${18 + 16}" y="${boxY + boxH - 10}" fill="#6b7280" font-size="${Math.round(SIZE / 100)}">${esc(m.m)} · 实体 ${m.n} · CS2 服务端 dump ${esc(m.d || '')}</text>
</svg>`;

await sharp(canvas, { raw: { width: W, height: H, channels: 4 } })
  .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
  .png({ compressionLevel: 9, palette: true })
  .toFile(path.resolve(ROOT, OUT));

const pct = (x, y) => {
  const [px, py] = toPx(x, y);
  return [ +((px / W) * 100).toFixed(1), +((py / H) * 100).toFixed(1) ];
};
const centroid = (gid) => {
  const sel = pts.filter((p) => p.gid === gid);
  if (!sel.length) return null;
  const cx = sel.reduce((a, p) => a + p.x, 0) / sel.length;
  const cy = sel.reduce((a, p) => a + p.y, 0) / sel.length;
  return { n: sel.length, at: pct(cx, cy) };
};

console.log(`地图      ${m.cn || m.m}（${m.m}）`);
console.log(`输出      ${OUT}  ${W}×${H}  ${(fs.statSync(path.resolve(ROOT, OUT)).size / 1024).toFixed(0)} KB`);
console.log(`包围盒    x ${bb[0]}..${bb[3]}  y ${bb[1]}..${bb[4]}  z ${bb[2]}..${bb[5]}`);
console.log(`实体点    ${pts.length}`);
console.log('\n热点参考（百分比坐标，可直接用于 <RouteMap hotspots={[{x,y,label,desc}]} />）：');
const label = { spawn: '出生点', tele: '传送门密集区', mech: '机关 / 门密集区', hurt: '危险区', break: '可破坏物密集区', path: '路径点' };
for (const gid of ['spawn', 'tele', 'mech', 'hurt', 'break', 'path']) {
  const c = centroid(gid);
  if (c) console.log(`  ${label[gid].padEnd(14)} x=${c.at[0]}%  y=${c.at[1]}%   （${c.n} 个点）`);
}
if (m.zq && m.st > 0) {
  const [z0, z1, z2, z3, z4] = m.zq;
  console.log(`  关卡包围盒      x ${z0}..${z3}  y ${z1}..${z4}`);
}
