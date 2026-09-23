#!/usr/bin/env node
/**
 * 构建后生成 Pagefind 搜索索引。
 *
 * 为什么要包一层：直接 `pagefind --site dist` 在 CI 上偶发非零退出（本机也遇到过一次），
 * 而「搜索索引失败」不应该让整个站点部署失败——所以这里重试一次，
 * 仍失败就打印警告并以 0 退出，站点照常发布（/search/ 页面会显示"索引尚未生成"的兜底提示）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(ROOT, 'dist');

if (!fs.existsSync(DIST)) {
  console.error('没有 dist 目录，先跑 astro build');
  process.exit(1);
}

const run = () => {
  const res = spawnSync('npx', ['pagefind', '--site', 'dist'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return res.status ?? 1;
};

let code = run();
if (code !== 0) {
  console.warn(`\n[search] pagefind 第一次退出码 ${code}，重试一次…`);
  code = run();
}

const indexPath = path.join(DIST, 'pagefind', 'pagefind.js');
if (code === 0 && fs.existsSync(indexPath)) {
  const size = (() => {
    let total = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else total += fs.statSync(p).size;
      }
    };
    walk(path.join(DIST, 'pagefind'));
    return total;
  })();
  console.log(`[search] 索引已生成：dist/pagefind（${(size / 1048576).toFixed(2)} MB）`);
  process.exit(0);
}

console.warn(
  `[search] ⚠️ 索引生成失败（退出码 ${code}），站点照常部署；` +
    `/search/ 会显示"索引尚未生成"的提示，可稍后重跑 npm run search:index`
);
process.exit(0);
