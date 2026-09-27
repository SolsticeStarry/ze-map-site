import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { buildCatalog } from './build-catalog.mjs';

const LEGACY = 'fyscs/MapTracking-CS2（StarDance 实体 dump）';
const BAKED = 'Source2Viewer default_ents.vents_c';

function shard(root, slug, map, source, classes = ['trigger_teleport']) {
  const json = Buffer.from(JSON.stringify({ meta: { source, built: '2026-09-23 13:04' }, classes, map }));
  const raw = Buffer.alloc(4 + json.length);
  raw.writeUInt32LE(json.length, 0);
  json.copy(raw, 4);
  fs.writeFileSync(path.join(root, 'public/entity/data', `${slug}.bin`), zlib.gzipSync(raw));
}

test('reconciles baked shards, preserves historical metadata, and indexes new maps', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ze-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'public/entity/data'), { recursive: true });
  const indexFile = path.join(root, 'public/entity/catalog.json');
  fs.writeFileSync(indexFile, JSON.stringify({
    meta: { source: LEGACY, built: '2026-09-23 13:04', bg_res: 128 },
    groups: [{ id: 'tele' }, { id: 'break' }], count: 2,
    maps: [
      { k: '2001/ze_known/123', s: '2001-ze_known-123', m: 'ze_known', a: '2001', f: '123', cn: '中文名', d: '2025-01-01', st: 2, n: 7, k2: 4, sourceBuilt: 'old date' },
      { k: '2002/ttt_legacy/789', s: '2002-ttt_legacy-789', m: 'ttt_legacy', a: '2002', f: '789', cn: '旧图', n: 5, k2: 2, c: { tele: 1 }, t: [['trigger_teleport', 1]] },
    ],
  }));
  shard(root, '2001-ze_known-123', { m: 'ze_known', f: '123', n: 3, b: [0, 0, 0, 10, 10, 10], e: [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0], [2, 0, 0, 1, 0]] }, BAKED, ['trigger_teleport', 'func_breakable']);
  shard(root, '2001-ze_new-456', { m: 'ze_new', f: '456', n: 1, b: [0, 0, 0, 1, 1, 1], e: [[0, 0, 0, 0, 0]] }, BAKED);
  shard(root, '2002-ttt_legacy-789', { m: 'ttt_legacy', f: '789', n: 5, b: [0, 0, 0, 1, 1, 1], e: [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0]], bg: [0, 1] }, LEGACY);

  assert.deepEqual(buildCatalog(root), { maps: 3, baked: 2, added: 1 });
  const first = fs.readFileSync(indexFile, 'utf8');
  const index = JSON.parse(first);
  assert.equal(index.meta.entities_all, 9);
  assert.equal(index.meta.entities_kept, 6);
  assert.equal(index.meta.bg_density, 1);
  assert.equal(index.maps[0].cn, '中文名');
  assert.equal(index.maps[0].d, '2025-01-01');
  assert.equal(index.maps[0].n, 3);
  assert.equal(index.maps[0].k2, 3);
  assert.deepEqual(index.maps[0].t, [['trigger_teleport', 2], ['func_breakable', 1]]);
  assert.equal(index.maps[0].sourceBuilt, undefined);
  assert.equal(index.maps[1].k, '2001/ze_new/456');
  assert.equal(index.maps[2].source, LEGACY);
  assert.equal(index.maps[2].sourceBuilt, '2026-09-23 13:04');
  assert.equal(index.maps[2].c.tele, 1);
  assert.deepEqual(buildCatalog(root), { maps: 3, baked: 2, added: 0 });
  assert.equal(fs.readFileSync(indexFile, 'utf8'), first);
});
