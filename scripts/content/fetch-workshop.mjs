#!/usr/bin/env node
/**
 * 用 Steam Web API 批量抓取工坊条目详情（不需要 API key）。
 *
 *   POST https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/
 *
 * 拿到：工坊标题、正文（作者自述）、作者 SteamID、发布时间、更新时间的、
 *       订阅数、浏览量、标签。这些是权威数据，比抓网页可靠。
 *
 * 产物：data/workshop/<workshopId>.json（已存在则跳过，可断点续跑）
 *
 *   node scripts/content/fetch-workshop.mjs              # 全部模式
 *   node scripts/content/fetch-workshop.mjs --mode 2001  # 只抓 ZE
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'data/workshop');
const argv = process.argv.slice(2);
const MODE = argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : null;
const BATCH = Number((argv.includes('--batch') ? argv[argv.indexOf('--batch') + 1] : null) ?? 80);
const API = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/entity/catalog.json'), 'utf8'));
const maps = catalog.maps.filter((m) => !MODE || m.a === MODE);

fs.mkdirSync(OUT, { recursive: true });
const cached = new Set(fs.readdirSync(OUT).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')));

const todo = maps.map((m) => m.f).filter((id) => id && !cached.has(String(id)));
console.log(`工坊条目 ${maps.length} 个 · 已缓存 ${maps.length - todo.length} · 待抓取 ${todo.length}`);

const clean = (s) =>
  String(s || '')
    .replace(/\[\/?[^\]]{0,40}\]/g, ' ')          // [b] [url=..] 之类
    .replace(/\[img\][\s\S]*?\[\/img\]/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ok = 0, missing = 0, failed = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  const body = new URLSearchParams();
  body.set('itemcount', String(batch.length));
  batch.forEach((id, k) => body.set(`publishedfileids[${k}]`, String(id)));

  let json;
  try {
    const res = await fetch(API, { method: 'POST', body });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } catch (e) {
    failed += batch.length;
    console.warn(`  批次 ${i / BATCH + 1} 失败：${e.message}`);
    continue;
  }

  const details = json?.response?.publishedfiledetails ?? [];
  const seen = new Set();
  for (const d of details) {
    seen.add(String(d.publishedfileid));
    const rec = {
      id: String(d.publishedfileid),
      result: d.result,
      title: d.title || '',
      description: clean(d.description).slice(0, 6000),
      creator: d.creator || '',
      timeCreated: d.time_created ? new Date(d.time_created * 1000).toISOString().slice(0, 10) : '',
      timeUpdated: d.time_updated ? new Date(d.time_updated * 1000).toISOString().slice(0, 10) : '',
      subscriptions: d.subscriptions ?? 0,
      views: d.views ?? 0,
      fileSize: d.file_size ?? 0,
      tags: (d.tags || []).map((t) => t.tag).filter(Boolean),
      filename: d.filename || '',
    };
    fs.writeFileSync(path.join(OUT, `${rec.id}.json`), JSON.stringify(rec));
    if (d.result === 1) ok++; else missing++;
  }
  for (const id of batch) if (!seen.has(String(id))) {
    fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify({ id: String(id), result: 9, missing: true }));
    missing++;
  }
  console.log(`  批次 ${i / BATCH + 1}/${Math.ceil(todo.length / BATCH)} 完成（累计 正常 ${ok} · 缺失 ${missing}）`);
  await sleep(400);
}

console.log(`\n完成：正常 ${ok} · 查无此项 ${missing} · 请求失败 ${failed}`);
console.log(`产物目录：${path.relative(ROOT, OUT)}（共 ${fs.readdirSync(OUT).length} 个文件）`);
