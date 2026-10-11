/**
 * Turnstile 服务端校验（注册 / 登录 / 投稿三个入口共用）。
 *
 * 为什么单开一个文件：这三个入口都要「配了 secret 就校验、没配就跳过」，
 * 各写一份迟早漂移（以前只有投稿这一份，账号功能加进来时就漏了）。
 *
 * 返回的是一个**结果对象**而不是 true/false —— 因为「用户没点验证 / token 过期」
 * 与「Cloudflare 的校验服务不可达」是两回事，给用户的提示也该不一样：
 * 前者让他去点那个框，后者告诉他稍后再试（否则用户会以为站点坏了）。
 */

import type { Env } from './http';

export type TurnstileResult = { ok: true } | { ok: false; reason: 'invalid' | 'unavailable' };

/** 配了 secret 才需要校验（没配就是「限流 + 人工审核」兜底，与以前一致） */
export function turnstileRequired(env: Env): boolean {
  return Boolean(env.TURNSTILE_SECRET);
}

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * 校验 Turnstile token。
 *
 * `required`（默认 true）：
 *   · true  —— 注册 / 登录用。没带 token 就是过不去（这两处是刷号与撞库的入口）。
 *   · false —— **投稿用**（站长 2026-10-11 定的）：带了 token 就验，没带也放行。
 *     为什么投稿宽松：投稿是这站存在的意义，而开了严格隐私设置的浏览器（Edge 默认跟踪防护、
 *     拦第三方脚本的插件）可能根本加载不出 widget —— 不能因为浏览器设置把正常贡献者挡在门外。
 *     代价是刷投稿只能靠原有的 IP 限流（300/小时、2000/天）+ 人工审核 + 封禁。
 */
export async function verifyTurnstile(
  env: Env,
  token: unknown,
  ip: string,
  opts: { required?: boolean } = {}
): Promise<TurnstileResult> {
  if (!env.TURNSTILE_SECRET) return { ok: true };
  const hasToken = typeof token === 'string' && token.length > 0;
  if (!hasToken) return opts.required === false ? { ok: true } : { ok: false, reason: 'invalid' };

  let res: Response;
  try {
    res = await fetch(SITEVERIFY, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
    });
  } catch (err) {
    /* 网络层就没通（Cloudflare 校验服务抽风 / 本机被挡）：
       这是「暂时不可用」，不是「你验证没过」，别把锅甩给用户。 */
    console.error('siteverify 请求失败：' + (err instanceof Error ? err.message : String(err)));
    return { ok: false, reason: 'unavailable' };
  }

  if (!res.ok) {
    /* 5xx 之类：同样是服务端问题；4xx 才是 token 本身不对 */
    console.error('siteverify 返回 ' + res.status);
    return { ok: false, reason: res.status >= 500 ? 'unavailable' : 'invalid' };
  }

  let data: { success?: boolean } = {};
  try {
    data = (await res.json()) as { success?: boolean };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  return data.success === true ? { ok: true } : { ok: false, reason: 'invalid' };
}

/** 给用户看的那句话（两个入口共用，措辞保持一致） */
export function turnstileMessage(reason: 'invalid' | 'unavailable'): string {
  return reason === 'unavailable'
    ? '人机验证服务暂时不可用（不是你的问题），请稍后再试；一直不行就在 QQ 群里找站长'
    : '人机验证没通过 —— 请在上面的小方框里完成验证再提交；如果方框没出来，刷新一下页面（浏览器插件可能挡了它）';
}
