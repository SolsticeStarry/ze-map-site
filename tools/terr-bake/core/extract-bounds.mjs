#!/usr/bin/env node
/**
 * 按实体推导真实包围盒（世界轴对齐，Source 单位）。
 *
 * 用法：
 *   node extract-bounds.mjs <entities.json> <modelsDir> <out.json>
 *
 * 优先级：
 *   1. 实体自带 box_mins/box_maxs（点/体积实体，如 light_probe_volume）；
 *   2. entity.model 指向的刷子模型（maps/<map>/entities/<name>_<id>.vmdl），
 *      从导出的 <name>_<id>_physics.glb（退化到 .glb）里取 POSITION 顶点并集，
 *      按 node 矩阵 + 轴换算成 Source 单位，再叠加实体 origin；
 *   3. 都没有 → 不产出（留给 build-entity-bin.mjs 的 clsHalf 回退）。
 *
 * 输出的 bounds 数组与 extract-entities.mjs --bounds-only 保持同一结构。
 */
import fs from 'node:fs';
import path from 'node:path';

const [entityFile, modelsDir, outFile] = process.argv.slice(2);
if (!entityFile || !modelsDir || !outFile) {
  throw new Error('usage: node extract-bounds.mjs <entities.json> <modelsDir> <out.json>');
}

const SCALE = 0.0254; // glTF 米 → Source 单位

/* glTF 世界坐标 (wx, wy, wz) → Source (x, y, z)，与 bake-terrain.mjs 一致 */
const toSource = (wx, wy, wz) => [wz / SCALE, wx / SCALE, wy / SCALE];

function readGlbBounds(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) return null; // 'glTF'
  let off = 12;
  let json = null;
  const total = buf.length;
  while (off + 8 <= total) {
    const cl = buf.readUInt32LE(off);
    const ct = buf.readUInt32LE(off + 4);
    if (ct === 0x4e4f534a) { json = JSON.parse(buf.subarray(off + 8, off + 8 + cl).toString('utf8')); break; }
    off += 8 + cl;
  }
  if (!json) return null;

  let mn = [Infinity, Infinity, Infinity];
  let mx = [-Infinity, -Infinity, -Infinity];
  const applyMat = (M, x, y, z) => (M
    ? [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]]
    : [x, y, z]);

  for (const node of json.nodes || []) {
    if (node.mesh == null) continue;
    const mesh = json.meshes[node.mesh];
    if (!mesh) continue;
    for (const prim of mesh.primitives || []) {
      const acc = json.accessors[prim.attributes?.POSITION];
      if (!acc || !acc.min || !acc.max) continue;
      const M = node.matrix;
      for (let c = 0; c < 8; c++) {
        const x = c & 1 ? acc.max[0] : acc.min[0];
        const y = c & 2 ? acc.max[1] : acc.min[1];
        const z = c & 4 ? acc.max[2] : acc.min[2];
        const [sx, sy, sz] = toSource(...applyMat(M, x, y, z));
        mn[0] = Math.min(mn[0], sx); mn[1] = Math.min(mn[1], sy); mn[2] = Math.min(mn[2], sz);
        mx[0] = Math.max(mx[0], sx); mx[1] = Math.max(mx[1], sy); mx[2] = Math.max(mx[2], sz);
      }
    }
  }
  if (!Number.isFinite(mn[0]) || mx[0] < mn[0]) return null;
  return { mn, mx };
}

/* 索引 modelsDir 下所有 glb：按相对路径（去扩展名）与 basename 建表 */
function indexModels(dir) {
  const byPath = new Map();
  const byBase = new Map();
  const walk = (d) => {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full);
      else if (/\.glb$/i.test(it.name)) {
        const rel = path.relative(dir, full).replace(/\\/g, '/');
        const key = rel.replace(/\.glb$/i, '').replace(/_physics$/i, '');
        byPath.set(key.toLowerCase(), full);
        const base = path.basename(key).toLowerCase();
        if (!byBase.has(base)) byBase.set(base, full);
      }
    }
  };
  walk(dir);
  return { byPath, byBase };
}

const src = JSON.parse(fs.readFileSync(entityFile, 'utf8'));
const entities = src.entities || [];
const models = indexModels(modelsDir);

const normModel = (m) => {
  let s = String(m || '').trim();
  /* vents dump 有两种写法： "maps\\<map>\\entities\\x.vmdl" 与 resource_name:"maps/<map>/entities/x.vmdl" */
  const rn = s.match(/resource_name\s*:\s*"([^"]*)"/i);
  if (rn) s = rn[1];
  return s.replace(/\\+/g, '/').replace(/^"+|"+$/g, '').replace(/\.vmdl$/i, '').toLowerCase();
};

const bounds = [];
let fromDump = 0;
let fromModel = 0;
for (let i = 0; i < entities.length; i++) {
  const x = entities[i];
  let center = null;
  let half = null;
  let kind = null;

  if (x.bounds && x.bounds.mins && x.bounds.maxs) {
    const c = x.origin.map((v, k) => v + (x.bounds.mins[k] + x.bounds.maxs[k]) / 2);
    const h = x.bounds.mins.map((v, k) => Math.abs(x.bounds.maxs[k] - v) / 2);
    center = c; half = h; kind = 'dump'; fromDump++;
  } else if (x.model) {
    const key = normModel(x.model);
    const file = models.byPath.get(key) || models.byBase.get(path.basename(key));
    if (file) {
      const g = readGlbBounds(file);
      if (g) {
        center = x.origin.map((v, k) => v + (g.mn[k] + g.mx[k]) / 2);
        half = g.mn.map((v, k) => (g.mx[k] - v) / 2);
        kind = 'model'; fromModel++;
      }
    }
  }

  if (center && half) {
    bounds.push({
      index: i,
      classname: x.classname,
      origin: x.origin,
      center,
      half,
      mins: center.map((v, k) => v - half[k]),
      maxs: center.map((v, k) => v + half[k]),
      src: kind,
    });
  }
}

fs.writeFileSync(outFile, JSON.stringify({
  version: 1,
  source: 'entities + model physics GLB',
  mapId: src.mapId,
  bounds,
}));
console.log(`bounds=${bounds.length} (dump=${fromDump} model=${fromModel}) of ${entities.length} entities`);
