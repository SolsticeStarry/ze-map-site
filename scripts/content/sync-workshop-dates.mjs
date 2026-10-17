#!/usr/bin/env node
/**
 * 把社区公开的工坊版本记录同步成 data/workshop-updates.json。
 *
 * 数据来自一个自动追踪创意工坊地图更新的公开仓库：2001（ZE）目录下每个工坊条目都有自己的
 * <publishFileId>/manifest.json，里面的 publishDate 就是那个条目最近一次发布的时间。
 * 这份记录一直在更新（机器人一天提交好几次），比我们抓 Steam Web API 的快照新，
 * 所以条目页的「工坊最近更新」以它为准；Steam 那边更新了就取更新的那个日期。
 *
 * ⚠️ 仓库没有许可证。站上**不署名、不写来源**（对外统一叫「历史服务端实体快照」），
 *    这是站长的要求：仓库地址也别写进这里，站长自己知道在哪。
 *
 * 用法（那份仓库 226 MB，别整仓拉，只稀疏检出 manifest；glob 见下方 SPARSE_GLOB）：
 *   git clone --depth 1 --filter=blob:none --sparse <仓库地址> _mt
 *   git -C _mt sparse-checkout set --no-cone <SPARSE_GLOB 的值>
 *   node scripts/content/sync-workshop-dates.mjs --repo _mt
 *   # 也可以给环境变量：MAPTRACK_DIR=_mt node scripts/content/sync-workshop-dates.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'data/workshop-updates.json');
/* 稀疏检出时用的 glob（写在这里是因为带星号的 glob 放进块注释会提前结束注释） */
const SPARSE_GLOB = '2001/*/*/manifest.json';

const argv = process.argv.slice(2);
const repoArg = argv.includes('--repo') ? argv[argv.indexOf('--repo') + 1] : process.env.MAPTRACK_DIR;
if (!repoArg) {
  console.error('用法：node scripts/content/sync-workshop-dates.mjs --repo <追踪仓库的本地副本>');
  process.exit(1);
}
const repo = path.resolve(repoArg);
const modeDir = path.join(repo, '2001'); // 只同步 ZE
if (!fs.existsSync(modeDir)) {
  console.error(`找不到 ${modeDir} —— 检查一下路径，或先 sparse-checkout 出 manifest.json`);
  process.exit(1);
}

const dates = {};
let scanned = 0;
let skipped = 0;
for (const mapName of fs.readdirSync(modeDir)) {
  const mapDir = path.join(modeDir, mapName);
  if (!fs.statSync(mapDir).isDirectory()) continue;
  for (const versionDir of fs.readdirSync(mapDir)) {
    const file = path.join(mapDir, versionDir, 'manifest.json');
    if (!fs.existsSync(file)) continue;
    scanned++;
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      /* 只留日期部分：页面上显示到天，时间部分对读者没有意义 */
      const day = String(m.publishDate ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        skipped++;
        continue;
      }
      /* 键用工坊条目 id（站点 frontmatter 里的 workshopId），跟 slug 无关，改名也不影响 */
      dates[String(m.publishFileId ?? versionDir)] = day;
    } catch {
      skipped++;
    }
  }
}

const sorted = Object.fromEntries(Object.entries(dates).sort((a, b) => a[0].localeCompare(b[0])));
const before = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')).dates ?? {} : {};
const changed = Object.entries(sorted).filter(([k, v]) => before[k] !== v).length;
const removed = Object.keys(before).filter((k) => !(k in sorted)).length;

const payload = {
  _说明:
    '工坊每个条目的最近发布时间，取自社区公开的工坊版本记录（manifest.json 的 publishDate）。' +
    '键是创意工坊条目 id（= 条目页的 workshopId），值形如 2026-09-14。同步脚本：scripts/content/sync-workshop-dates.mjs',
  _同步于: new Date().toISOString().slice(0, 10),
  dates: sorted,
};
fs.writeFileSync(OUT, JSON.stringify(payload, null, 1) + '\n');

console.log(`扫描 ${scanned} 个 manifest，写入 ${Object.keys(sorted).length} 条（跳过 ${skipped}）`);
console.log(`与上一版相比：新增/变化 ${changed} 条，消失 ${removed} 条`);
console.log(`→ ${path.relative(ROOT, OUT)}`);
