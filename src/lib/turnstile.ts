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
 * 给「提交」这类动作用的一句话检查：拿不到 token 就返回该给用户看的提示。
 * 页面自己决定怎么显示（有的用 form-error，有的用状态行）。
 *
 * 这里刻意分两种情况：**脚本/验证框根本没出来**（多半是浏览器隐私设置或插件挡了
 * challenges.cloudflare.com —— 2026-10-11 在 Edge 的跟踪防护下实测过）与
 * **框出来了但用户没点**。混成一句话会让被挡的人一直去找"那个方框"，而页面上根本没有框。
 */
export function turnstileHint(el: HTMLElement | null): string {
  if (!TURNSTILE_SITE_KEY) return '';
  const hasWidget = Boolean(el?.querySelector('iframe, input[name="cf-turnstile-response"]'));
  if (!el || !mounted.has(el) || !hasWidget) {
    return '人机验证框没加载出来 —— 多半是浏览器的隐私设置或插件挡住了 challenges.cloudflare.com。可以换 Chrome 试试、或把本站加入例外；一直不行就在 QQ 群里找站长，我们手动收你的稿子';
  }
  return '请先完成上面的人机验证（点一下那个小方框）';
}
