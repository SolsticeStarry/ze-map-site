#!/usr/bin/env node
/**
 * 批量生成地图卡片封面（16:9 WebP）：密度底图/雷达 + 实体点，装入固定画幅不裁剪。
 *
 *   node scripts/entity-data/render-covers.mjs                 # 全部 ZE 地图
 *   node scripts/entity-data/render-covers.mjs --limit 20      # 只渲染前 20 张（调试）
 *   node scripts/entity-data/render-covers.mjs --width 640 --quality 74
 *
 * 产物：public/images/covers/<entitySlug>.webp
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  ROOT, readPayload, collectPoints, makeCanvas, makeProjector, drawDensity, drawPoints,
} from './lib/entity-common.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const W = Number(opt('width', 640));
const H = Math.round(W * 9 / 16);
const QUALITY = Number(opt('quality', 74));
const LIMIT = Number(opt('limit', 0));
const MODE = opt('mode', '2001');
const OUT_DIR = path.join(ROOT, 'public/images/covers');

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/entity/catalog.json'), 'utf8'));
let maps = catalog.maps.filter((m) => !MODE || m.a === MODE);
if (LIMIT) maps = maps.slice(0, LIMIT);

fs.mkdirSync(OUT_DIR, { recursive: true });
console.log(`渲染 ${maps.length} 张封面 → public/images/covers/  ${W}×${H} webp q${QUALITY}`);

let done = 0, skipped = 0, total = 0, degenerate = 0, failed = 0;
const t0 = Date.now();

for (const cat of maps) {
  const out = path.join(OUT_DIR, `${cat.s}.webp`);
  if (fs.existsSync(out) && !argv.includes('--force')) { skipped++; continue; }

  try {
  let payload, BIN, m;
  try {
    ({ payload, BIN, map: m } = readPayload(cat.s));
  } catch (e) {
    console.warn(`  ! ${cat.s}: ${e.message}`);
    failed++;
    continue;
  }
  if (!m.e || m.e.length === 0) { failed++; continue; }

  const bb = m.fb || m.b;
  let worldW = bb[3] - bb[0], worldH = bb[4] - bb[1];
  if (!Number.isFinite(worldW) || !Number.isFinite(worldH) || worldW <= 1 || worldH <= 1) {
    // 少数图实体极少/包围盒退化：用实体点位自己撑一个范围
    const xs = m.e.map((e) => e[0]), ys = m.e.map((e) => e[1]);
    const x0 = Math.min(...xs, 0), x1 = Math.max(...xs, 1);
    const y0 = Math.min(...ys, 0), y1 = Math.max(...ys, 1);
    bb[0] = x0; bb[1] = y0; bb[3] = x1; bb[4] = y1;
    worldW = Math.max(1, x1 - x0);
    worldH = Math.max(1, y1 - y0);
    degenerate++;
  }
  // 按 object-fit: cover 的思路铺满 16:9，再居中裁切——卡片上就是满幅封面
  const scale = Math.max(W / worldW, H / worldH);
  const drawW = Math.max(W, Math.round(worldW * scale));
  const drawH = Math.max(H, Math.round(worldH * scale));
  const offX = Math.round((drawW - W) / 2);
  const offY = Math.round((drawH - H) / 2);

  const full = makeCanvas(drawW, drawH);
  drawDensity(full, drawW, drawH, payload, BIN, m);
  const toPx = makeProjector(bb, drawW, drawH, 0.02);
  const groups = Object.fromEntries(payload.groups.map((g) => [g.id, g]));
  // 封面只画玩法实体：环境点就是底图本身，画上去只会糊
  const pts = collectPoints(payload, m).filter((p) => p.gid !== 'env' && p.gid !== 'misc');
  drawPoints(full, drawW, drawH, pts, groups, toPx, Math.max(1, Math.round(W / 420)));

  // 居中裁切出 16:9 画幅
  const canvas = makeCanvas(W, H);
  for (let y = 0; y < H; y++) {
    const src = ((y + offY) * drawW + offX) * 4;
    const dst = y * W * 4;
    full.copy(canvas, dst, src, src + W * 4);
  }

  await sharp(canvas, { raw: { width: W, height: H, channels: 4 } })
    .webp({ quality: QUALITY, effort: 4 })
    .toFile(out);

  total += fs.statSync(out).size;
  done++;
  if (done % 50 === 0) console.log(`  已渲染 ${done}/${maps.length}…`);
  } catch (e) {
    failed++;
    console.warn(`  ! ${cat.s} 渲染失败：${e.message}`);
  }
}

console.log(`\n完成：渲染 ${done} · 跳过已存在 ${skipped} · 退化包围盒 ${degenerate} · 失败 ${failed} · 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (done) console.log(`平均 ${(total / done / 1024).toFixed(1)} KB/张，合计 ${(total / 1048576).toFixed(2)} MB`);
console.log(`目录：public/images/covers/（共 ${fs.readdirSync(OUT_DIR).length} 个文件）`);
