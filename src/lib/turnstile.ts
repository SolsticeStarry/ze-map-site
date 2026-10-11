/**
 * 前端：把 Turnstile 的 widget 挂到页面上，并取出 token 交给接口。
 *
 * 三个关键点（都是这类验证码最容易翻车的地方）：
 *   1. **token 一次性**：验证成功后 Cloudflare 发一个 token，用过就作废。
 *      提交失败后必须 `reset()` 换新的，否则用户改完再点会被判「验证没通过」——
 *      在他眼里就是「这站坏了」。
 *   2. **脚本是外站的**（challenges.cloudflare.com），可能被浏览器插件/网络挡掉。
 *      所以 `mountTurnstile()` 失败不能抛到调用方，要返回 false，
 *      页面照旧能用（配了 secret 时会被服务端拦下并给出提示，这是对的：
 *      没验证就是不能提交；但页面本身不能白屏）。
 *   3. **本地开发用官方测试 key**（永远通过），见 shared/turnstile.mjs。
 *      这样开发者不用往 widget 的域名白名单里加 localhost。
 */

import { LOCAL_TEST_SITE_KEY, siteKeyFor, TURNSTILE_SITE_KEY } from '../../shared/turnstile.mjs';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id?: string): void;
  remove(id?: string): void;
  getResponse(id?: string): string;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/** 挂载过的 widget：容器 → { id, token } */
const mounted = new WeakMap<HTMLElement, { id: string; token: string }>();
let scriptPromise: Promise<TurnstileApi | null> | null = null;

/** 这个环境要不要渲染 widget（没配 site key 就整段跳过） */
export function turnstileEnabled(): boolean {
  return Boolean(siteKeyFor(location.host));
}

function loadScript(): Promise<TurnstileApi | null> {
  scriptPromise ??= new Promise<TurnstileApi | null>((resolve) => {
    if (window.turnstile) return resolve(window.turnstile);
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve(window.turnstile ?? null);
    /* 被插件挡了 / 网络不通：给调用方一个 null，页面继续可用 */
    s.onerror = () => resolve(null);
    document.head.append(s);
    /* 兜底：8 秒还没好就别让表单永远等着 */
    setTimeout(() => resolve(window.turnstile ?? null), 8000);
  });
  return scriptPromise;
}

/**
 * 把 widget 渲染进容器。
 * @returns 渲染成功与否（失败只是"没有验证框"，不影响页面其它功能）
 */
export async function mountTurnstile(el: HTMLElement | null): Promise<boolean> {
  if (!el || mounted.has(el)) return mounted.has(el);
  if (!TURNSTILE_SITE_KEY) return false;
  const api = await loadScript();
  if (!api) return false;
  try {
    const id = api.render(el, {
      sitekey: siteKeyFor(location.host),
      /* 跟着站点主题走，别在暗色页面上蹦出一个白方块 */
      theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
      /* 撑满容器宽度：页头的面板只有 336px，固定 300px 会溢出 */
      size: 'flexible',
      language: 'zh-cn',
      callback: (token: string) => {
        const rec = mounted.get(el);
        if (rec) rec.token = token;
      },
      'expired-callback': () => {
        const rec = mounted.get(el);
        if (rec) rec.token = '';
      },
    });
    mounted.set(el, { id, token: '' });
    return true;
  } catch {
    return false;
  }
}

/** 取当前 token（没验证完 / 已过期 → 空串） */
export function turnstileToken(el: HTMLElement | null): string {
  if (!el) return '';
  return mounted.get(el)?.token ?? '';
}

/** 提交失败后换一个新的（token 一次性，不换就会被判「验证没通过」） */
export function resetTurnstile(el: HTMLElement | null): void {
  if (!el) return;
  const rec = mounted.get(el);
  if (!rec) return;
  rec.token = '';
  try {
    window.turnstile?.reset(rec.id);
  } catch {
    /* 忽略：reset 失败也不该影响页面 */
  }
}

/**
 * 提交前取 token：**先等一会儿**，再决定拦不拦。
 *
 * 为什么不是「没 token 就立刻拦」：
 *   · widget 是异步渲染的，自动通过（Managed 模式）通常 < 1 秒 —— 手快的人先点了提交，
 *     立刻拦下就会看到「请先完成验证」这种莫名其妙的提示（2026-10-11 实测踩到）；
 *   · 而 widget **压根没渲染出来**时（脚本被浏览器隐私设置/插件挡了），这里**不拦**，
 *     把请求交给服务端判断：没配 secret 就放行（不能因为浏览器设置把正常用户锁在门外），
 *     配了 secret 就由服务端回一句带解决办法的提示。
 *
 * @returns `{ token, blocked }`：blocked=true 表示「框在页面上、但一直没通过」，本地提示即可
 */
export async function takeTurnstileToken(
  el: HTMLElement | null,
  ms = 3000
): Promise<{ token: string; blocked: boolean }> {
  if (!TURNSTILE_SITE_KEY) return { token: '', blocked: false };
  /* 没挂上、或者挂上了但 Cloudflare 什么都没渲染出来 → 交给服务端 */
  if (!el || !mounted.has(el) || !el.querySelector('iframe, input[name="cf-turnstile-response"]')) {
    return { token: '', blocked: false };
  }
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const token = turnstileToken(el);
    if (token) return { token, blocked: false };
    await new Promise((r) => setTimeout(r, 120));
  }
  return { token: turnstileToken(el), blocked: !turnstileToken(el) };
}

/** 框在、但没验证完时给用户看的话（框都没出来时不会走到这里，见上） */
export function turnstileHint(): string {
  return '请先完成上面的人机验证（点一下那个小方框）再提交';
}
