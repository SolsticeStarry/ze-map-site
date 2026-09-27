#!/usr/bin/env node
/**
 * 校验按图分片能否被 viewer 消费（兼容历史快照与工坊 VPK 烘焙数据）。
 * 用法： node scripts/entity-data/verify-entity-data.mjs [--limit N] [--all]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'public/entity');
const argv = process.argv.slice(2);
const limit = argv.includes('--all') ? Infinity : Number(argv[argv.indexOf('--limit') + 1] || 60);

const catalog = JSON.parse(fs.readFileSync(path.join(DIR, 'catalog.json'), 'utf8'));
const errors = [];
const warnings = [];
let catalogCountDiff = 0;
const stats = { maps: 0, ents: 0, withBg: 0, withRb: 0, maxEnt: 0, maxEntMap: '', attrs: 0, conns: 0, stages: 0 };

const need = ['m', 'i', 'f', 'n', 'b', 'e', 'A2', 'C2'];
const picked = catalog.maps.filter((_, i) => i % Math.ceil(catalog.maps.length / Math.min(limit, catalog.maps.length)) === 0);

for (const cat of picked) {
  const file = path.join(DIR, 'data', `${cat.s}.bin`);
  if (!fs.existsSync(file)) { errors.push(`缺文件 ${cat.s}.bin`); continue; }
  let p;
  try {
    const buf = zlib.gunzipSync(fs.readFileSync(file));
    const jlen = buf.readUInt32LE(0);
    p = { json: JSON.parse(buf.subarray(4, 4 + jlen).toString('utf8')), bin: buf.subarray(4 + jlen) };
  } catch (e) { errors.push(`${cat.s}: 解包失败 ${e.message}`); continue; }

  const { json, bin } = p;
  const m = json.map;
  if (!m) { errors.push(`${cat.s}: 没有 map 字段`); continue; }
  for (const k of need) if (m[k] === undefined) errors.push(`${cat.s}: map.${k} 缺失`);
  if (json.groups?.length !== 12) errors.push(`${cat.s}: groups=${json.groups?.length}`);
  if (!Array.isArray(json.classes) || !json.classes.length) errors.push(`${cat.s}: classes 异常`);
  if (!Array.isArray(m.e)) { errors.push(`${cat.s}: e 不是数组`); continue; }
  if (m.e.length !== cat.k2 || m.n !== cat.n) catalogCountDiff++;
  if (m.e.length > m.n) errors.push(`${cat.s}: e 长度 ${m.e.length} > 分片实体总数 ${m.n}`);
  if (m.bb != null || m.bbm != null) {
    if (!Array.isArray(m.bb) || m.bb.length % 6 !== 0 || !Array.isArray(m.bbm) || m.bbm.length !== m.e.length) {
      errors.push(`${cat.s}: bb/bbm 结构异常`);
    } else if (m.bbm.some((i) => !Number.isInteger(i) || i < -1 || i >= m.bb.length / 6)) {
      errors.push(`${cat.s}: bbm 索引越界`);
    }
  }

  // 位图切片
  if (m.bg) {
    stats.withBg++;
    if (m.bg[0] + m.bg[1] > bin.length) errors.push(`${cat.s}: bg 切片越界`);
  }
  if (m.rb) {
    stats.withRb++;
    if (m.rb[0] + m.rb[1] > bin.length) errors.push(`${cat.s}: rb 切片越界`);
    const magic = bin.subarray(m.rb[0], m.rb[0] + 4).toString('hex');
    if (magic !== '52494646') errors.push(`${cat.s}: 雷达图不是 RIFF/WebP (${magic})`);
  }

  // 实体记录：与 viewer 的解析逻辑一致
  const clsG = json.classes?.length || 0;
  for (const e of m.e) {
    if (!Array.isArray(e) || e.length < 5) { errors.push(`${cat.s}: 实体记录异常 ${JSON.stringify(e).slice(0, 60)}`); break; }
    if (e[3] < 0 || e[3] >= clsG) { errors.push(`${cat.s}: class 索引越界 ${e[3]}`); break; }
    let qp = typeof e[4] === 'string' ? 5 : 4;
    const end = e.length - 1;
    let ai = -1, gi = -1;
    if (end > qp) ai = e[qp++];
    if (end > qp) gi = e[qp];
    if (ai >= 0 && !(m.A2 && m.A2[ai])) { warnings.push(`${cat.s}: 实体引用 A2[${ai}]，但该图属性表只有 ${m.A2?.length ?? 0} 条（源数据如此，viewer 会跳过）`); }
    if (gi >= 0 && !(m.C2 && m.C2[gi])) { errors.push(`${cat.s}: C2[${gi}] 缺失`); break; }
  }

  stats.maps++;
  stats.ents += m.e.length;
  stats.attrs += (m.A2 || []).reduce((a, x) => a + (x?.length || 0), 0);
  stats.conns += (m.C2 || []).reduce((a, x) => a + (x?.length || 0), 0);
  stats.stages += m.st || 0;
  if (m.e.length > stats.maxEnt) { stats.maxEnt = m.e.length; stats.maxEntMap = cat.s; }
}

// 仅在历史分片确有属性时抽查；新烘焙分片目前不生成 A2/C2。
const sample = catalog.maps.find((m) => m.m === 'ze_pirates_port_royal');
if (sample) {
  const buf = zlib.gunzipSync(fs.readFileSync(path.join(DIR, 'data', `${sample.s}.bin`)));
  const jlen = buf.readUInt32LE(0);
  const m = JSON.parse(buf.subarray(4, 4 + jlen).toString('utf8')).map;
  if (m.A2?.some((a) => a?.length)) {
    console.log('抽查 ze_pirates_port_royal：');
    console.log('  属性样例   ', JSON.stringify(m.A2.find((a) => a && a.length)?.slice(0, 3)));
    console.log('  连线样例   ', JSON.stringify(m.C2.find((c) => c && c.length)?.slice(0, 3)));
    const numericKey = m.A2.flat().filter((a) => a && /^\d+$/.test(String(a[0]))).length;
    console.log(`  属性键里仍是纯数字的条数：${numericKey}（应为 0 或极少）`);
  }
}
console.log(`\n校验 ${stats.maps} 张（抽样，每 ${Math.ceil(catalog.maps.length / Math.min(limit, catalog.maps.length))} 张取 1）`);
console.log(`实体合计 ${stats.ents.toLocaleString()} · 带密度底图 ${stats.withBg} · 带雷达图 ${stats.withRb}`);
console.log(`属性条目 ${stats.attrs.toLocaleString()} · 触发连接 ${stats.conns.toLocaleString()} · 最大单图实体 ${stats.maxEnt.toLocaleString()}（${stats.maxEntMap}）`);
if (catalogCountDiff) console.log(`索引快照与分片数量不同：${catalogCountDiff} 张（新烘焙尚不更新 catalog，不作为分片错误）`);
if (warnings.length) console.log(`\n⚠️  ${warnings.length} 条源数据警告（不影响渲染，与原版行为一致）：\n   - ${warnings.slice(0, 5).join('\n   - ')}`);
if (errors.length) {
  console.log(`\n❌ 发现 ${errors.length} 个问题：`);
  for (const e of errors.slice(0, 25)) console.log('   - ' + e);
  process.exit(1);
} else {
  console.log('\n✅ 数据结构校验通过');
}
