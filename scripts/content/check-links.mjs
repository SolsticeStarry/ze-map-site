#!/usr/bin/env node
/**
 * 站点内部链接检查：扫 dist 下所有 HTML，验证站内链接与静态资源是否真实存在。
 *
 *   node scripts/content/check-links.mjs            # 检查（需先 npm run build）
 *   node scripts/content/check-links.mjs --limit 20 # 最多列出 20 条问题
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(ROOT, 'dist');
const argv = process.argv.slice(2);
const LIMIT = Number((argv.includes('--limit') ? argv[argv.indexOf('--limit') + 1] : null) ?? 40);

if (!fs.existsSync(DIST)) {
  console.error('没有 dist，先跑 npm run build');
  process.exit(1);
}

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const files = walk(DIST);
const htmls = files.filter((f) => f.endsWith('.html'));
const assetSet = new Set(files.map((f) => '/' + path.relative(DIST, f).replace(/\\/g, '/')));

/** 站内路径 → dist 里是否存在（支持目录 index.html） */
function exists(p) {
  const clean = decodeURIComponent(p.split('#')[0].split('?')[0]);
  if (!clean.startsWith('/')) return true;
  if (assetSet.has(clean)) return true;
  if (assetSet.has(clean.replace(/\/$/, '/index.html'))) return true;
  if (assetSet.has(clean + '/index.html')) return true;
  if (assetSet.has(clean + '.html')) return true;
  return false;
}

const broken = new Map(); // target -> Set(来源页面)
let checked = 0;

for (const file of htmls) {
  const html = fs.readFileSync(file, 'utf8');
  const page = '/' + path.relative(DIST, file).replace(/\\/g, '/');
  for (const m of html.matchAll(/(?:href|src)="(\/[^"#][^"]*)"/g)) {
    const target = m[1];
    if (target.startsWith('//')) continue;
    checked++;
    if (!exists(target)) {
      if (!broken.has(target)) broken.set(target, new Set());
      broken.get(target).add(page);
    }
  }
}

console.log(`检查 ${htmls.length} 个页面，站内链接/资源引用 ${checked} 处`);
if (broken.size === 0) {
  console.log('✅ 没有死链');
  process.exit(0);
}

console.log(`\n❌ 发现 ${broken.size} 个死链目标：`);
let i = 0;
for (const [target, from] of broken) {
  if (i++ >= LIMIT) { console.log(`   … 另有 ${broken.size - LIMIT} 个`); break; }
  const src = [...from].slice(0, 2).join(', ');
  console.log(`   ${target}\n       ← ${src}${from.size > 2 ? ` 等 ${from.size} 个页面` : ''}`);
}
process.exit(1);
