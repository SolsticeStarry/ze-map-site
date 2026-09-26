#!/usr/bin/env node
import fs from 'node:fs';
import zlib from 'node:zlib';

const [entityFile, boundsFile, outFile, mapName, workshopId] = process.argv.slice(2);
if (!entityFile || !boundsFile || !outFile || !mapName || !workshopId) {
  throw new Error('usage: node build-entity-bin.mjs <entities.json> <bounds.json> <out.bin> <mapName> <workshopId>');
}

const source = JSON.parse(fs.readFileSync(entityFile, 'utf8'));
const boundSource = JSON.parse(fs.readFileSync(boundsFile, 'utf8'));
const entities = source.entities || [];
const byIndex = new Map((boundSource.bounds || []).map((x) => [x.index, x]));
const classes = [...new Set(entities.map((x) => x.classname))];
const classIndex = new Map(classes.map((x, i) => [x, i]));

const groups = [
  ['tele', '传送门', '#22d3ee'], ['break', '可破坏物', '#f59e0b'],
  ['hurt', '伤害区', '#ef4444'], ['trig', '触发器', '#a78bfa'],
  ['mech', '机关', '#f97316'], ['path', '路径', '#34d399'],
  ['logic', '逻辑', '#c084fc'], ['spawn', '出生点', '#fde047'],
  ['item', '道具', '#60a5fa'], ['prop', '模型', '#fb7185'],
  ['env', '环境', '#94a3b8'], ['misc', '其他', '#a8b2c4'],
].map(([id, label, color]) => ({ id, label, color, r: 1 }));

function stageOf(name) {
  const m = String(name || '').match(/(?:stage|level|lvl)[ _-]*(\d+)/i);
  return m ? Number(m[1]) : 0;
}
function groupOf(cn) {
  if (/teleport/i.test(cn)) return 'tele';
  if (/breakable|physbox|prop_physics/i.test(cn)) return 'break';
  if (/hurt|fire|explosion|ignite|waterydeath/i.test(cn)) return 'hurt';
  if (/trigger_|ladder|illusionary/i.test(cn)) return 'trig';
  if (/button|door|movelinear|rotating|tracktrain|func_wall|func_brush|water/i.test(cn)) return 'mech';
  if (/^path_/i.test(cn)) return 'path';
  if (/^logic_|^math_|^point_/i.test(cn)) return 'logic';
  if (/^info_player_/i.test(cn)) return 'spawn';
  if (/^(weapon_|item_|game_)/i.test(cn)) return 'item';
  if (/^prop_/i.test(cn)) return 'prop';
  if (/^(light_|env_|info_|worldspawn|cs_minimap|sky_|shadow_)/i.test(cn)) return 'env';
  return 'misc';
}

const e = [];
const bb = [];
const bbm = [];
const halvesByClass = new Map();
const counts = Object.fromEntries(groups.map((g) => [g.id, 0]));
let mn = [Infinity, Infinity, Infinity];
let mx = [-Infinity, -Infinity, -Infinity];
const touch = (p, h) => {
  for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], p[i] - h[i]); mx[i] = Math.max(mx[i], p[i] + h[i]); }
};

for (let i = 0; i < entities.length; i++) {
  const x = entities[i];
  const ci = classIndex.get(x.classname);
  const stage = stageOf(x.targetname);
  const b = byIndex.get(i);
  const item = [x.origin[0], x.origin[1], x.origin[2], ci];
  if (x.targetname) item.push(x.targetname);
  item.push(stage);
  e.push(item);
  const gid = groupOf(x.classname); counts[gid]++;
  if (b) {
    const center = b.center, half = b.half;
    const at = bb.length / 6;
    for (let k = 0; k < 3; k++) bb.push(Math.round(center[k] * 10));
    for (let k = 0; k < 3; k++) bb.push(Math.round(half[k] * 10));
    bbm.push(at);
    /* Map framing (b/fb) stays on origins ± typical size: a single huge brush volume
       (func_water / big triggers) would otherwise blow up the camera bounds. */
    touch(x.origin, [30, 30, 30]);
    const arr = halvesByClass.get(x.classname);
    if (arr) arr.push(half); else halvesByClass.set(x.classname, [half]);
  } else {
    bbm.push(-1); touch(x.origin, [30, 30, 30]);
  }
}

if (!Number.isFinite(mn[0])) mn = [0, 0, 0], mx = [1, 1, 1];
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const clsHalf = classes.map((cn) => {
  const arr = halvesByClass.get(cn);
  if (!arr || !arr.length) return [30, 30, 30];
  return [0, 1, 2].map((k) => Math.round(median(arr.map((h) => h[k])) * 10) / 10);
});
const map = {
  m: mapName, i: mapName, f: workshopId, cn: mapName, n: e.length, k: e.length,
  e, b: [...mn, ...mx], fb: [...mn, ...mx], bb, bbm,
  A2: [], C2: [], c: counts, t: classes.slice(0, 6), st: 0,
};
const payload = {
  meta: { maps: 1, entities_all: e.length, entities_kept: e.length, source: 'Source2Viewer default_ents.vents_c' },
  groups, classes, clsHalf, map,
};
const json = Buffer.from(JSON.stringify(payload));
const raw = Buffer.alloc(4 + json.length);
raw.writeUInt32LE(json.length, 0); json.copy(raw, 4);
fs.writeFileSync(outFile, zlib.gzipSync(raw, { level: 9 }));
console.log(`map=${mapName} entities=${e.length} realBounds=${bbm.filter((x) => x >= 0).length}`);
