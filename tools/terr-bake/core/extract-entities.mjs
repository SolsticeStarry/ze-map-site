#!/usr/bin/env node
import fs from 'node:fs';

const [src, dst, mapId, mode] = process.argv.slice(2);
if (!src || !dst || !mapId) throw new Error('usage: node extract-entities.mjs <decompiled.txt> <out.json> <mapId> [--bounds-only]');

const text = fs.readFileSync(src, 'utf8');
const blocks = text.split(/^====\d+====\s*$/m).slice(1);
const unquote = (v) => {
  v = v.trim();
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"');
  return v;
};
const vec = (v) => {
  const m = v.match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  return m && m.length >= 3 ? m.slice(0, 3).map(Number) : null;
};
const entities = [];
const bounds = [];

for (const block of blocks) {
  const p = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s+(.*)$/);
    if (m && p[m[1]] === undefined) p[m[1]] = unquote(m[2]);
  }
  const origin = vec(p.origin || '');
  const classname = p.classname;
  if (!classname || !origin) continue;
  const mins = vec(p.box_mins || '');
  const maxs = vec(p.box_maxs || '');
  let bb = null;
  if (mins && maxs) {
    bb = {
      center: origin.map((v, i) => v + (mins[i] + maxs[i]) / 2),
      half: mins.map((v, i) => Math.abs(maxs[i] - v) / 2),
      mins,
      maxs,
    };
  }
  const entity = {
    classname,
    origin,
    targetname: p.targetname || '',
    model: p.model || '',
    angles: vec(p.angles || '') || [0, 0, 0],
    bounds: bb,
  };
  entities.push(entity);
  if (bb) bounds.push({ index: entities.length - 1, classname, origin, ...bb });
}

const out = mode === '--bounds-only'
  ? { version: 1, source: 'Source2Viewer default_ents.vents_c', mapId, bounds }
  : { version: 1, source: 'Source2Viewer default_ents.vents_c', mapId, entities };
fs.writeFileSync(dst, JSON.stringify(out));
console.log(`entities=${entities.length} bounds=${bounds.length}`);
