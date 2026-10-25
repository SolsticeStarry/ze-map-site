#!/usr/bin/env node
/**
 * 每周日自动收录：发现工坊一周内新建的 ze_ 地图，先以「无实体资料页」入库。
 *
 * 只做发现 + 建资料页（不跑烘焙）：
 *   - 烘焙依赖 Windows + steamcmd，且不少新图没有 default_ents，自动跑会卡住；
 *   - 资料页能先让玩家搜到图、看到工坊信息，实体/预览等有数据后再升级。
 *
 * 用法：node scripts/ops/weekly-new-maps.mjs [--days 8] [--dry]
 * 跑完由外层脚本负责 build / commit / push。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RESEARCH = path.join(ROOT, 'data/research');
const WORKSHOP = path.join(ROOT, 'data/workshop');

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const daysArg = args.indexOf('--days');
const days = daysArg >= 0 ? Number(args[daysArg + 1]) || 8 : 8;
const since = Math.floor((Date.now() - days * 86400_000) / 1000);

const clean = (s) =>
  String(s ?? '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\[\/?[a-z0-9*=]+\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

/** 已有条目按「地图名」和「工坊 ID」两种方式判重 */
const known = new Set();
for (const f of fs.readdirSync(RESEARCH)) {
  if (!f.endsWith('.json') || f === 'priority.json') continue;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(RESEARCH, f), 'utf8'));
    if (j.slug) known.add(String(j.slug).toLowerCase());
    for (const m of j.maps ?? []) known.add(String(m).toLowerCase());
    if (j.workshopId) known.add(String(j.workshopId));
    const m = /^(\d+)-([a-zA-Z0-9_]+)-(\d+)$/.exec(String(j.slug ?? ''));
    if (m) { known.add(m[2].toLowerCase()); known.add(m[3]); }
  } catch {}
}
for (const f of fs.readdirSync(WORKSHOP)) {
  if (f.endsWith('.json')) known.add(f.replace(/\.json$/, ''));
}

/* 1) 工坊「最新」列表，取两页 */
const found = new Map();
for (const page of [1, 2]) {
  const url = `https://steamcommunity.com/workshop/browse/?appid=730&searchtext=ze_&browsesort=mostrecent&section=readytouseitems&p=${page}`;
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 ze-map-site', 'accept-language': 'en-US' } });
  const html = await r.text();
  const starts = [...html.matchAll(/\\"publishedfileid\\":\\"(\d+)\\"/g)].map((m) => ({ id: m[1], at: m.index }));
  for (let i = 0; i < starts.length; i++) {
    const chunk = html.slice(starts[i].at, i + 1 < starts.length ? starts[i + 1].at : html.length);
    const title = /\\"title\\":\\"([^"\\]+)\\"/.exec(chunk)?.[1];
    const created = Number(/\\"time_created\\":(\d+)/.exec(chunk)?.[1] ?? 0);
    if (!title || created < since) continue;
    if (!/^ze[_-]/i.test(title)) continue;
    if (found.has(starts[i].id)) continue;
    found.set(starts[i].id, { id: starts[i].id, title, created });
  }
}

const fresh = [...found.values()].filter((x) => !known.has(x.id) && !known.has(x.title.toLowerCase()));
console.log(`窗口：最近 ${days} 天｜工坊命中 ${found.size} 张｜站内没有的 ${fresh.length} 张`);
if (!fresh.length || dry) process.exit(0);

/* 2) 拉详情 → 写工坊快照 + 无实体资料页 */
for (const item of fresh) {
  const body = new URLSearchParams();
  body.set('itemcount', '1');
  body.set('publishedfileids[0]', item.id);
  const r = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json();
  const f = j?.response?.publishedfiledetails?.[0];
  if (!f || Number(f.result) !== 1) { console.log('跳过（详情取不到）', item.id); continue; }

  const id = item.id;
  const title = String(f.title ?? item.title).trim();
  const mapName = /^(ze[_-][A-Za-z0-9_]+)/i.exec(title)?.[1] ?? title.replace(/\s+/g, '_');
  if (known.has(mapName.toLowerCase())) continue;
  const created = f.time_created ? new Date(Number(f.time_created) * 1000).toISOString().slice(0, 10) : null;
  const desc = clean(f.description);

  fs.writeFileSync(
    path.join(WORKSHOP, `${id}.json`),
    JSON.stringify(
      {
        id,
        result: 1,
        title,
        description: desc.slice(0, 2000),
        creator: String(f.creator ?? ''),
        timeCreated: created,
        timeUpdated: f.time_updated ? new Date(Number(f.time_updated) * 1000).toISOString().slice(0, 10) : null,
        subscriptions: Number(f.subscriptions ?? 0),
        views: Number(f.views ?? 0),
        fileSize: String(f.file_size ?? ''),
        tags: Array.isArray(f.tags) ? f.tags.map((t) => String(t.tag ?? '')) : [],
        filename: String(f.filename ?? ''),
      },
      null,
      2
    ) + '\n'
  );

  const slug = `2001-${mapName}-${id}`;
  const doc = {
    slug,
    title: mapName,
    titleEn: mapName,
    difficulty: '未知',
    tags: [],
    summary: desc
      ? `${desc}\n\n> 新图自动收录，暂无实体数据与人工整理；欢迎在编辑页补充难度、标签、玩法与视频。`
      : '> 新图自动收录，暂无实体数据与人工整理；欢迎在编辑页补充资料。',
    videoUrls: [],
    sources: [`https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`],
    workshopId: id,
    confidence: 'low',
  };
  fs.writeFileSync(path.join(RESEARCH, `${slug}.json`), JSON.stringify(doc, null, 2) + '\n');
  known.add(mapName.toLowerCase());
  console.log(`收录 ${mapName} ← ${title}（${created}）`);
}
