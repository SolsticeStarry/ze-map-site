#!/usr/bin/env node
/**
 * 把 GFL 配置的文件名对到站点地图名上。
 *
 * 两边命名习惯不同（我们带 _p / _cs2 / 版本号，GFL 常常不带），
 * 直接按文件名取会漏掉一大半。这里做「归一化 + 唯一前缀」匹配，
 * 产出 data/gfl-parsed/_aliases.json（我们的地图名 → GFL 配置名）。
 *
 *   node scripts/content/link-gfl-configs.mjs            # 只报告
 *   node scripts/content/link-gfl-configs.mjs --write    # 写入别名表
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GFL = path.join(ROOT, 'data/gfl-parsed');
const WRITE = process.argv.includes('--write');

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/entity/catalog.json'), 'utf8'));
const ours = catalog.maps.filter((m) => m.a === '2001').map((m) => m.m);
const theirs = fs.readdirSync(GFL).filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => f.replace(/\.json$/, ''));

/** 归一化：去掉移植/版本/阶段等后缀，转小写 */
function norm(name) {
  let s = String(name).toLowerCase();
  // 反复剥离常见后缀
  const suffixes = /(_p|_cs2|_csgo|_css|_fix|_final|_remake|_redux|_lite|_port|_v\d+(_\d+)*|_b\d+|_a\d+|_rc\d*|_t\d*|_\d+)$/;
  for (let i = 0; i < 6; i++) {
    const next = s.replace(suffixes, '');
    if (next === s) break;
    s = next;
  }
  return s.replace(/[^a-z0-9]/g, '');
}

const normOurs = new Map();
for (const m of ours) {
  const k = norm(m);
  if (!normOurs.has(k)) normOurs.set(k, []);
  normOurs.get(k).push(m);
}
// 我方存在同族版本（例如 ze_obf_npst_v1 与 _v2）时，不允许再去掉版本号跨版本匹配
const oursAmbiguous = new Set([...normOurs.entries()].filter(([, v]) => v.length > 1).map(([k]) => k));
const normTheirs = new Map();
for (const t of theirs) {
  const k = norm(t);
  if (!normTheirs.has(k)) normTheirs.set(k, []);
  normTheirs.get(k).push(t);
}

const aliases = {};
const stats = { exact: 0, normalized: 0, prefix: 0, ambiguous: 0, none: 0 };
const unmatchedTheirs = new Set(theirs);

for (const m of ours) {
  if (theirs.includes(m)) {
    aliases[m] = m;
    stats.exact++;
    unmatchedTheirs.delete(m);
    continue;
  }
  const key = norm(m);
  if (oursAmbiguous.has(key)) {
    // 我方有多张同族图，只认文件名完全一致的那种，避免把 v2 的配置安到 v1 上
    stats.none++;
    continue;
  }
  const cand = normTheirs.get(key);
  if (cand && cand.length === 1) {
    aliases[m] = cand[0];
    stats.normalized++;
    unmatchedTheirs.delete(cand[0]);
    continue;
  }
  if (cand && cand.length > 1) {
    // 归一化后重名（多半是同一张图的多个版本），取名字最短的一份
    const pick = [...cand].sort((a, b) => a.length - b.length)[0];
    aliases[m] = pick;
    stats.ambiguous++;
    console.log(`  ~ ${m} → ${pick}（同组：${cand.join(', ')}）`);
    continue;
  }
  // 收紧策略：只接受「归一化后完全相同」的匹配。
  // 宽松的前缀匹配会把不同地图凑到一起（例如 ze_doom / ze_doomglaven、
  // ze_castlevania_nes / ze_castlevania），把别人的神器表安到这张图上属于事实错误，
  // 比缺数据更糟，所以宁可漏配。
  stats.none++;
}

const total = ours.length;
const covered = total - stats.none;
console.log(`\n站点 ZE 地图 ${total} 张，GFL 配置 ${theirs.length} 份`);
console.log(`  文件名完全一致   ${stats.exact}`);
console.log(`  归一化后匹配     ${stats.normalized}`);
console.log(`  前缀匹配         ${stats.prefix}`);
console.log(`  归一化后重名择一 ${stats.ambiguous}`);
console.log(`  仍无对应         ${stats.none}`);
console.log(`→ 覆盖率 ${covered}/${total}（${((covered / total) * 100).toFixed(0)}%）`);

if (WRITE) {
  const out = path.join(GFL, '_aliases.json');
  fs.writeFileSync(out, JSON.stringify(aliases, null, 1));
  console.log(`\n别名表已写入 ${path.relative(ROOT, out)}（${Object.keys(aliases).length} 条）`);
}
