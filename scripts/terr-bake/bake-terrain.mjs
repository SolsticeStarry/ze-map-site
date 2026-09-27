import fs from 'node:fs';
import zlib from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';

const src = process.argv[2];
const dst = process.argv[3];
const ERR = parseFloat(process.argv[4] || '2');     // target_error, in source units (inches)
const CLIP_MULT = parseFloat(process.argv[5] || '4'); // hidden clips get this x error
const SCALE = 0.0254;

await MeshoptSimplifier.ready;

const buf = fs.readFileSync(src);
let off = 12, json = null, bin = null; const len = buf.readUInt32LE(8);
while (off < len) { const cl = buf.readUInt32LE(off), ct = buf.readUInt32LE(off + 4); const d = buf.subarray(off + 8, off + 8 + cl); if (ct === 0x4E4F534A) json = JSON.parse(d.toString('utf8')); else if (ct === 0x004E4942) bin = d; off += 8 + cl; }
const g = json;

const clipRe = /npcclip|playerclip|grenadeclip|sky|ladder/i;

// ---- 1) gather per-node world positions (MSH-space) + indices, split main/clip ----
const groups = [
  { name: 'main', pos: [], idx: [] },
  { name: 'clip', pos: [], idx: [] },
];
let tris0 = 0;
for (const node of g.nodes) {
  if (node.mesh == null) continue;
  const mesh = g.meshes[node.mesh];
  if (mesh.primitives.length !== 1) continue;
  const p = mesh.primitives[0];
  const pa = g.accessors[p.attributes.POSITION]; const pbv = g.bufferViews[pa.bufferView];
  const ps = (pbv.byteOffset || 0) + (pa.byteOffset || 0);
  const nv = pa.count;
  const M = node.matrix;
  const grp = clipRe.test(node.name || '') ? groups[1] : groups[0];
  const base = grp.pos.length / 3;
  for (let k = 0; k < nv; k++) {
    const o = ps + k * 3 * 4;
    const gx = bin.readFloatLE(o), gy = bin.readFloatLE(o + 4), gz = bin.readFloatLE(o + 8);
    let wx = gx, wy = gy, wz = gz;
    if (M) { wx = M[0] * gx + M[4] * gy + M[8] * gz + M[12]; wy = M[1] * gx + M[5] * gy + M[9] * gz + M[13]; wz = M[2] * gx + M[6] * gy + M[10] * gz + M[14]; }
    grp.pos.push(wz / SCALE, wx / SCALE, wy / SCALE);
  }
  if (p.indices == null) { for (let k = 0; k < nv; k++) grp.idx.push(base + k); }
  else {
    const ia = g.accessors[p.indices]; const ibv = g.bufferViews[ia.bufferView];
    const is = (ibv.byteOffset || 0) + (ia.byteOffset || 0);
    const ic = { 5121: 1, 5123: 2, 5125: 4 }[ia.componentType];
    for (let k = 0; k < ia.count; k++) {
      const o = is + k * ic;
      const v = ia.componentType === 5121 ? bin.readUInt8(o) : ia.componentType === 5123 ? bin.readUInt16LE(o) : bin.readUInt32LE(o);
      grp.idx.push(base + v);
    }
  }
  tris0 += (p.indices != null ? g.accessors[p.indices].count : nv) / 3;
}

// ---- 2) global bbox -> same grid as final u16 quantization ----
let mn = [1e18, 1e18, 1e18], mx = [-1e18, -1e18, -1e18];
for (const grp of groups) for (let i = 0; i < grp.pos.length; i += 3) for (let a = 0; a < 3; a++) { const v = grp.pos[i + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
const ext = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
const s = [ext[0] / 65535, ext[1] / 65535, ext[2] / 65535];

// ---- 3) weld (grid = final quant grid) + simplify per group ----
function weldAndSimplify(grp, targetError) {
  const pos = new Float32Array(grp.pos);
  const idx0 = new Uint32Array(grp.idx);
  const nv = pos.length / 3;
  const key = (qx, qy, qz) => qx * 4294967296 + qy * 65536 + qz;
  const map = new Map();
  const remap = new Uint32Array(nv);
  const wpos = [];
  let nw = 0;
  for (let i = 0; i < nv; i++) {
    const qx = Math.max(0, Math.min(65535, Math.round((pos[i * 3] - mn[0]) / s[0])));
    const qy = Math.max(0, Math.min(65535, Math.round((pos[i * 3 + 1] - mn[1]) / s[1])));
    const qz = Math.max(0, Math.min(65535, Math.round((pos[i * 3 + 2] - mn[2]) / s[2])));
    const k = key(qx, qy, qz);
    let id = map.get(k);
    if (id === undefined) { id = nw++; map.set(k, id); wpos.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); }
    remap[i] = id;
  }
  const widx0 = new Uint32Array(idx0.length);
  for (let i = 0; i < idx0.length; i++) widx0[i] = remap[idx0[i]];
  const wposArr = new Float32Array(wpos);
  const before = widx0.length / 3;
  const [sidx, serr] = MeshoptSimplifier.simplify(widx0, wposArr, 3, 0, targetError, ['ErrorAbsolute']);
  return { pos: wposArr, idx: sidx, before, after: sidx.length / 3, err: serr };
}

const main = weldAndSimplify(groups[0], ERR);
const clip = weldAndSimplify(groups[1], ERR * CLIP_MULT);

// ---- 4) combine simplified meshes ----
const allPos = new Float32Array(main.pos.length + clip.pos.length);
allPos.set(main.pos, 0); allPos.set(clip.pos, main.pos.length);
const offC = main.pos.length / 3;
const allIdx = new Uint32Array(main.idx.length + clip.idx.length);
allIdx.set(main.idx, 0);
for (let i = 0; i < clip.idx.length; i++) allIdx[main.idx.length + i] = clip.idx[i] + offC;

// ---- 5) final u16 quantize + dedup + write MSH1 (same as glb2msh) ----
const key = (qx, qy, qz) => qx * 4294967296 + qy * 65536 + qz;
const vertMap = new Map();
const qverts = [];
const outIdx = [];
for (let t = 0; t < allIdx.length; t++) {
  const vi = allIdx[t] * 3;
  const qx = Math.max(0, Math.min(65535, Math.round((allPos[vi] - mn[0]) / s[0])));
  const qy = Math.max(0, Math.min(65535, Math.round((allPos[vi + 1] - mn[1]) / s[1])));
  const qz = Math.max(0, Math.min(65535, Math.round((allPos[vi + 2] - mn[2]) / s[2])));
  const kk = key(qx, qy, qz);
  let id = vertMap.get(kk);
  if (id === undefined) { id = qverts.length / 3; qverts.push(qx, qy, qz); vertMap.set(kk, id); }
  outIdx.push(id);
}
const nv = qverts.length / 3, nt = outIdx.length / 3;
const u16i = nv <= 65535 ? 1 : 0;
const header = Buffer.alloc(40);
header.write('MSH1', 0, 'ascii');
header.writeUInt32LE(nv, 4); header.writeUInt32LE(nt, 8); header.writeUInt32LE(u16i, 12);
header.writeFloatLE(mn[0], 16); header.writeFloatLE(mn[1], 20); header.writeFloatLE(mn[2], 24);
header.writeFloatLE(s[0], 28); header.writeFloatLE(s[1], 32); header.writeFloatLE(s[2], 36);
const vbuf = Buffer.alloc(nv * 6);
for (let i = 0; i < nv * 3; i++) vbuf.writeUInt16LE(qverts[i], i * 2);
let ibuf, pad = Buffer.alloc(0);
if (u16i) { ibuf = Buffer.alloc(nt * 3 * 2); for (let i = 0; i < nt * 3; i++) ibuf.writeUInt16LE(outIdx[i], i * 2); }
else { pad = Buffer.alloc((4 - ((40 + nv * 6) % 4)) % 4); ibuf = Buffer.alloc(nt * 3 * 4); for (let i = 0; i < nt * 3; i++) ibuf.writeUInt32LE(outIdx[i], i * 4); }
const raw = Buffer.concat([header, vbuf, pad, ibuf]);
const gz = zlib.gzipSync(raw, { level: 9 });
fs.writeFileSync(dst, gz);
console.log(`err=${ERR}(clip x${CLIP_MULT})  tris ${Math.round(tris0)} -> main ${main.after}(e${main.err.toFixed(2)}) + clip ${clip.after}(e${clip.err.toFixed(2)})  nv ${nv} nt ${nt} u16i ${u16i}  raw ${(raw.length / 1e6).toFixed(2)}MB gzip ${(gz.length / 1e6).toFixed(2)}MB`);
