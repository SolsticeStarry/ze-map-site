#!/usr/bin/env node
/**
 * 把所有**数据文件**里的难度旧称批量改成现称。
 *
 * 映射表来自 shared/difficulty.mjs 的 DIFFICULTY_RENAMES —— 以后再改中文叫法，
 * 只需在那个表里加一行，然后跑这个脚本，不用再满仓库找。
 *
 *   node scripts/content/rename-difficulty.mjs --dry    # 只列出会改什么
 *   node scripts/content/rename-difficulty.mjs          # 实际写入
 *
 * 覆盖范围：
 *   src/content/maps/*.mdx      frontmatter 的 difficulty 字段
 *   data/research/*.json        difficulty 字段
 *   data/community/*.json       fields.difficulty.v（社区投稿落盘）
 *
 * 不碰：枚举定义本身、样式类名（diff-medium 之类刻意不跟中文走）、文档里的举例。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIFFICULTY_RENAMES } from '../../shared/difficulty.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DRY = process.argv.includes('--dry');
const PAIRS = Object.entries(DIFFICULTY_RENAMES);

if (PAIRS.length === 0) {
  console.log('DIFFICULTY_RENAMES 是空的，没有需要改的。');
  process.exit(0);
}

const stats = { mdx: 0, research: 0, community: 0 };
const detail = [];

/* ---------- ① MDX frontmatter ---------- */
function migrateMdx(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.mdx')) continue;
    const file = path.join(dir, name);
    const text = fs.readFileSync(file, 'utf8');
    let changed = false;
    const out = text
      .split('\n')
      .map((line) => {
        const m = line.match(/^difficulty:(\s*)(.+?)\s*$/);
        if (!m) return line;
        const next = DIFFICULTY_RENAMES[m[2]];
        if (!next) return line;
        changed = true;
        detail.push(`${name}: ${m[2]} → ${next}`);
        return `difficulty:${m[1]}${next}`;
      })
      .join('\n');
    if (changed) {
      stats.mdx++;
      if (!DRY) fs.writeFileSync(file, out);
    }
  }
}

/* ---------- ② data/research/*.json ---------- */
function migrateResearch(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const next = DIFFICULTY_RENAMES[data?.difficulty];
    if (!next) continue;
    detail.push(`research/${name}: ${data.difficulty} → ${next}`);
    data.difficulty = next;
    stats.research++;
    if (!DRY) fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  }
}

/* ---------- ③ data/community/*.json ---------- */
function migrateCommunity(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const next = DIFFICULTY_RENAMES[data?.fields?.difficulty?.v];
    if (!next) continue;
    detail.push(`community/${name}: ${data.fields.difficulty.v} → ${next}`);
    data.fields.difficulty.v = next;
    /* log 里可能也记着旧值，一起改掉，免得历史记录自相矛盾 */
    for (const row of data.log ?? []) {
      if (DIFFICULTY_RENAMES[row?.to]) row.to = DIFFICULTY_RENAMES[row.to];
      if (DIFFICULTY_RENAMES[row?.from]) row.from = DIFFICULTY_RENAMES[row.from];
    }
    stats.community++;
    if (!DRY) fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  }
}

migrateMdx(path.join(ROOT, 'src/content/maps'));
migrateResearch(path.join(ROOT, 'data/research'));
migrateCommunity(path.join(ROOT, 'data/community'));

console.log(`映射表：${PAIRS.map(([a, b]) => `${a}→${b}`).join('  ')}`);
console.log(DRY ? '\n[干跑] 会改动的文件：' : '\n已改动：');
for (const line of detail) console.log('  ' + line);
console.log(
  `\n小计：MDX ${stats.mdx} 个 · research ${stats.research} 个 · community ${stats.community} 个` +
    (DRY ? '（未写入，去掉 --dry 才生效）' : '')
);
