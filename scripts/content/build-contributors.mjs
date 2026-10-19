#!/usr/bin/env node
/**
 * 贡献者汇总（2026-10-20 加，站长要求「导航里加一个贡献者板块，按贡献大小做物理球」）
 *
 * 数据来源**只用仓库里的东西**：
 *   · data/community/<slug>.json —— 社区投稿（字段 / 正文 / 神器 / 整篇草稿）里的署名与数量
 *   · data/gallery/<slug>.json   —— 玩家投稿图片的署名
 * 视频授权 UP 主**不能**写进这里（UP 主信息按站长要求不进 GitHub），
 * 页面会在浏览器里另问 /api/video-thanks，把它们作为第二组球加进物理场。
 *
 * 产物：data/contributors.json（进仓库，构建时重算，不需要人工维护）
 *
 * 输出结构：
 * {
 *   "generatedAt": "...",
 *   "contributors": [
 *     { "name": "AntiLockwise", "total": 235, "lastAt": "...",
 *       "kinds": { "神器/道具": 200, "标签": 35 },
 *       "maps": [ ["ze_xxx", "中文名", 12], ... ] }
 *   ]
 * }
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/Astro-code/ze-map-site';
const OUT = path.join(ROOT, 'data/contributors.json');

/* 字段 → 人话（神器 / 标签 / 背景故事…），页面详情里按这个分组 */
const { FIELD_RULES } = await import(pathToFileURL(path.join(ROOT, 'shared/submission-fields.mjs')).href);
const labelOf = (field) => {
  if (field === 'gallery') return '图片集';
  if (field === 'draft') return '整篇草稿';
  if (field === 'cover') return '地图封面';
  return FIELD_RULES?.[field]?.label ?? field;
};

const titleCache = new Map();
function titleOf(slug) {
  if (titleCache.has(slug)) return titleCache.get(slug);
  let t = '';
  try {
    const m = /^title:\s*"?([^"\n]+)"?$/m.exec(
      fs.readFileSync(path.join(ROOT, 'src/content/maps', `${slug}.mdx`), 'utf8')
    );
    if (m) t = m[1].trim();
  } catch {}
  titleCache.set(slug, t);
  return t;
}

/** name → { total, kinds: Map, maps: Map(slug → n), last } */
const people = new Map();
function bump(name, field, slug, at) {
  const who = String(name ?? '').trim();
  if (!who || who === '匿名') return;
  const row = people.get(who) ?? { total: 0, kinds: new Map(), maps: new Map(), last: '' };
  row.total += 1;
  row.kinds.set(field, (row.kinds.get(field) ?? 0) + 1);
  row.maps.set(slug, (row.maps.get(slug) ?? 0) + 1);
  const stamp = typeof at === 'string' ? at : '';
  if (stamp && stamp > row.last) row.last = stamp;
  people.set(who, row);
}

/* 社区文件 */
const communityDir = path.join(ROOT, 'data/community');
for (const f of fs.readdirSync(communityDir)) {
  if (!f.endsWith('.json')) continue;
  const slug = f.replace(/\.json$/, '');
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(communityDir, f), 'utf8'));
  } catch {
    continue;
  }
  for (const [field, v] of Object.entries(doc.fields ?? {})) bump(v?.by, field, slug, v?.at);
  for (const n of doc.notes ?? []) bump(n?.by, n?.field || 'story', slug, n?.at);
  for (const it of doc.items ?? []) bump(it?.by, 'items', slug, it?.at);
  if (doc.draft?.by) bump(doc.draft.by, 'draft', slug, doc.draft.at);
}

/* 图片集清单 */
const galleryDir = path.join(ROOT, 'data/gallery');
if (fs.existsSync(galleryDir)) {
  for (const f of fs.readdirSync(galleryDir)) {
    if (!f.endsWith('.json')) continue;
    const slug = f.replace(/\.json$/, '');
    let man;
    try {
      man = JSON.parse(fs.readFileSync(path.join(galleryDir, f), 'utf8'));
    } catch {
      continue;
    }
    for (const im of man.images ?? []) {
      if (im.kind !== 'user') continue;
      bump(im.by, 'gallery', slug, '');
    }
  }
}

const contributors = [...people.entries()]
  .map(([name, row]) => ({
    name,
    total: row.total,
    lastAt: row.last,
    kinds: Object.fromEntries(
      [...row.kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => [labelOf(k), n])
    ),
    maps: [...row.maps.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([slug, n]) => [slug, titleOf(slug), n]),
  }))
  .sort((a, b) => b.total - a.total);

/* 不写 generatedAt：那个字段每次构建都变，会让 data/contributors.json 每轮都脏 */
const payload = { contributors };
fs.writeFileSync(OUT, JSON.stringify(payload, null, 1) + '\n', 'utf8');
console.log(`贡献者 ${contributors.length} 位 → ${path.relative(ROOT, OUT)}`);
console.log(
  contributors
    .slice(0, 8)
    .map((c) => `${c.name}:${c.total}`)
    .join('、')
);
