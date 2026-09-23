#!/usr/bin/env node
/**
 * 把 GFL 公开服务器配置（JSONC）解析成每张地图的结构化数据：
 *   data/gfl/entwatch/<map>.jsonc   → 神器 / 道具（名称、冷却、次数）
 *   data/gfl/bosshud/<map>.jsonc    → BOSS 名单
 *   data/gfl/musicname/<map>.jsonc  → BGM（"Artist - Song"）
 *
 * 产物：data/gfl-parsed/<map>.json
 *   { "items":[{"name","cd","maxuses"}], "bosses":["..."], "music":["..."] }
 *
 *   node scripts/content/parse-gfl-configs.mjs
 *   （先跑 scripts/content/fetch-gfl-configs.ps1 下载配置）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'data/gfl');
const OUT = path.join(ROOT, 'data/gfl-parsed');

/** 去掉 JSONC 的注释与尾逗号（字符串内的 // 不动） */
function parseJsonc(text) {
  let out = '';
  let inStr = false, esc = false, line = false, block = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (line) { if (c === '\n') { line = false; out += c; } continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const readDir = (dir) => {
  const p = path.join(SRC, dir);
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p).filter((f) => f.endsWith('.jsonc') && f !== 'template.jsonc');
};

fs.mkdirSync(OUT, { recursive: true });

const maps = new Map();
const get = (m) => {
  if (!maps.has(m)) maps.set(m, { items: [], bosses: [], music: [] });
  return maps.get(m);
};

/* ---- entwatch：神器 / 道具 ---- */
let entFiles = 0;
for (const f of readDir('entwatch')) {
  const map = f.replace(/\.jsonc$/, '');
  try {
    const arr = parseJsonc(fs.readFileSync(path.join(SRC, 'entwatch', f), 'utf8'));
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      const name = (it.name || it.shortname || '').trim();
      if (!name) continue;
      const handlers = Array.isArray(it.handlers) ? it.handlers : [];
      const withCd = handlers.find((h) => h && (h.cooldown || h.maxuses));
      get(map).items.push({
        name,
        color: it.color || '',
        cd: withCd?.cooldown ?? 0,
        maxuses: withCd?.maxuses ?? 0,
      });
    }
    entFiles++;
  } catch (e) {
    console.warn(`  ! entwatch/${f}: ${e.message}`);
  }
}

/* ---- bosshud：BOSS 名单 ---- */
let bossFiles = 0;
for (const f of readDir('bosshud')) {
  const map = f.replace(/\.jsonc$/, '');
  try {
    const arr = parseJsonc(fs.readFileSync(path.join(SRC, 'bosshud', f), 'utf8'));
    if (!Array.isArray(arr)) continue;
    const names = [...new Set(arr.map((b) => (b?.name || '').trim()).filter(Boolean))];
    get(map).bosses.push(...names);
    bossFiles++;
  } catch (e) {
    console.warn(`  ! bosshud/${f}: ${e.message}`);
  }
}

/* ---- musicname：BGM ---- */
let musicFiles = 0;
for (const f of readDir('musicname')) {
  const map = f.replace(/\.jsonc$/, '');
  try {
    const obj = parseJsonc(fs.readFileSync(path.join(SRC, 'musicname', f), 'utf8'));
    if (!obj || typeof obj !== 'object') continue;
    const tracks = [];
    for (const v of Object.values(obj)) {
      if (typeof v !== 'string' || !v.trim()) continue;
      for (const part of v.split(',')) {
        const t = part.trim();
        if (t && !tracks.includes(t)) tracks.push(t);
      }
    }
    get(map).music.push(...tracks);
    musicFiles++;
  } catch (e) {
    console.warn(`  ! musicname/${f}: ${e.message}`);
  }
}

let written = 0;
let items = 0, bosses = 0, tracks = 0;
for (const [map, data] of maps) {
  data.bosses = [...new Set(data.bosses)];
  data.music = [...new Set(data.music)];
  const hasAny = data.items.length || data.bosses.length || data.music.length;
  if (!hasAny) continue;
  fs.writeFileSync(path.join(OUT, `${map}.json`), JSON.stringify(data));
  written++;
  items += data.items.length;
  bosses += data.bosses.length;
  tracks += data.music.length;
}

console.log(`解析配置：entwatch ${entFiles} · bosshud ${bossFiles} · musicname ${musicFiles} 个文件`);
console.log(`输出 ${written} 张地图 → data/gfl-parsed/`);
console.log(`累计：神器/道具 ${items} 条 · BOSS ${bosses} 个 · 曲目 ${tracks} 首`);
