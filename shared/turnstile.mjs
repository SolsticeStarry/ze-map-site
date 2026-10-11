/**
 * Turnstile（人机验证）的**公开**配置 —— 前端用（mjs，纯 JS：这个文件会被 Astro 构建和
 * Worker 打包同时读到，不能写 TypeScript 语法）。
 *
 * Site Key 本来就是公开的（它写在页面 HTML 里，谁都能看到），所以直接进仓库没问题；
 * **Secret Key 绝不进仓库**，它只存在于 Worker：`wrangler secret put TURNSTILE_SECRET`。
 *
 * 三件事必须知道（2026-10-11 接入时踩过/防过的）：
 *   1. **配 secret 之前，投稿那三个接口就已经在强制校验了**（worker/submissions.ts 一直有这段）。
 *      所以顺序必须是「先上带 widget 的前端，最后配 secret」—— 反了的话投稿会当场全部失败。
 *   2. **本地开发用 Cloudflare 官方的测试 Site Key**（永远通过），见 LOCAL_TEST_SITE_KEY。
 *      这样开发者不必往 widget 的域名白名单里加 localhost，也不会卡在验证上。
 *   3. token **一次性**：验证过就作废。提交失败后要 reset 换一个新的，
 *      否则用户改完再点一次会被判「验证没通过」（看起来像站点坏了）。
 */

/** 线上 widget 的 Site Key（Cloudflare 控制台 → Turnstile → ze-map.cn） */
export const TURNSTILE_SITE_KEY = '0x4AAAAAAFTuts_HEgdv8lvW';

/** Cloudflare 官方「永远通过」的测试 Site Key，只在本地/预览环境用 */
export const LOCAL_TEST_SITE_KEY = '1x00000000000000000000AA';

/** Cloudflare 官方测试 Secret（永远通过）—— 后端本地联调时可以用它 */
export const LOCAL_TEST_SECRET = '1x0000000000000000000000000000000AA';

/** 是不是本地开发地址 */
export function isLocalHostname(host) {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

/** 按当前域名选 Site Key：本地用测试 key，线上用真 key */
export function siteKeyFor(host) {
  if (isLocalHostname(host)) return LOCAL_TEST_SITE_KEY;
  return TURNSTILE_SITE_KEY;
}

/** 有没有配（没配就整段跳过，页面也不渲染 widget） */
export function turnstileConfigured() {
  return Boolean(TURNSTILE_SITE_KEY);
}
