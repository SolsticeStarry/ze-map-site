#!/usr/bin/env node
/**
 * 交接前只读检查：默认 wrangler 配置是否已指向站长生产、是否残留个人测试信息。
 * 不读取 / 打印任何 secret 值；只列变量名和执行清单。
 *
 *   npm run handoff:check
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = path.join(ROOT, 'wrangler.jsonc');
const config = fs.readFileSync(configPath, 'utf8');

const REQUIRED = [
  ['Worker 名称', '"name": "ze-map-site"'],
  ['生产仓库', '"GITHUB_REPO": "hhjjdsj/ze-map-site"'],
  ['生产分支', '"GITHUB_BRANCH": "main"'],
  ['生产 D1', '"database_name": "ze-map-community"'],
  ['生产 R2', '"bucket_name": "ze-map-terr"'],
  ['R2 绑定', '"binding": "TERR"'],
  ['KV 绑定', '"binding": "UPLOADS"'],
  ['提交入口路由', '"/submit"'],
];
const FORBIDDEN = [
  ['个人 fork', 'SolsticeStarry'],
  ['个人测试分支', 'refactor/content-model-v2-visual'],
  ['个人测试 Worker', 'ze-map-site-test'],
  ['个人测试 D1', 'ze-map-community-test'],
];

let failed = false;
console.log(`检查 ${path.relative(ROOT, configPath)}`);
for (const [label, needle] of REQUIRED) {
  const ok = config.includes(needle);
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `（缺少 ${needle}）`}`);
  if (!ok) failed = true;
}
for (const [label, needle] of FORBIDDEN) {
  const present = config.includes(needle);
  console.log(`${present ? '✗' : '✓'} ${label}${present ? `（仍含 ${needle}）` : ''}`);
  if (present) failed = true;
}

const missing = [
  'ADMIN_TOKEN', 'IP_SALT', 'GITHUB_TOKEN', 'GITHUB_OAUTH_CLIENT_ID',
  'GITHUB_OAUTH_CLIENT_SECRET', 'SESSION_SECRET', 'TURNSTILE_SECRET（如启用）',
];
console.log('\n站长账户需要配置（不检查值）：');
for (const name of missing) console.log(`  - ${name}`);

console.log('\n站长执行清单（破坏性操作前先导出）：');
console.log('  npx wrangler d1 export ze-map-community --remote --output ./migration-owner/d1-before-cutover.sql');
console.log('  npx wrangler d1 migrations apply ze-map-community --remote');
console.log('  npx wrangler secret put ADMIN_TOKEN');
console.log('  npx wrangler secret put IP_SALT');
console.log('  npx wrangler secret put GITHUB_TOKEN');
console.log('  npx wrangler secret put GITHUB_OAUTH_CLIENT_ID');
console.log('  npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET');
console.log('  npx wrangler secret put SESSION_SECRET');
console.log('  npx wrangler deploy');
console.log('\n生产默认：npm run deploy:prod。');

if (failed) {
  console.log('\n✗ 默认配置还不适合交接，先修上面的问题。');
  process.exit(1);
}
console.log('\n✓ 默认配置只含站长生产信息，可以进入 PR / Preview 验收。');
