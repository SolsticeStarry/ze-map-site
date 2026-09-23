/**
 * 实体数据渲染的公共部分：读取分片、classname → 图层分类、绘制用的工具。
 * 被 render-map-image.mjs（单图分布图）与 render-covers.mjs（批量卡片封面）共用。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** 读取 public/entity/data/<slug>.bin（格式：[4B JSON 长度][JSON][BIN]，整体 gzip） */
export function readPayload(slug) {
  const file = path.join(ROOT, 'public/entity/data', `${slug}.bin`);
  const raw = zlib.gunzipSync(fs.readFileSync(file));
  const jlen = raw.readUInt32LE(0);
  const payload = JSON.parse(raw.subarray(4, 4 + jlen).toString('utf8'));
  return { payload, BIN: raw.subarray(4 + jlen), map: payload.map };
}

/* 类别 → 图层（与 viewer 里的 RULES 保持一致，按顺序匹配） */
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
const ENV_RE = /^(light_|info_particle|env_|point_sound|ambient_|snd_|sky_|shadow_|color_|water_lod|worldspawn|filter_|cable_|post_processing|cs_minimap)/;

export function classify(classname) {
  for (const [gid, pats] of RULES) for (const p of pats) if (classname.startsWith(p)) return gid;
  if (ENV_RE.test(classname)) return 'env';
  return 'misc';
}

/* 绘制顺序：环境点先画，玩法实体后画（覆盖在上面） */
export const DRAW_ORDER = ['env', 'prop', 'item', 'spawn', 'logic', 'misc', 'path', 'trig', 'mech', 'hurt', 'break', 'tele'];

export const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export function makeCanvas(W, H, bg = [6, 7, 11]) {
  const buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = bg[0]; buf[i + 1] = bg[1]; buf[i + 2] = bg[2]; buf[i + 3] = 255;
  }
  return buf;
}

export function setPx(canvas, W, H, px, py, r, g, b, a) {
  px = Math.round(px); py = Math.round(py);
  if (px < 0 || py < 0 || px >= W || py >= H) return;
  const i = (py * W + px) * 4;
  const na = a / 255;
  canvas[i] = Math.round(canvas[i] * (1 - na) + r * na);
  canvas[i + 1] = Math.round(canvas[i + 1] * (1 - na) + g * na);
  canvas[i + 2] = Math.round(canvas[i + 2] * (1 - na) + b * na);
  canvas[i + 3] = 255;
}

/** 世界坐标 → 画布坐标（+y 朝上，北在上） */
export function makeProjector(bb, W, H, pad = 0.02) {
  const [minX, minY, , maxX, maxY] = [bb[0], bb[1], bb[2], bb[3], bb[4]];
  const spanX = (maxX - minX) * (1 + pad * 2);
  const spanY = (maxY - minY) * (1 + pad * 2);
  return (x, y) => [
    ((x - minX + (spanX * pad) / 2) / spanX) * W,
    ((maxY - y + (spanY * pad) / 2) / spanY) * H,
  ];
}

/** 密度底图（128×128，每像素 2bit），双线性放大 */
export function drawDensity(canvas, W, H, payload, BIN, m, tint = [[0, 0, 0, 0], [96, 106, 138, 105], [138, 152, 190, 165], [196, 208, 240, 225]]) {
  if (!m.bg) return false;
  const u8 = BIN.subarray(m.bg[0], m.bg[0] + m.bg[1]);
  const R = payload.meta.bg_res || 128;
  const lv = (ix, iy) => {
    ix = Math.max(0, Math.min(R - 1, ix)); iy = Math.max(0, Math.min(R - 1, iy));
    const i = iy * R + ix;
    return (u8[i >> 2] >> ((i & 3) * 2)) & 3;
  };
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
      setPx(canvas, W, H, px, py, c[0], c[1], c[2], c[3]);
    }
  }
  return true;
}

/** 收集实体点（含所属图层） */
export function collectPoints(payload, m) {
  const pts = [];
  for (const e of m.e) pts.push({ x: e[0], y: e[1], z: e[2], gid: classify(payload.classes[e[3]]) });
  return pts;
}

export function drawPoints(canvas, W, H, pts, groups, toPx, radius) {
  for (const gid of DRAW_ORDER) {
    const g = groups[gid];
    if (!g) continue;
    const [r, gg, b] = hex2rgb(g.color);
    const alpha = gid === 'env' ? 90 : 235;
    const rad = gid === 'env' ? Math.max(1, radius - 1) : radius;
    for (const p of pts) {
      if (p.gid !== gid) continue;
      const [px, py] = toPx(p.x, p.y);
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          if (dx * dx + dy * dy > rad * rad) continue;
          setPx(canvas, W, H, px + dx, py + dy, r, gg, b, alpha);
        }
      }
    }
  }
}

export const sb = (s) => String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
