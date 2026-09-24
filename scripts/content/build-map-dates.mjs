#!/usr/bin/env node
/**
 * 生成 data/map-dates.json —— 每张地图「资料首次进站」和「最近一次资料改动」的日期。
 *
 *   node scripts/content/build-map-dates.mjs
 *
 * 为什么单独做一份清单，而不是在页面里现读：
 *   1. 数据只能来自 git 历史 —— 不能读文件 mtime，因为 checkout 出来的文件
 *      mtime 是「克隆时间」，全仓库都是同一个值，没有任何信息。
 *   2. 线上（Cloudflare Workers Builds）的克隆深度不确定。清单提交进仓库后，
 *      即使那边是浅克隆、读不到历史，页面用的也是上一份正确数据，不会变成一片空白。
 *
 * 两个日期的口径：
 *   added   —— src/content/maps/<slug>.mdx 第一次以「新增」出现在提交里的日期。
 *              用它表示「这张图是什么时候进站的」。
 *              为什么以 MDX 为准：entities/工坊数据的导入会生成新 MDX。
 *   updated —— data/research/<slug>.json、data/community/<slug>.json、
 *              以及 src/content/maps/<slug>.mdx 里最近一次改动的日期。
 *              也就是「GitHub 上有人动过这张图的资料」。
 *
 *   注意 updated 里有一条刻意的不对称：
 *     · research / community **新建**也算 —— 那是「有人给这张图补了资料」，是内容更新；
 *     · MDX 新建**不算** —— 那只是数据导入生成的文件，不代表有人写了内容。
 *   不这样区分的话，9-23 那次一次性导入会让全部 547 张图在「最新更新」里挂 30 天。
 *
 * ⚠️ 批量提交的排除：生成器脚本一改（或者快照数据整批刷新），一次提交可能重写
 *    几百个文件。那种提交不算「这张图被更新了」——否则一次改版就会让所有地图
 *    挤进「最新更新」版块 30 天。判定方式：单次提交改动的相关文件超过 BULK 个，
 *    该提交的改动就不计入 updated（新地图的 added 仍然照记）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'data/map-dates.json');
/** 一次提交里相关文件超过这个数 = 批量操作（导入 / 整批刷新 / 批量补字段），不算单张图被更新 */
const BULK = 20;

/** 找 git：线上是 Linux 直接在 PATH 里；Windows 本地可能只有 GitHub Desktop 自带的那份 */
function findGit() {
  const candidates = [
    'git',
    'C:/Users/LENOVO/AppData/Local/GitHubDesktop/app-3.6.6/resources/app/git/cmd/git.exe',
    'C:/Program Files/Git/cmd/git.exe',
    'C:/Program Files (x86)/Git/cmd/git.exe',
  ];
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { cwd: ROOT, encoding: 'utf8', shell: false });
    if (r.status === 0) return c;
  }
  return null;
}

const git = findGit();
if (!git) {
  console.warn('[dates] 找不到 git，保留现有 data/map-dates.json 不动');
  process.exit(0);
}

const run = (args) => spawnSync(git, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const inside = run(['rev-parse', '--is-inside-work-tree']);
if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
  console.warn('[dates] 当前不在 git 仓库里，保留现有 data/map-dates.json 不动');
  process.exit(0);
}

// 浅克隆时 git log 只有最近一点点历史，据此算出来的「进站日期」会把整个仓库都说成今天，
// 那比没有还糟。所以这种情况直接不写文件，沿用上一份正确的。
const shallow = run(['rev-parse', '--is-shallow-repository']);
if (shallow.stdout.trim() === 'true') {
  console.warn('[dates] ⚠️ 这是浅克隆（没有完整历史），跳过生成，沿用现有的 data/map-dates.json');
  process.exit(0);
}

const log = run([
  'log',
  '--reverse',
  '--name-status',
  '--format=@@%aI',
  '--',
  'src/content/maps',
  'data/research',
  'data/community',
]);
if (log.status !== 0) {
  console.warn('[dates] git log 失败，保留现有 data/map-dates.json 不动');
  process.exit(0);
}

/** 按提交切块：每个提交 = { date, files: [{status, path}] } */
const commits = [];
let cur = null;
for (const raw of log.stdout.split('\n')) {
  const line = raw.trimEnd();
  if (line.startsWith('@@')) {
    cur = { date: line.slice(2).trim().slice(0, 10), files: [] };
    commits.push(cur);
    continue;
  }
  const m = /^([A-Z])\d*\t(.+)$/.exec(line);
  if (!m || !cur) continue;
  cur.files.push({ status: m[1], path: m[2] });
}

const added = new Map();
const updated = new Map();
const touch = (slug, date) => {
  if (!updated.has(slug) || updated.get(slug) < date) updated.set(slug, date);
};
let bulkCommits = 0;

for (const c of commits) {
  const relevant = c.files.filter(
    (f) => /^src\/content\/maps\/.+\.mdx$/.test(f.path) || /^data\/(?:research|community)\/.+\.json$/.test(f.path)
  );
  // priority.json 是标签优先级配置，不是地图
  const mapFiles = relevant.filter((f) => !/^data\/research\/priority\.json$/.test(f.path));
  const isBulk = mapFiles.length > BULK;
  if (isBulk) {
    bulkCommits++;
    console.log(`[dates]   批量提交，其改动不计入「更新」：${c.date} 动了 ${mapFiles.length} 个文件`);
  }
  for (const f of mapFiles) {
    const mdx = /^src\/content\/maps\/(.+)\.mdx$/.exec(f.path);
    const research = /^data\/(?:research|community)\/(.+)\.json$/.exec(f.path);
    if (mdx) {
      const slug = mdx[1];
      if (f.status === 'A' && !added.has(slug)) added.set(slug, c.date);
      // MDX 的「新建」只是数据导入生成的文件，不算有人更新了内容
      if (f.status !== 'A' && !isBulk) touch(slug, c.date);
    } else if (research) {
      // research/community 的新建算内容更新（有人给这张图补了资料）
      if (!isBulk) touch(research[1], c.date);
    }
  }
}

const maps = {};
for (const slug of [...new Set([...added.keys(), ...updated.keys()])].sort()) {
  const rec = {};
  if (added.has(slug)) rec.added = added.get(slug);
  if (updated.has(slug)) rec.updated = updated.get(slug);
  maps[slug] = rec;
}

const next = {
  _说明:
    '每张地图的资料进站 / 最近改动日期，由 scripts/content/build-map-dates.mjs 从 git 历史生成，别手改。' +
    'added = src/content/maps/<slug>.mdx 首次新增；updated = research / community / mdx 最近一次改动。',
  version: 1,
  maps,
};

const text = JSON.stringify(next, null, 2) + '\n';
const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
if (prev === text) {
  console.log(`[dates] 无变化（${Object.keys(maps).length} 张地图，跳过了 ${bulkCommits} 次批量重新生成）`);
  process.exit(0);
}
fs.writeFileSync(OUT, text, 'utf8');

const today = new Date().toISOString().slice(0, 10);
const cut = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const recentUpdated = Object.values(maps).filter((v) => v.updated && v.updated >= cut).length;
const recentAdded = Object.values(maps).filter((v) => v.added && v.added >= cut).length;
console.log(
  `[dates] 已写入 data/map-dates.json：${Object.keys(maps).length} 张地图` +
    `（今天 ${today}；30 天内进站 ${recentAdded} 张、改动 ${recentUpdated} 张；跳过 ${bulkCommits} 次批量重新生成）`
);
