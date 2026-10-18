/**
 * 账号系统（P4）—— 注册 / 登录 / 我的投稿 / 等级权益。
 *
 * 设计上的四条硬规矩（都是为了让账号系统**不拖累站点**）：
 *   1. **登录是可选的**：不登录照样能投稿，匿名通道一行没动。所以登录坏了、D1 抽风了，
 *      都不会挡住任何贡献 —— 页面本身更是静态优先，压根不执行这段代码。
 *   2. **会话是无状态的签名 Cookie**：不建 sessions 表、不查 KV（KV 免费版每天只让写 1000 次，
 *      前面已经踩过坑）。Cookie 里放 `{u:用户id, v:口令版本, t:签发时间}` + HMAC 签名。
 *   3. **不在仓库里存任何用户数据**：账号只在 D1；头像（如果以后要做）只进 R2。
 *   4. **口令只存派生值**：PBKDF2-SHA256 / 10 万次迭代 / 每用户随机盐（10 万是 Cloudflare
 *      的硬上限，见下面 PBKDF2_ITER 的说明）。
 *
 * 登录状态怎么用：`getSessionUser()` 在投稿接口里读一次，把投稿的 `user_id` 写上、
 * 并用**账号昵称**覆盖手填昵称（防止冒名）。等级与免审权益由已通过/被驳回条数算出来。
 */

import { allowWrite, fail, isBanned, isLocalHost, json, readJsonBody, safeEqual, type Env } from './http';
import { turnstileMessage, verifyTurnstile } from './turnstile';
import { checkNicknameContent, nicknameRejectMessage, normalizeName, parseExtraBlocklist } from '../shared/nickname-rules.mjs';
import { loadAgreed, type AgreedUp } from './videos';
import { listContributors } from './community';
/*
 * 收件箱（2026-10-14）：账号类的通知（停用/恢复/重置口令/改名/称号）在这里写。
 * notifications.ts **不** import 本文件（登录态由 index.ts 解析后传进去），所以这条依赖是单向的。
 */
import { pushNotification } from './notifications';

/* ===== 常量 ===== */

/** Cookie 名 */
const COOKIE = 'zc_sess';
/** 会话有效期 90 天 */
const SESSION_TTL = 90 * 24 * 60 * 60;
/**
 * GitHub 登录（OAuth）用的 state Cookie（2026-10-14 加）。
 * 只活 10 分钟、只用于「这一次授权请求」——GitHub 不支持 PKCE，state 是唯一的 CSRF 防线。
 */
const GH_STATE_COOKIE = 'zc_gh_state';
const GH_STATE_TTL = 10 * 60;
/** GitHub 登录只读公开资料，**不申请 user:email**（本站本来就不收邮箱） */
const GH_SCOPE = 'read:user';
/** 没有口令的账号（GitHub 建的号）在 pass_hash 里写的哨兵前缀 */
const GH_PASS_PREFIX = 'github$';
/**
 * PBKDF2 迭代次数。
 *
 * ⚠️ **不能超过 10 万** —— Cloudflare Workers 的 WebCrypto 有硬上限，超了直接抛：
 *   `NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported`
 * 这个坑 2026-10-11 在线上踩到了：本地 Node 的 WebCrypto 没有这个限制，
 * 所以单测全绿、线上注册接口 100% 500（`?lite=1` 与「登录不存在的昵称」都不哈希，看不出来）。
 * 改这个数字前先看 `worker/auth.test.mjs` 里那条断言 —— 它专门拦这件事。
 */
const PBKDF2_ITER = 100_000;
/** 昵称长度 */
const NAME_MIN = 2;
const NAME_MAX = 20;
/** 口令长度（不搞复杂字符要求：长比复杂更有效） */
const PASS_MIN = 8;
const PASS_MAX = 72;

/** 令牌桶：登录用的桶（同一 IP 每小时最多几次） */
const LOGIN_PER_HOUR = 30;

/*
 * ===== 防「大量注册」（2026-10-11 加的一层）=====
 *
 * 站长问「这种简单的注册方式会不会被人恶意刷」。答案不是「登录会被打穿」（口令是
 * PBKDF2 派生的、会话是签名的），而是**额度**：D1 免费版每天只有 10 万行写，
 * 一次注册要写 2~3 行；分布式刷号能把这个额度吃光，**连累投票和投稿一起写不进去**
 * —— 那是唯一会让正常用户受影响的路径。所以这里按「四道闸」递减：
 *
 *   1. 单 IP 每小时 3 个 —— 拦脚本（正常人一小时注册不了 3 个号）；
 *   2. 单 IP 每天 3 个   —— 站长定的硬线：**一个出口最多贡献 3 个账号**；
 *   3. 全站 24 小时 200 个 —— 兜底，同时也是「昵称被抢注」的上限
 *      （200 × 3 行 ≈ 600 行写入，才占 D1 每日 10 万行额度的 0.6%，所以这条
 *      不再是"省额度"，而是"别让机器人一天占掉几百个昵称"）；
 *   4. 保留昵称 + 审核台封号 —— 拦住冒充与已发现的滥用者。
 *
 * 注意第 2 条的副作用：**同一个网络出口（宿舍 / 公司 / 学校）一天只能注册 3 个账号**。
 * 超了的人会在 QQ 群里找站长 —— 这也是为啥保留昵称名单里没放已知贡献者的名字。
 * 另外不登录本来就能投稿，所以就算注册被限流，也没有人被挡在贡献之外。
 */
const REGISTER_PER_HOUR = 3;
const REGISTER_PER_DAY = 3;
const NEW_ACCOUNTS_PER_DAY = 200;
/**
 * GitHub 建号的**小时**上限（按 IP）。
 * 为什么不用 REGISTER_PER_DAY=3：那道闸是给匿名注册防刷号的（随便填个昵称就能开号）；
 * GitHub 账号本身有成本，而同一个出口后面可能坐着好几位都在用 GitHub 登录的人。
 * 全站 200/24h 那一层照旧兜底。
 */
const GH_REGISTER_PER_HOUR = 20;

/** 连续口令错几次就锁账号（挡「换 IP 接着猜同一个账号」） */
const MAX_LOGIN_FAILS = 5;
/** 锁多久（分钟） */
const LOCK_MINUTES = 15;

/**
 * 保留昵称：这些名字只会被用来冒充站方（署名里出现「站长」很吓人），一律不许注册。
 * 已知贡献者的昵称（SiKi / 白叶 …）**故意不在这里** —— 占了他们的名字由人工处理
 * （回填历史功劳之前会先确认人是谁），比在这里一刀切更稳。
 */
const RESERVED_NAMES = new Set([
  '站长',
  '管理员',
  '管理',
  'admin',
  'administrator',
  'official',
  '官方',
  '客服',
  '版主',
  'ze-map',
  'zemap',
  '地图资料站',
]);

export interface UserRow {
  id: number;
  name: string;
  pass_hash: string;
  pass_ver: number;
  contact: string | null;
  created_at: number;
  last_login: number | null;
  banned: number;
  approved: number;
  rejected: number;
  /** 连续口令错误次数（成功登录清零） */
  fail_count?: number;
  /** 锁定到什么时候（毫秒时间戳；null = 没锁） */
  locked_until?: number | null;
  /** 对应哪位 B 站 UP 主（授权 UP 主称号；见 ensureSchema 里的说明） */
  up_name?: string | null;
  /** 对应哪些 GitHub 用户名（逗号分隔；仓库贡献者称号） */
  gh_names?: string | null;
  /** 绑定过的 GitHub 数字 id（GitHub 登录用；无口令账号的 pass_hash 是 `github$<id>`） */
  gh_id?: number | null;
  /** 绑定的 GitHub 登录名（会随改名更新） */
  gh_login?: string | null;
  /** 什么时候绑的 */
  gh_linked_at?: number | null;
  /** GitHub 头像地址（只用于个人主页展示） */
  gh_avatar?: string | null;
}

/**
 * 等级：按**已通过**的投稿条数算（同图同字段只算一次，见 recalcUserStats 的去重口径）。
 *
 * 最上面那一档（资料奠基人，80 条）是站长 2026-10-11 特意加的：SiKi 一个人铺了 82 处资料
 * （全站 123 条投稿里的大头），当时的最高档「百科元老」50 条对他来说太容易 ——
 * 加一档让"把整站资料从零铺起来"这件事有个够得着但极难到的位置。
 * 想再加档就往这个数组里插一行（**必须按 min 从大到小**，levelOf 是按顺序 find 的）。
 */
const LEVELS: Array<{ min: number; name: string; hint: string }> = [
  { min: 80, name: '资料奠基人', hint: '站里最早那一大批资料，是你一条条铺出来的' },
  { min: 50, name: '百科元老', hint: '这条线的内容多半是你铺的' },
  { min: 25, name: '荣誉编辑', hint: '长期稳定地补资料的几位之一' },
  { min: 10, name: '资深编辑', hint: '已经能独立补完一张图的资料' },
  { min: 5, name: '资料整理者', hint: '补过好几张图了' },
  { min: 1, name: '入门贡献者', hint: '第一篇稿子已经进站' },
  { min: 0, name: '路人', hint: '还没投过，欢迎来补第一笔' },
];

/** 等级 + 权益。免审门槛：通过 ≥10 条、且驳回占比 ≤20%（驳回 ≤ 通过/5） */
export function levelOf(approved: number, rejected: number) {
  const lv = LEVELS.find((l) => approved >= l.min) ?? LEVELS[LEVELS.length - 1];
  const next = [...LEVELS].reverse().find((l) => l.min > approved) ?? null;
  return {
    level: lv.name,
    hint: lv.hint,
    approved,
    rejected,
    next: next ? { level: next.name, need: next.min - approved } : null,
    /** 免审直发：投稿直接进「待写回」队列，不再需要人工点通过 */
    trusted: approved >= 10 && rejected <= Math.floor(approved / 5),
  };
}

/* ===== 口令 ===== */

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pbkdf2(password: string, salt: Uint8Array, iter: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt as BufferSource, iterations: iter, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = /^pbkdf2\$(\d+)\$([^$]+)\$([^$]+)$/.exec(stored);
  if (!m) return false;
  const iter = Number(m[1]);
  if (!Number.isFinite(iter) || iter < 1000) return false;
  /*
   * 迭代次数写在哈希串里，所以以后调这个数字**不会让老口令失效**。
   * 运行时上限（10 万）由 crypto 自己把关：万一存了一个超限的值，这里会抛，
   * 但那种记录只可能来自「本地测试库」或更早的版本，线上从来没有过
   * （register 在写入之前就失败了，见 PBKDF2_ITER 上面的说明）。
   */
  const hash = await pbkdf2(password, unb64(m[2]), iter);
  return safeEqual(b64(hash), m[3]);
}

/* ===== 会话（签名 Cookie） ===== */

/**
 * 签名密钥：优先 `SESSION_SECRET`，没配就用 `IP_SALT` 派生。
 * 为什么不强求新密钥：`wrangler secret put` 只有站长能执行（本机 token 没这个权限），
 * 而 IP_SALT 本来就是仅存于 Worker 的高熵密钥，拿来派生签名密钥是安全的。
 */
async function sessionKey(env: Env): Promise<CryptoKey> {
  const secret = env.SESSION_SECRET || env.IP_SALT || 'local-dev-only';
  /*
   * ⚠️ HMAC 这里必须写成 `{ name, hash }`，不能图省事写字符串 'HMAC'：
   * HmacImportParams 的 hash 是**必填**，按 WebCrypto 规范写 'HMAC' 会直接抛
   * 「hash is required in 'HmacImportParams'」—— 整个注册接口 500（本机测出来的）。
   */
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`ze-map-session:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  return base;
}

async function sign(env: Env, payload: string): Promise<string> {
  const key = await sessionKey(env);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return b64(new Uint8Array(sig));
}

async function makeToken(env: Env, user: { id: number; pass_ver: number }): Promise<string> {
  const payload = b64(new TextEncoder().encode(JSON.stringify({ u: user.id, v: user.pass_ver, t: Math.floor(Date.now() / 1000) })));
  return `${payload}.${await sign(env, payload)}`;
}

function readCookie(request: Request, name: string): string {
  const raw = request.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function cookieHeader(env: Env, url: URL, token: string | null, maxAge: number): string {
  /* 本地开发是 http，带 Secure 的话浏览器直接不收 —— 所以只在非本地加 */
  const secure = isLocalHost(url.host) ? '' : '; Secure';
  const value = token ?? '';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/** state Cookie（HttpOnly；SameSite=Lax 才收得到 GitHub 302 回来的那一次请求） */
function ghStateCookie(env: Env, url: URL, value: string | null, maxAge: number): string {
  const secure = isLocalHost(url.host) ? '' : '; Secure';
  return `${GH_STATE_COOKIE}=${value ?? ''}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/* ===== GitHub 登录（2026-10-14 加） =====
 *
 * 定位：**可选的一条路**，不是必选项。口令注册 / 登录一行没动，不登录也能投稿这条底线也不动；
 * 没配密钥时整条路自动关闭（页面上的按钮换成一句说明），不会出现「点了没反应」。
 *
 * 为什么值得做（除了「少记一个口令」）：
 *   · 本站已经在用 GitHub（投稿写回、贡献者名单），登录一次就能**自动核对贡献者称号**，
 *     不必再让站长手填用户名；
 *   · 不新增任何个人信息：只读 `read:user`（登录名/头像/数字 id），**不申请 user:email**。
 *
 * 安全要点（都在下面的实现里）：
 *   · `state` 随机值 + HttpOnly Cookie 比对（GitHub 不支持 PKCE，这是唯一的 CSRF 防线）；
 *   · **access_token 不落库**：只用来读一次 profile 就丢，我们不需要以用户身份调 GitHub；
 *   · 已登录时走**绑定**，未登录时按 `gh_id` 找回；**绝不按昵称自动认领**（那是账号劫持）；
 *   · 昵称冲突、保留名、已占用名都走现有 checkName()，冲突就换一个候选名，不影响登录。
 */

interface GhOAuthConfig {
  id: string;
  secret: string;
  /** 授权站（线上是 https://github.com；测的时候可以指向假站） */
  base: string;
  /** API 站（线上是 https://api.github.com） */
  api: string;
}

/** 配好了才启用；没配返回 null（调用方据此给出「本站没开」的提示） */
function ghOAuthConfig(env: Env): GhOAuthConfig | null {
  const id = String(env.GITHUB_OAUTH_CLIENT_ID ?? '').trim();
  const secret = String(env.GITHUB_OAUTH_CLIENT_SECRET ?? '').trim();
  if (!id || !secret) return null;
  return {
    id,
    secret,
    base: String(env.GITHUB_OAUTH_BASE ?? 'https://github.com').replace(/\/+$/, ''),
    api: String(env.GITHUB_API_BASE ?? 'https://api.github.com').replace(/\/+$/, ''),
  };
}

/** 本站是否开了 GitHub 登录（/api/me 会带上它，页面据此决定显示按钮还是说明） */
export function githubLoginEnabled(env: Env): boolean {
  return ghOAuthConfig(env) !== null;
}

/** 回调地址固定挂 /api/ 下（静态资源层接不到 /api/*，见 wrangler.jsonc 的 run_worker_first） */
const ghCallbackUrl = (url: URL) => new URL('/api/auth/github/callback', url.origin).href;

const b64url = (bytes: Uint8Array) =>
  b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 32 字节随机 state */
function newState(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * 把 GitHub 昵称变成候选站内昵称：先原样（过 checkName），
 * 不行就依次试 `login-2`、`login-3`、`gh-login`、`gh-<id>` —— 都不行就报错让用户自己注册后绑定。
 */
function ghNameCandidates(login: string, ghId: number): string[] {
  const base = login.replace(/[^A-Za-z0-9_-]/g, '').slice(0, NAME_MAX);
  const out = [login, base, `${base}-2`, `${base}-3`, `gh-${base}`.slice(0, NAME_MAX), `gh-${ghId}`];
  return [...new Set(out.filter((x) => x.length >= NAME_MIN))];
}

/** 一次 GitHub 调用的超时保护：授权站抽风时别把用户吊在那里 */
async function ghFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/auth/github/start
 * 生成 state（写 HttpOnly Cookie）→ 302 到 GitHub 授权页。
 */
export async function handleGithubStart(request: Request, env: Env, url: URL): Promise<Response> {
  const cfg = ghOAuthConfig(env);
  if (!cfg) return fail('本站还没开启 GitHub 登录（站长未配置）—— 用昵称 + 口令注册即可', 503);

  const state = newState();
  const authorize =
    `${cfg.base}/login/oauth/authorize?` +
    new URLSearchParams({
      client_id: cfg.id,
      redirect_uri: ghCallbackUrl(url),
      scope: GH_SCOPE,
      state,
      allow_signup: 'true',
    }).toString();

  return new Response(null, {
    status: 302,
    headers: {
      location: authorize,
      'set-cookie': ghStateCookie(env, url, state, GH_STATE_TTL),
      'cache-control': 'no-store',
    },
  });
}

/** 出问题一律 302 回 /account/ 并带一句人话（别把用户留在 JSON 错误页上） */
function ghBackToAccount(url: URL, params: Record<string, string>, cookies: string[] = []): Response {
  const target = new URL('/account/', url.origin);
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  const res = new Response(null, { status: 302, headers: { location: target.href, 'cache-control': 'no-store' } });
  for (const c of cookies) res.headers.append('set-cookie', c);
  return res;
}

/**
 * GET /api/auth/github/callback?code=&state=
 *
 * 三种落点：
 *   1. 这个 GitHub 号**已经绑过**某个站内账号 → 直接登录那个账号；
 *   2. 当前**已登录**（想让已有账号绑上 GitHub）→ 绑定到当前账号；
 *   3. 都没匹配上 → 用 GitHub 登录名建一个新账号（昵称冲突就换候选名）。
 */
export async function handleGithubCallback(request: Request, env: Env, url: URL, ipHash: string): Promise<Response> {
  const cfg = ghOAuthConfig(env);
  const clearState = ghStateCookie(env, url, null, 0);
  if (!cfg) return ghBackToAccount(url, { gh: 'off' }, [clearState]);
  /* 懒建表先跑一遍：老库还没有 gh_* 那几列（下面任何一条查询都会用到） */
  await ensureSchema(env);

  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  const cookieState = readCookie(request, GH_STATE_COOKIE);
  const deny = url.searchParams.get('error'); // 用户在 GitHub 点了取消
  if (deny) return ghBackToAccount(url, { gh: 'cancel' }, [clearState]);

  /* state 必须与 Cookie 里那一个**完全一致**（constant-time 比较），否则一律拒 */
  if (!code || !state || !cookieState || !safeEqual(state, cookieState)) {
    return ghBackToAccount(url, { gh: 'state' }, [clearState]);
  }

  if (await isBanned(env, ipHash)) return ghBackToAccount(url, { gh: 'banned' }, [clearState]);
  await ensureSchema(env);

  /* ① 用 code 换 access_token（只活这一次请求，不落库） */
  let accessToken = '';
  try {
    const res = await ghFetch(`${cfg.base}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'ze-map-site' },
      body: JSON.stringify({
        client_id: cfg.id,
        client_secret: cfg.secret,
        code,
        redirect_uri: ghCallbackUrl(url),
      }),
    });
    const raw = await res.text();
    let data: { access_token?: string; error?: string; error_description?: string } = {};
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      /* 非 JSON（极少见）：留空，下面统一记日志 */
    }
    accessToken = String(data?.access_token ?? '');
    if (!accessToken) {
      /*
       * 失败原因记进日志（`wrangler tail` 能直接看到）—— 排查「点了 GitHub 登录却回到
       * gh=token」时，没有这一行就只能猜。常见：code 过期/已用过（GitHub 回 404 Not Found）、
       * redirect_uri 与注册值不一致、secret 换过。
       * ⚠️ 日志里**只打错误码与描述**，绝不打印 token 或 secret。
       */
      console.error(
        `GitHub 换 token 失败：HTTP ${res.status} · ${String(data?.error ?? '')} ${String(data?.error_description ?? '')}`.slice(0, 300)
      );
      return ghBackToAccount(url, { gh: 'token' }, [clearState]);
    }
  } catch (err) {
    console.error('GitHub 换 token 异常：' + (err instanceof Error ? err.message : String(err)));
    return ghBackToAccount(url, { gh: 'token' }, [clearState]);
  }

  /* ② 读公开资料（不再用这个 token 做别的事） */
  let ghId = 0;
  let login = '';
  let avatar = '';
  try {
    const res = await ghFetch(`${cfg.api}/user`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'ze-map-site' },
    });
    if (!res.ok) {
      console.error(`GitHub 读资料失败：HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);
      return ghBackToAccount(url, { gh: 'profile' }, [clearState]);
    }
    const prof = (await res.json()) as { id?: number; login?: string; avatar_url?: string };
    ghId = Number(prof?.id ?? 0);
    login = String(prof?.login ?? '').trim();
    avatar = String(prof?.avatar_url ?? '');
    if (!ghId || !login) {
      console.error('GitHub 资料缺 id/login：' + JSON.stringify(prof).slice(0, 160));
      return ghBackToAccount(url, { gh: 'profile' }, [clearState]);
    }
  } catch (err) {
    console.error('GitHub 读资料异常：' + (err instanceof Error ? err.message : String(err)));
    return ghBackToAccount(url, { gh: 'profile' }, [clearState]);
  }

  /* ③ 这个 GitHub 号是不是已经绑过账号 */
  const linked = await env.DB.prepare(`SELECT * FROM users WHERE gh_id = ?1`).bind(ghId).first<UserRow>();
  const current = await getSessionUser(request, env);

  /* 贡献者称号：只有真的在仓库贡献者名单里才自动挂（拿不到名单就跳过，不影响登录） */
  const isContributor = await contributorHit(env, login);

  if (linked) {
    if (current && current.id !== linked.id) {
      /* 同一个 GitHub 号想绑到第二个账号：拒。否则一个 GitHub 身份能开两扇门 */
      return ghBackToAccount(url, { gh: 'taken' }, [clearState]);
    }
    if (linked.banned) return ghBackToAccount(url, { gh: 'disabled' }, [clearState]);
    await touchGithubLogin(env, linked, ghId, login, avatar, isContributor);
    const fresh = await env.DB.prepare(`SELECT * FROM users WHERE id = ?1`).bind(linked.id).first<UserRow>();
    const token = await makeToken(env, fresh ?? linked);
    return ghBackToAccount(url, { gh: 'ok' }, [
      clearState,
      cookieHeader(env, url, token, SESSION_TTL),
    ]);
  }

  if (current) {
    /* 已登录 → 绑定到当前账号（若它已经绑过别的 GitHub 号，先让用户解绑） */
    if (Number(current.gh_id ?? 0)) {
      return ghBackToAccount(url, { gh: 'already' }, [clearState]);
    }
    await touchGithubLogin(env, current, ghId, login, avatar, isContributor);
    return ghBackToAccount(url, { gh: 'bound' }, [clearState]);
  }

  /* ④ 新账号：昵称按候选名依次试（checkName + 唯一索引双保险） */
  let chosen = '';
  for (const cand of ghNameCandidates(login, ghId)) {
    const checked = checkName(cand, env);
    if (!checked.ok) continue;
    const used = await env.DB.prepare(`SELECT id FROM users WHERE name_key = ?1`)
      .bind(nameKey(checked.value))
      .first<{ id: number }>();
    if (used) continue;
    chosen = checked.value;
    break;
  }
  if (!chosen) {
    /* 名字全被占了：不硬塞，让用户自己注册一个昵称再来绑定（体验差一点，但绝不越权） */
    return ghBackToAccount(url, { gh: 'name' }, [clearState]);
  }

  /* 配额：GitHub 注册也占「全站新账号」这道闸，但不走「单 IP 3 个/天」——
     那是给匿名注册防刷号用的；GitHub 账号本身有成本，按上限更宽的小时桶来算。 */
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE created_at >= ?1`)
    .bind(Date.now() - 24 * 60 * 60 * 1000)
    .first<{ n: number }>();
  if (Number(recent?.n ?? 0) >= NEW_ACCOUNTS_PER_DAY) {
    return ghBackToAccount(url, { gh: 'quota' }, [clearState]);
  }
  if (!(await allowWrite(env, ipHash, 'gh-register', GH_REGISTER_PER_HOUR))) {
    return ghBackToAccount(url, { gh: 'rate' }, [clearState]);
  }

  let row: UserRow | null = null;
  try {
    row = await env.DB.prepare(
      `INSERT INTO users (name, name_key, pass_hash, contact, created_at, last_login, gh_id, gh_login, gh_linked_at, gh_names)
       VALUES (?1,?2,?3,NULL,?4,?4,?5,?6,?4,?7) RETURNING *`
    )
      .bind(
        chosen,
        nameKey(chosen),
        `${GH_PASS_PREFIX}${ghId}`,
        Date.now(),
        ghId,
        login,
        isContributor ? login : null
      )
      .first<UserRow>();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    /* 并发下撞唯一索引：当成「这个昵称刚被占」处理，让用户走「已注册 → 登录后绑定」 */
    if (/UNIQUE|constraint/i.test(msg)) return ghBackToAccount(url, { gh: 'name' }, [clearState]);
    throw err;
  }
  if (!row) return ghBackToAccount(url, { gh: 'fail' }, [clearState]);

  const token = await makeToken(env, row);
  return ghBackToAccount(url, { gh: 'new' }, [clearState, cookieHeader(env, url, token, SESSION_TTL)]);
}

/** 这个 GitHub 登录名在仓库贡献者名单里吗（拿不到名单 / 没配 token → false，静默跳过） */
async function contributorHit(env: Env, login: string): Promise<boolean> {
  try {
    const known = await listContributors(env);
    return known.has(login.toLowerCase()) || known.has(login);
  } catch {
    return false;
  }
}

/**
 * 记下 GitHub 身份。
 * `gh_names` 是**「仓库贡献者」称号**那一列（决定徽章），所以只有真的在贡献者名单里才写；
 * 只是绑定了 GitHub 的人不该凭空多一个称号 —— 称号是对外承诺，规则见 docs/admin-guide.md。
 */
async function touchGithubLogin(
  env: Env,
  user: UserRow,
  ghId: number,
  login: string,
  avatar: string,
  isContributor: boolean
): Promise<void> {
  const names = ghLogins(user);
  const has = names.some((x) => x.toLowerCase() === login.toLowerCase());
  const nextNames = isContributor && !has ? [...names, login].slice(0, 4).join(',') : names.join(',');
  await env.DB.prepare(
    `UPDATE users SET gh_id = ?1, gh_login = ?2, gh_linked_at = ?3, gh_avatar = ?4, gh_names = ?5 WHERE id = ?6`
  )
    .bind(
      /* 已经绑过就用原来的（同一个 GitHub 号，登录名可能改过）；没绑过就写上这次的 id */
      Number(user.gh_id ?? 0) || ghId,
      login,
      Date.now(),
      avatar || null,
      nextNames || null,
      user.id
    )
    .run();
}

/**
 * POST /api/auth/github/unbind（要登录）
 * 解绑前必须**有口令**，否则这个账号就再也登不进来了（本站不收邮箱，找回只能人工）。
 * 已经拿到的「仓库贡献者」称号**不撤**：人确实贡献过，称号和「这次绑定」是两件事。
 */
export async function handleGithubUnbind(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  const user = await getSessionUser(request, env);
  if (!user) return fail('请先登录', 401);

  const hasPassword = !String(user.pass_hash ?? '').startsWith(GH_PASS_PREFIX);
  if (!hasPassword) {
    return fail('这个账号还没有口令：先去「设置」里设一个口令，再来解绑 —— 否则你会把自己锁在外面', 400);
  }
  await env.DB.prepare(`UPDATE users SET gh_id = NULL, gh_login = NULL, gh_linked_at = NULL, gh_avatar = NULL WHERE id = ?1`)
    .bind(user.id)
    .run();
  const fresh = await env.DB.prepare(`SELECT * FROM users WHERE id = ?1`).bind(user.id).first<UserRow>();
  return json({ ok: true, user: publicUser(fresh ?? user), message: '已解绑 GitHub' });
}


export function setSessionCookie(env: Env, url: URL, data: unknown, token: string): Response {
  const res = json(data);
  res.headers.append('set-cookie', cookieHeader(env, url, token, SESSION_TTL));
  return res;
}

export function clearSessionCookie(env: Env, url: URL, data: unknown = { ok: true }): Response {
  const res = json(data);
  res.headers.append('set-cookie', cookieHeader(env, url, null, 0));
  return res;
}

/** 读登录用户；没登录 / 签名不对 / 口令已改 / 被封禁 → null */
export async function getSessionUser(request: Request, env: Env): Promise<UserRow | null> {
  const token = readCookie(request, COOKIE);
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = await sign(env, payload);
  if (!safeEqual(sig, expect)) return null;
  let data: { u?: number; v?: number; t?: number };
  try {
    data = JSON.parse(new TextDecoder().decode(unb64(payload))) as typeof data;
  } catch {
    return null;
  }
  if (!data.u || typeof data.t !== 'number') return null;
  if (Math.floor(Date.now() / 1000) - data.t > SESSION_TTL) return null;
  await ensureSchema(env);
  const row = await env.DB.prepare(`SELECT * FROM users WHERE id = ?1`).bind(data.u).first<UserRow>();
  if (!row || row.banned) return null;
  if (Number(row.pass_ver) !== Number(data.v)) return null; // 改过口令，旧 Cookie 作废
  return row;
}

/* ===== 懒建表 =====
 *
 * 为什么不用 `wrangler d1 migrations apply`：本机的 API token 只有 R2 权限（KV 都被拒过），
 * 跑不了 D1 迁移。所以让 Worker 自己在第一次用到账号功能时把表补上 —— 语句幂等，
 * 每个 isolate 只检查一次（`PRAGMA table_info` 一次轻量读）。
 *
 * ⚠️ 2026-10-14 修：以前这里**假定 submissions / bans / rate_limits 已经存在**
 * （生产的库是早先建好的，所以一直没暴露）。可一旦库是新的、或某张表被删掉，
 * 补列那句 `ALTER TABLE submissions …` 就会抛 `no such table: submissions`，
 * 而这句在一个大 try 里 —— 后面的 bans 就再也不会建，接着 `isBanned()` 直接 500，
 * 表现成「GitHub 登录/注册报服务器内部错误」（本机用全新的本地 D1 跑 E2E 时踩到）。
 * 现在：四张表都自己保证存在，且每一步各管各的失败 —— 一处坏不拖累其它。
 */
let schemaReady = false;

export async function ensureSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  /* 每一步单独兜错：任何一步失败都只记日志，不让后面的步骤被跳过 */
  const step = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`ensureSchema(${what}) 失败：` + (err instanceof Error ? err.message : String(err)));
    }
  };

  /*
   * 先保证几张基础表都存在：以前默认 submissions / bans / rate_limits 已经建好
   * （生产的库确实是），于是「新库」这条路从没走过 —— 一旦是空库，下面补列那句
   * ALTER TABLE submissions 就会抛错，把后面的 bans 一起带走（见上面的说明）。
   */
  await step('bans', () =>
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS bans (ip_hash TEXT PRIMARY KEY, reason TEXT, banned_at INTEGER NOT NULL)`
    ).run()
  );
  await step('rate_limits', () =>
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS rate_limits (
         ip_hash TEXT NOT NULL, window TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (ip_hash, window)
       )`
    ).run()
  );
  await step('submissions', () =>
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS submissions (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         map_slug TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL,
         note TEXT, submitter TEXT, contact TEXT, ip_hash TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
         reviewed_at INTEGER, reviewer TEXT, reject_note TEXT, commit_sha TEXT, error TEXT,
         user_id INTEGER, batch TEXT
       )`
    ).run()
  );
  await step('idx_sub_status', () =>
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_sub_status ON submissions (status, created_at)`).run()
  );

  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS users (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL,
         name_key TEXT NOT NULL UNIQUE,
         pass_hash TEXT NOT NULL,
         pass_ver INTEGER NOT NULL DEFAULT 1,
         contact TEXT,
         created_at INTEGER NOT NULL,
         last_login INTEGER,
         banned INTEGER NOT NULL DEFAULT 0,
         approved INTEGER NOT NULL DEFAULT 0,
         rejected INTEGER NOT NULL DEFAULT 0,
         fail_count INTEGER NOT NULL DEFAULT 0,
         locked_until INTEGER
       )`
    ).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_users_name_key ON users(name_key)`).run();
    /* 「过去 24 小时新增了几个账号」这个兜底闸要扫 created_at，给它建个索引 */
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at)`).run();

    /*
     * 老库补列。SQLite 没有 ADD COLUMN IF NOT EXISTS，只能先问 PRAGMA。
     * （这份 DDL 是幂等的：每个 isolate 只跑一次，失败只记日志不抛。）
     */
    const ucols = await env.DB.prepare(`PRAGMA table_info(users)`).all<{ name: string }>();
    const hasUserCol = (n: string) => (ucols.results ?? []).some((c) => c.name === n);
    if (!hasUserCol('fail_count')) {
      await env.DB.prepare(`ALTER TABLE users ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0`).run();
    }
    if (!hasUserCol('locked_until')) {
      await env.DB.prepare(`ALTER TABLE users ADD COLUMN locked_until INTEGER`).run();
    }
    /*
     * up_name：这个账号对应哪位 B 站 UP 主（2026-10-13 加）。
     * 用途是「授权 UP 主」称号：名单在 R2 的 video-meta/agreed.json（不在仓库里），
     * 而账号昵称和 B 站昵称不一定一致（站点账号「雨宫鹿奈」↔ UP「雨宫鹿奈_shikaNiko」），
     * 所以允许显式挂一个名字；没挂时按「账号昵称 === UP 昵称」自动认。
     */
    if (!hasUserCol('up_name')) {
      await env.DB.prepare(`ALTER TABLE users ADD COLUMN up_name TEXT`).run();
    }
    /*
     * gh_names：这个账号对应哪些 GitHub 用户名（逗号分隔），用于「仓库贡献者」称号（2026-10-13 加）。
     * 为什么是一列多个：同一个人可能有两个 GitHub 号（SiKi = trrrr-ai + MiKU，白叶 = xianoom + BaiYe），
     * 而站点上只有一个账号 —— 存一行、显示时拆开。
     * 发放同样**只人工**：管理台点「挂 GitHub 贡献者」，服务端拿仓库贡献者名单核对。
     */
    if (!hasUserCol('gh_names')) {
      await env.DB.prepare(`ALTER TABLE users ADD COLUMN gh_names TEXT`).run();
    }
    /*
     * GitHub 登录（2026-10-14 加）的四列：
     *   gh_id       GitHub 的数字 id（**登录时认它**，登录名会改名）、
     *   gh_login    当前登录名（展示用）、
     *   gh_linked_at 绑定时间、gh_avatar 头像地址（个人主页展示）。
     * 为什么另存 gh_id 而不是复用 gh_names：gh_names 是「仓库贡献者称号」，
     * 只有真在贡献者名单里的人才有；绑定了 GitHub 但没贡献过的人不该凭空多一个称号。
     */
    if (!hasUserCol('gh_id')) {
      await env.DB.prepare(`ALTER TABLE users ADD COLUMN gh_id INTEGER`).run();
    }
    if (!hasUserCol('gh_login')) {
      await env.DB.prepare(`ALTER TABLE users ADD COLUMN gh_login TEXT`).run();
    }
    if (!hasUserCol('gh_linked_at')) {
      await env.DB.prepare(`ALTER TABLE users ADD COLUMN gh_linked_at INTEGER`).run();
    }
    if (!hasUserCol('gh_avatar')) {
      await env.DB.prepare(`ALTER TABLE users ADD COLUMN gh_avatar TEXT`).run();
    }
    /* 一个 GitHub 号只能绑一个站内账号：靠**部分唯一索引**兜住并发（NULL 不算冲突） */
    try {
      await env.DB.prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_gh ON users(gh_id) WHERE gh_id IS NOT NULL`
      ).run();
    } catch {
      /* 索引建不起来（老库里有脏数据）不该拖垮账号系统：登录路径里还有一次显式查询兜着 */
    }

    /* submissions.user_id：老的库没有这一列，补上 */
    const cols = await env.DB.prepare(`PRAGMA table_info(submissions)`).all<{ name: string }>();
    if (!(cols.results ?? []).some((c) => c.name === 'user_id')) {
      await step('submissions.user_id', () =>
        env.DB.prepare(`ALTER TABLE submissions ADD COLUMN user_id INTEGER`).run()
      );
    }
    /* submissions.batch：批量投稿（2026-10-13）用，同一批共用一个短 id */
    if (!(cols.results ?? []).some((c) => c.name === 'batch')) {
      await step('submissions.batch', () => env.DB.prepare(`ALTER TABLE submissions ADD COLUMN batch TEXT`).run());
    }
    /*
     * submissions.adopted_at：这条整篇草稿**已经被采纳为原稿**的时间（2026-10-15 加）。
     * 以前只把「已采纳」记在社区文档（data/community/<slug>.json 的 fields.draft）里，
     * D1 完全不知情 —— 于是审核台的「整篇草稿 · 待采纳」里，采纳过的草稿会一直堆着，
     * 越攒越多、又没法从列表里排掉（站长报的就是这个）。现在采纳时顺手记一笔，
     * 队列按它把已采纳的从「待采纳」里排除（要看得显式带 adopted=1）。
     */
    if (!(cols.results ?? []).some((c) => c.name === 'adopted_at')) {
      await step('submissions.adopted_at', () =>
        env.DB.prepare(`ALTER TABLE submissions ADD COLUMN adopted_at INTEGER`).run()
      );
    }
    await step('idx_sub_user', () =>
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_sub_user ON submissions(user_id, created_at)`).run()
    );
    schemaReady = true;
  } catch (err) {
    /* 建表失败不能把整个接口打死：记日志，让调用方按「没有账号系统」继续跑 */
    console.error('ensureSchema 失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

/* ===== 统计与校验 ===== */

/**
 * 重新计算某个账号的通过 / 驳回条数。
 * 口径：**每张图的每个字段只算一次**，避免「把一次改动拆成好几条提交」刷等级；
 * 图片集（gallery）按条算不了，也归到「该图的 gallery 字段只算一次」。
 */
export async function recalcUserStats(env: Env, userId: number): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(DISTINCT CASE WHEN status = 'applied' THEN map_slug || '|' || field END) AS ok,
       COUNT(DISTINCT CASE WHEN status = 'rejected' THEN map_slug || '|' || field END) AS no
     FROM submissions WHERE user_id = ?1`
  )
    .bind(userId)
    .first<{ ok: number; no: number }>();
  await env.DB.prepare(`UPDATE users SET approved = ?1, rejected = ?2 WHERE id = ?3`)
    .bind(row?.ok ?? 0, row?.no ?? 0, userId)
    .run();
}

/** 投稿时的账号校验结果：登录了就把投稿挂到账号上 */
export async function accountForSubmit(
  request: Request,
  env: Env
): Promise<{ id: number | null; name: string | null; trusted: boolean }> {
  /*
   * 先把懒建表跑一遍（幂等，每个 isolate 只查一次 PRAGMA）：
   * 匿名投稿本身不需要账号表，但**带上 user_id 的 INSERT 需要那一列存在**，
   * 而这一列是账号系统上线后才加的。先在这里补齐，投稿那条路就不会踩到缺列。
   */
  await ensureSchema(env);
  const user = await getSessionUser(request, env).catch(() => null);
  if (!user) return { id: null, name: null, trusted: false };
  const { trusted } = levelOf(user.approved, user.rejected);
  return { id: user.id, name: user.name, trusted };
}

/*
 * 昵称里不许有的内容（广告 / 违法 / 联系方式 / 乱码）：见 shared/nickname-rules.mjs。
 *
 * 额外词表（政治等敏感词）**不进仓库**，放在 Worker 变量 `NICKNAME_EXTRA` 里 ——
 * 线上是 Cloudflare 从仓库构建的，本地文件到不了线上；而且没必要把「过滤哪些词」公示出去。
 * 按 isolate 缓存 5 分钟：词表改完不用重新部署，等几分钟自然生效。
 */
let extraCache: { raw: string; at: number; list: string[] } | null = null;
function extraBlocklist(env: Env): string[] {
  const raw = env.NICKNAME_EXTRA ?? '';
  const now = Date.now();
  if (extraCache && extraCache.raw === raw && now - extraCache.at < 5 * 60 * 1000) return extraCache.list;
  const list = parseExtraBlocklist(raw);
  extraCache = { raw, at: now, list };
  return list;
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 昵称校验：格式（长度/字符）→ 保留名（防冒充）→ 内容（广告/违法/联系方式/乱码）。
 * 内容那一层**归一化之后再查**，所以「管 理 员」「4dmin」「ＡＤＭＩＮ」都拦得住。
 */
function checkName(raw: unknown, env?: Env): { ok: true; value: string } | { ok: false; error: string } {
  const v = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (v.length < NAME_MIN) return { ok: false, error: `昵称至少 ${NAME_MIN} 个字` };
  if (v.length > NAME_MAX) return { ok: false, error: `昵称最多 ${NAME_MAX} 个字` };
  if (/[<>{}[\]|*?/\\"']/.test(v)) return { ok: false, error: '昵称里有不支持的字符（< > { } [ ] | * ? / \\ " \'）' };
  /* 冒充站方的名字不许注册：署名里出现「站长」会让投稿人身份失真 */
  const norm = normalizeName(v);
  if (RESERVED_NAMES.has(nameKey(v)) || RESERVED_NAMES.has(norm)) {
    return { ok: false, error: '这个昵称是保留的（避免冒充站方），换一个吧' };
  }
  if (env) {
    const content = checkNicknameContent(v, extraBlocklist(env));
    if (!content.ok) return { ok: false, error: nicknameRejectMessage(content.reason) };
  }
  return { ok: true, value: v };
}

function checkPassword(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const v = String(raw ?? '');
  if (v.length < PASS_MIN) return { ok: false, error: `口令至少 ${PASS_MIN} 位` };
  if (v.length > PASS_MAX) return { ok: false, error: `口令最多 ${PASS_MAX} 位` };
  return { ok: true, value: v };
}

/** 对外的用户信息（绝不回传 pass_hash） */
function publicUser(user: UserRow, up?: AgreedUp | null) {
  return {
    id: user.id,
    name: user.name,
    contact: user.contact ?? '',
    createdAt: user.created_at,
    ...levelOf(user.approved, user.rejected),
    /*
     * 「授权 UP 主」称号（2026-10-13 加）：账号**被站长人工挂到**某位已同意的 UP 主上时才带这个字段，
     * 页面据此在昵称旁显示徽章。名单读不到 / 没挂过 → undefined，页面什么都不显示。
     * 只看 up_name，不看昵称是否重名 —— 理由见 agreedUpFor 的注释。
     */
    ...(up ? { up: { name: up.u, mid: up.m, videos: up.videos, maps: up.maps.length } } : {}),
    /*
     * 「仓库贡献者」称号（2026-10-13 加）：账号被人挂上 GitHub 用户名时带这个字段。
     * 显示成名字旁边的小徽章，点开是他在 GitHub 的主页（多个号就给仓库贡献者列表）。
     */
    ...(ghLogins(user).length
      ? {
          gh: {
            logins: ghLogins(user),
            url:
              ghLogins(user).length === 1
                ? `https://github.com/${encodeURIComponent(ghLogins(user)[0])}`
                : 'https://github.com/hhjjdsj/ze-map-site/graphs/contributors',
          },
        }
      : {}),
    /*
     * 绑定的 GitHub 身份（2026-10-14 加）：和上面的 gh（称号徽章）**不是一回事** ——
     * gh 只在「仓库贡献者」名单里才有；ghLogin 是「这个账号绑了哪个 GitHub」，
     * 个人主页显示成一行「已绑定 GitHub：@xxx」，也用来决定要不要显示「解绑」按钮。
     * 另外告诉前端：这个账号有没有口令（没有口令就不许解绑，否则会把自己锁在外面）。
     */
    ...(user.gh_id
      ? {
          ghLogin: {
            login: String(user.gh_login ?? ''),
            url: user.gh_login ? `https://github.com/${encodeURIComponent(String(user.gh_login))}` : '',
            avatar: String(user.gh_avatar ?? ''),
            hasPassword: !String(user.pass_hash ?? '').startsWith(GH_PASS_PREFIX),
          },
        }
      : {}),
  };
}

/** 这个账号挂着的 GitHub 用户名（去空白、去重、最多 4 个） */
function ghLogins(user: UserRow): string[] {
  const raw = String(user.gh_names ?? '')
    .split(/[,\s，、]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(raw)].slice(0, 4);
}

/**
 * 这个账号对应哪位已授权 UP 主？
 *
 * ⚠️ **只认管理台人工挂的 `up_name`，不做任何自动推断**（站长 2026-10-13 明确要求）。
 * 为什么不按「账号昵称 === UP 昵称」自动认：那等于**谁先把昵称注册成 UP 的名字，谁就白拿称号**
 * —— 冒名成本只是一个注册，而称号本身是「这位 UP 主同意本站收录」的对外承诺，不能这么给。
 * 所以流程是：UP 本人来（或站长确认身份）→ 管理台点「挂授权UP」→ 写进 up_name → 才有徽章。
 */
async function agreedUpFor(env: Env, user: UserRow): Promise<AgreedUp | null> {
  try {
    const link = String(user.up_name ?? '').trim().toLowerCase();
    if (!link) return null;
    const agreed = await loadAgreed(env.TERR);
    if (!agreed.ups.length) return null;
    return agreed.ups.find((x) => String(x.u).trim().toLowerCase() === link) ?? null;
  } catch {
    return null;
  }
}

/* ===== 接口 ===== */

/*
 * 不存在的昵称也要算一次哈希。
 *
 * 为什么：口令错误的路径要跑 10 万次 PBKDF2（实测线上 ~27ms CPU），而「昵称不存在」
 * 以前是直接返回的（~1ms）。这点时间差能被用来**枚举哪些昵称已被注册**。
 * 拿一个假哈希照样算一次，两边就一样慢了。每个 isolate 只生成一次。
 */
let dummyHash: string | null = null;
async function timingDecoy(): Promise<string> {
  dummyHash ??= await hashPassword('a-password-that-nobody-has');
  return dummyHash;
}

/**
 * POST /api/register —— 昵称 + 口令 + 选填联系方式
 *
 * 防刷四道闸（顺序有讲究：**都放在算哈希之前**，被拦下来的请求不花 CPU、不写库）：
 *   人机验证 → 封禁 IP → 单 IP 每小时 → 单 IP 每天 → 全站 24 小时新账号上限。
 */
export async function handleRegister(request: Request, env: Env, url: URL, ipHash: string, rawIp: string): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  const parsed = await readJsonBody(request, 2048);
  if (!parsed.ok) return parsed.response;
  const b = parsed.body;

  /* 道 0：真人验证（配了 TURNSTILE_SECRET 才生效）。
     放在最前面：刷号脚本连哈希都摸不到。 */
  const human = await verifyTurnstile(env, b.turnstileToken, rawIp);
  if (!human.ok) return fail(turnstileMessage(human.reason), 400);

  /* 道 1：被封禁的来源连注册都不给（以前这里漏了检查，被封的 IP 照样能开号） */
  if (await isBanned(env, ipHash)) return fail('该来源已被禁止注册', 403);

  if (!(await allowWrite(env, ipHash, 'register', REGISTER_PER_HOUR))) {
    return fail(`注册太频繁了（同一网络一小时最多 ${REGISTER_PER_HOUR} 个），请过一会儿再试`, 429);
  }
  if (!(await allowWrite(env, ipHash, 'register', REGISTER_PER_DAY, 'day'))) {
    return fail(`同一个网络出口今天已经注册过 ${REGISTER_PER_DAY} 个账号了，请明天再试；急用可以在 QQ 群里找站长`, 429);
  }

  await ensureSchema(env);

  /* 道 3：全站兜底。到顶就停 —— 最坏只损失几十行 D1 写入额度，不波及投票与投稿 */
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE created_at >= ?1`)
    .bind(Date.now() - 24 * 60 * 60 * 1000)
    .first<{ n: number }>();
  if (Number(recent?.n ?? 0) >= NEW_ACCOUNTS_PER_DAY) {
    return fail(
      `今天的新账号名额已经用完（上限 ${NEW_ACCOUNTS_PER_DAY} 个/天）。` +
        '不影响投稿 —— 不登录也能投；急用可以在 QQ 群里找站长',
      429
    );
  }

  const name = checkName(b.name, env);
  if (!name.ok) return fail(name.error);
  const pass = checkPassword(b.password);
  if (!pass.ok) return fail(pass.error);
  const contact = String(b.contact ?? '').trim().slice(0, 80);

  const exists = await env.DB.prepare(`SELECT id FROM users WHERE name_key = ?1`).bind(nameKey(name.value)).first<{ id: number }>();
  if (exists) return fail('这个昵称已经被注册了 —— 换一个，或者直接登录', 409);

  const hash = await hashPassword(pass.value);
  let row: UserRow | null = null;
  try {
    row = await env.DB.prepare(
      `INSERT INTO users (name, name_key, pass_hash, contact, created_at, last_login) VALUES (?1,?2,?3,?4,?5,?5) RETURNING *`
    )
      .bind(name.value, nameKey(name.value), hash, contact || null, Date.now())
      .first<UserRow>();
  } catch (err) {
    /* 上面那句「昵称是否已存在」和 INSERT 之间有竞态：两个人同时注册同一个昵称时，
       唯一索引会在这里拦下来 —— 当成 409 回话，别把它变成 500。 */
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE|constraint/i.test(msg)) return fail('这个昵称已经被注册了 —— 换一个，或者直接登录', 409);
    throw err;
  }
  if (!row) return fail('注册失败，请稍后再试', 500);

  const token = await makeToken(env, row);
  return setSessionCookie(env, url, { ok: true, user: publicUser(row), message: '注册成功，已登录' }, token);
}

/**
 * POST /api/login
 *
 * 除了 IP 限流，还有**账号级锁定**（`MAX_LOGIN_FAILS` 次口令错就锁 `LOCK_MINUTES` 分钟）：
 * 只有 IP 限流的话，攻击者换 IP 就能接着猜同一个账号的口令。
 */
export async function handleLogin(request: Request, env: Env, url: URL, ipHash: string, rawIp: string): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  const parsed = await readJsonBody(request, 2048);
  if (!parsed.ok) return parsed.response;
  const b = parsed.body;

  /* 真人验证（配了 secret 才生效）：注册和登录一起挡，撞库脚本连口令都试不了 */
  const human = await verifyTurnstile(env, b.turnstileToken, rawIp);
  if (!human.ok) return fail(turnstileMessage(human.reason), 400);

  if (await isBanned(env, ipHash)) return fail('该来源已被禁止登录', 403);
  if (!(await allowWrite(env, ipHash, 'login', LOGIN_PER_HOUR))) {
    return fail(`登录尝试太频繁了（一小时最多 ${LOGIN_PER_HOUR} 次），请过一会儿再试`, 429);
  }
  await ensureSchema(env);

  const name = String(b.name ?? '').trim();
  const pass = String(b.password ?? '');
  if (!name || !pass) return fail('请填写昵称与口令');

  const row = await env.DB.prepare(`SELECT * FROM users WHERE name_key = ?1`).bind(nameKey(name)).first<UserRow>();

  /* 锁定期内直接回绝（连哈希都不算） */
  const lockedUntil = Number(row?.locked_until ?? 0);
  if (row && lockedUntil > Date.now()) {
    const mins = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 60000));
    return fail(`这个账号连续输错太多次，请 ${mins} 分钟后再试（或让站长帮你解）`, 429);
  }

  /* 昵称不存在与口令错给同一句话：不给撞库的人区分依据（耗时也拉平了） */
  const okPass = await verifyPassword(pass, row ? row.pass_hash : await timingDecoy());
  if (!row || !okPass) {
    if (row) {
      const fails = Number(row.fail_count ?? 0) + 1;
      const lockAt = fails >= MAX_LOGIN_FAILS ? Date.now() + LOCK_MINUTES * 60 * 1000 : null;
      await env.DB.prepare(`UPDATE users SET fail_count = ?1, locked_until = ?2 WHERE id = ?3`)
        .bind(lockAt ? 0 : fails, lockAt, row.id)
        .run();
    }
    return fail('昵称或口令不对', 401);
  }
  if (row.banned) return fail('这个账号已被停用，有疑问请在 QQ 群里找站长', 403);

  await env.DB.prepare(`UPDATE users SET last_login = ?1${Number(row.fail_count ?? 0) ? ', fail_count = 0, locked_until = NULL' : ''} WHERE id = ?2`)
    .bind(Date.now(), row.id)
    .run();
  await recalcUserStats(env, row.id);
  const fresh = await env.DB.prepare(`SELECT * FROM users WHERE id = ?1`).bind(row.id).first<UserRow>();
  const token = await makeToken(env, fresh ?? row);
  return setSessionCookie(env, url, { ok: true, user: publicUser(fresh ?? row), message: '登录成功' }, token);
}

/** POST /api/logout */
export async function handleLogout(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  return clearSessionCookie(env, url, { ok: true, message: '已退出登录' });
}

/**
 * GET /api/me —— 我是谁（+ 我的投稿记录，最近 50 条）
 *
 * `?lite=1`：只要用户本身。页头那个账号按钮**每个页面**都会问一次「登没登录、叫什么、几级」，
 * 让它省掉「我的投稿」与各状态计数这两次查询（以及统计重算）。
 * 没登录时两个档位都一样便宜：读不到 Cookie 就直接回，不碰库。
 */
export async function handleMe(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return fail('只支持 GET', 405);
  await ensureSchema(env);
  const user = await getSessionUser(request, env);
  /* github.enabled：本站开没开 GitHub 登录（没配密钥时要让页面把按钮换成一句说明，
     而不是给一个点了没反应的按钮）。没登录时也要给，登录页的按钮靠它决定显不显示。 */
  const github = { enabled: githubLoginEnabled(env) };
  if (!user) return json({ ok: true, user: null, github });

  /* 授权 UP 主称号：同意名单按 isolate 缓存 10 分钟，正常请求不额外打 R2（见 videos.ts） */
  const up = await agreedUpFor(env, user);

  if (url.searchParams.get('lite') === '1') {
    return json({ ok: true, user: publicUser(user, up), github, lite: true });
  }

  await recalcUserStats(env, user.id);
  const fresh = await env.DB.prepare(`SELECT * FROM users WHERE id = ?1`).bind(user.id).first<UserRow>();
  const { results } = await env.DB.prepare(
    /* value 只给「待审 / 被驳回」的行：个人页要用它做「改自己的投稿」的预填。
       已写回仓库（applied）的不返回内容，避免页面把线上内容当成待改稿。 */
    `SELECT id, map_slug, field, status, created_at, reviewed_at, reject_note, commit_sha,
            CASE WHEN status IN ('pending','rejected') THEN value ELSE NULL END AS value
     FROM submissions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 50`
  )
    .bind(user.id)
    .all<{
      id: number;
      map_slug: string;
      field: string;
      status: string;
      created_at: number;
      reviewed_at: number | null;
      reject_note: string | null;
      commit_sha: string | null;
      value: string | null;
    }>();

  /*
   * 各状态的条数：个人页那四个数字块用它。
   * 注意口径差别 —— `user.approved` / `user.rejected` 是**按「图 + 字段」去重**的等级口径，
   * 这里是**投稿条数**（同图同字段改三次就是三条）。两个都显示，但标签写清楚。
   */
  const { results: byStatus } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM submissions WHERE user_id = ?1 GROUP BY status`
  )
    .bind(user.id)
    .all<{ status: string; n: number }>();
  const tally = { pending: 0, approved: 0, applied: 0, rejected: 0 };
  for (const row of byStatus ?? []) {
    if (row.status in tally) tally[row.status as keyof typeof tally] = Number(row.n) || 0;
  }

  return json({ ok: true, user: publicUser(fresh ?? user, up), submissions: results ?? [], counts: tally, github });
}

/** POST /api/password —— 改口令（旧 Cookie 全部作废，只保留当前这一个） */
export async function handlePassword(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  const parsed = await readJsonBody(request, 2048);
  if (!parsed.ok) return parsed.response;
  await ensureSchema(env);
  const user = await getSessionUser(request, env);
  if (!user) return fail('请先登录', 401);

  const oldPass = String(parsed.body.oldPassword ?? '');
  const next = checkPassword(parsed.body.newPassword);
  if (!next.ok) return fail(next.error);
  /*
   * GitHub 登录建的账号**没有口令**（pass_hash 是哨兵值），这时不许要「原口令」——
   * 否则他永远设不上口令，也就永远解绑不了 GitHub（本站不收邮箱，找不回）。
   * 已经有口令的账号照旧必须验原口令。
   */
  const hadPassword = !String(user.pass_hash ?? '').startsWith(GH_PASS_PREFIX);
  if (hadPassword && !(await verifyPassword(oldPass, user.pass_hash))) return fail('原口令不对', 401);

  const hash = await hashPassword(next.value);
  await env.DB.prepare(`UPDATE users SET pass_hash = ?1, pass_ver = pass_ver + 1 WHERE id = ?2`).bind(hash, user.id).run();
  const fresh = await env.DB.prepare(`SELECT * FROM users WHERE id = ?1`).bind(user.id).first<UserRow>();
  const token = await makeToken(env, fresh ?? user);
  return setSessionCookie(
    env,
    url,
    {
      ok: true,
      message: hadPassword ? '口令已更新（其它设备上的登录会失效）' : '已设置口令（现在可以解绑 GitHub 了，其它设备上的登录会失效）',
    },
    token
  );
}

/** POST /api/profile —— 改联系方式 / 昵称（昵称只影响以后的署名，历史投稿不改） */
export async function handleProfile(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  const parsed = await readJsonBody(request, 2048);
  if (!parsed.ok) return parsed.response;
  await ensureSchema(env);
  const user = await getSessionUser(request, env);
  if (!user) return fail('请先登录', 401);

  const fields: string[] = [];
  const values: unknown[] = [];
  if (parsed.body.contact !== undefined) {
    fields.push(`contact = ?${fields.length + 1}`);
    values.push(String(parsed.body.contact ?? '').trim().slice(0, 80) || null);
  }
  if (parsed.body.name !== undefined) {
    const name = checkName(parsed.body.name, env);
    if (!name.ok) return fail(name.error);
    const key = nameKey(name.value);
    const clash = await env.DB.prepare(`SELECT id FROM users WHERE name_key = ?1 AND id <> ?2`).bind(key, user.id).first<{ id: number }>();
    if (clash) return fail('这个昵称已经被别人用了', 409);
    fields.push(`name = ?${fields.length + 1}`, `name_key = ?${fields.length + 2}`);
    values.push(name.value, key);
  }
  if (!fields.length) return fail('没有要改的内容');

  values.push(user.id);
  await env.DB.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?${values.length}`)
    .bind(...values)
    .run();
  const fresh = await env.DB.prepare(`SELECT * FROM users WHERE id = ?1`).bind(user.id).first<UserRow>();
  return json({ ok: true, user: publicUser(fresh ?? user), message: '已保存' });
}

/* ===== 审核台：账号管理（只有站长，走 ADMIN_TOKEN） =====
 *
 * 为什么需要：`users.banned` 这一列和检查一直都在（登录、读会话都认），
 * 但**以前没有任何地方能把它设成 1** —— 想停用一个账号只能手改数据库。
 * 顺带把「最近 24 小时新增了几个」摆出来，因为防刷的四道闸里有三道是按这个数算的。
 */

export interface AdminAccountRow {
  id: number;
  name: string;
  contact: string | null;
  created_at: number;
  last_login: number | null;
  banned: number;
  approved: number;
  rejected: number;
  fail_count: number | null;
  locked_until: number | null;
}

/** GET /api/admin/accounts —— 账号总览：全站统计 + 最近 N 个账号 */
export async function handleAdminAccounts(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return fail('只支持 GET', 405);
  await ensureSchema(env);

  const limitRaw = Number(url.searchParams.get('limit') ?? 100);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;

  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS all_users,
            SUM(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END) AS last24h,
            SUM(CASE WHEN banned = 1 THEN 1 ELSE 0 END) AS banned_users,
            SUM(CASE WHEN locked_until > ?2 THEN 1 ELSE 0 END) AS locked_users
       FROM users`
  )
    .bind(Date.now() - 24 * 60 * 60 * 1000, Date.now())
    .first<{ all_users: number; last24h: number; banned_users: number; locked_users: number }>();

  const { results } = await env.DB.prepare(
    `SELECT id, name, contact, created_at, last_login, banned, approved, rejected, fail_count, locked_until
       FROM users ORDER BY created_at DESC LIMIT ?1`
  )
    .bind(limit)
    .all<AdminAccountRow>();

  return json({
    ok: true,
    items: (results ?? []).map((r) => ({
      ...r,
      /* 联系方式只有站长看得到 —— 这个接口本来就在 ADMIN_TOKEN 后面 */
      locked: Number(r.locked_until ?? 0) > Date.now(),
    })),
    totals: {
      all: Number(totals?.all_users ?? 0),
      last24h: Number(totals?.last24h ?? 0),
      banned: Number(totals?.banned_users ?? 0),
      locked: Number(totals?.locked_users ?? 0),
    },
    limits: {
      registerPerHour: REGISTER_PER_HOUR,
      registerPerDay: REGISTER_PER_DAY,
      newAccountsPerDay: NEW_ACCOUNTS_PER_DAY,
    },
  });
}

/** POST /api/admin/accounts —— { id, action: 'ban' | 'unban' | 'unlock' | 'reset' | 'rename', name? }
 *
 * `reset` = 给账号换一个**临时口令**并把新口令回给站长（页面会显示出来，站长转告本人）。
 * 为什么需要：本站不收邮箱，「忘了口令」只能人工 —— 没有这个按钮就只能手改数据库。
 * 顺带把 pass_ver +1：重置之后，**旧设备上的登录立刻失效**（口令本来就是这么作废的）。
 *
 * `rename` = 给账号改名（昵称审核发现违规名时用）。新名字照样过一遍昵称规则；
 * 顺手把**还没写回仓库**的投稿署名一起改掉；已经进 git 的那些署名改不动（那要改历史提交）。
 */
export async function handleAdminAccountAction(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  const parsed = await readJsonBody(request, 1024);
  if (!parsed.ok) return parsed.response;

  const id = Number(parsed.body.id);
  const action = String(parsed.body.action ?? '');
  if (!Number.isInteger(id) || id <= 0) return fail('id 不合法');
  if (!['ban', 'unban', 'unlock', 'reset', 'rename', 'linkup', 'unlinkup', 'linkgh', 'unlinkgh'].includes(action)) {
    return fail('action 只能是 ban / unban / unlock / reset / rename / linkup / unlinkup / linkgh / unlinkgh');
  }

  await ensureSchema(env);
  const before = await env.DB.prepare(`SELECT id, name, up_name, gh_names FROM users WHERE id = ?1`)
    .bind(id)
    .first<{ id: number; name: string; up_name: string | null; gh_names: string | null }>();
  if (!before) return fail('没有这个账号', 404);

  /*
   * linkgh：把这个账号挂到 GitHub 贡献者上（2026-10-13 加）—— 「仓库贡献者」称号。
   * 规则和「授权 UP 主」一样：**只人工发**，而且发之前要核对 —— 用户名必须在仓库的贡献者名单里
   * （GitHub API 读，见 community.ts 的 listContributors）。
   * 一个人可能有多个 GitHub 号（SiKi = trrrr-ai + MiKU），所以收一个列表；**至少一个**要对得上，
   * 对不上的那些照样存下来但会在返回里点名（提交被 squash 过、或走的是 PR 分支，名单里就可能没有）。
   */
  if (action === 'linkgh' || action === 'unlinkgh') {
    if (action === 'unlinkgh') {
      await env.DB.prepare(`UPDATE users SET gh_names = NULL WHERE id = ?1`).bind(id).run();
      return json({ ok: true, id, action, message: `已摘掉「${before.name}」的仓库贡献者称号` });
    }
    const raw = String(parsed.body.name ?? '').trim();
    if (!raw) return fail('要写 GitHub 用户名（多个用逗号隔开）');
    const logins = [...new Set(raw.split(/[,\s，、]+/).map((s) => s.trim()).filter(Boolean))].slice(0, 4);
    const bad = logins.find((x) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(x));
    if (bad) return fail(`不像 GitHub 用户名：${bad}`);

    let known: Map<string, number>;
    try {
      known = await listContributors(env);
    } catch (err) {
      return fail(
        `核对贡献者名单失败（${err instanceof Error ? err.message : String(err)}）—— ` +
          '没有名单就不发称号，检查 GITHUB_TOKEN 与网络后重试',
        502,
      );
    }
    const hits = logins.filter((x) => known.has(x.toLowerCase()));
    if (!hits.length) {
      return fail(
        `这几个用户名都不在仓库贡献者名单里（${logins.join('、')}）—— ` +
          `名单里现在是：${[...known.keys()].slice(0, 10).join('、')}。` +
          '确认一下是不是提交被 squash 过、或者用的是别的账号',
      );
    }
    await env.DB.prepare(`UPDATE users SET gh_names = ?1 WHERE id = ?2`).bind(logins.join(','), id).run();
    const missed = logins.filter((x) => !known.has(x.toLowerCase()));
    await pushNotification(env, {
      userId: id,
      kind: 'account',
      title: '你获得了「仓库贡献者」称号',
      body: `本站把账号挂到了 GitHub：${hits.join('、')}（仓库提交记录里能查到）。徽章在页头账号卡片和个人主页上。`,
      link: '/account/',
    });
    return json({
      ok: true,
      id,
      action,
      logins,
      message:
        `已把「${before.name}」记为仓库贡献者：${hits.map((x) => `${x}（${known.get(x.toLowerCase())} 次提交）`).join('、')}` +
        (missed.length ? `；另 ${missed.join('、')} 不在贡献者名单里，也一并记下了（可能提交被 squash）` : ''),
    });
  }

  /*
   * linkup：把这个账号挂到某位「已授权 UP 主」上（2026-10-13 加）。
   * 为什么需要人工挂：站点昵称和 B 站昵称经常不一样（「雨宫鹿奈」↔「雨宫鹿奈_shikaNiko」），
   * 自动认不出来。挂上之后账号页会显示「授权 UP 主」徽章 + 本站收录了他几条视频。
   */
  if (action === 'linkup' || action === 'unlinkup') {
    if (action === 'unlinkup') {
      await env.DB.prepare(`UPDATE users SET up_name = NULL WHERE id = ?1`).bind(id).run();
      return json({ ok: true, id, action, message: `已摘掉「${before.name}」的授权 UP 主称号` });
    }
    const want = String(parsed.body.name ?? '').trim();
    if (!want) return fail('要写 UP 主昵称（与站上视频署名完全一致）');
    const agreed = await loadAgreed(env.TERR);
    const hit = agreed.ups.find((x) => String(x.u).trim().toLowerCase() === want.toLowerCase());
    if (!hit) {
      return fail(
        `同意名单里没有「${want}」——名单在 R2 的 video-meta/agreed.json，` +
          '得先在本地 tools/video-agreed.json 里加名字再推上去（node ../tools/video-meta-push.mjs）'
      );
    }
    await env.DB.prepare(`UPDATE users SET up_name = ?1 WHERE id = ?2`).bind(hit.u, id).run();
    await pushNotification(env, {
      userId: id,
      kind: 'account',
      title: '你获得了「授权 UP 主」称号',
      body: `本站已收录「${hit.u}」的 ${hit.videos} 条视频（分布在 ${hit.maps.length} 张图的页面上），徽章挂在你账号旁边。`,
      link: '/account/',
    });
    return json({
      ok: true,
      id,
      action,
      message: `已把「${before.name}」挂到 UP 主「${hit.u}」上（本站收录 ${hit.videos} 条视频 / ${hit.maps.length} 张图）`,
    });
  }

  if (action === 'rename') {
    const next = checkName(parsed.body.name, env);
    if (!next.ok) return fail(next.error);
    const key = nameKey(next.value);
    const clash = await env.DB.prepare(`SELECT id FROM users WHERE name_key = ?1 AND id <> ?2`)
      .bind(key, id)
      .first<{ id: number }>();
    if (clash) return fail('这个昵称已经被别人用了', 409);

    await env.DB.prepare(`UPDATE users SET name = ?1, name_key = ?2 WHERE id = ?3`).bind(next.value, key, id).run();
    /* 顺手改掉「还没写回仓库」的署名（pending / approved）；已 applied 的在 git 里，改不动 */
    await env.DB.prepare(`UPDATE submissions SET submitter = ?1 WHERE user_id = ?2 AND status IN ('pending','approved')`)
      .bind(next.value, id)
      .run();
    await pushNotification(env, {
      userId: id,
      kind: 'account',
      title: '你的昵称被站长改了',
      body: `「${before.name}」→「${next.value}」。还没写回的投稿署名一起改了；已经进仓库的那些要另开一次提交才能改。`,
      link: '/account/',
    });
    return json({
      ok: true,
      id,
      action,
      message: `已把「${before.name}」改名为「${next.value}」—— 还没写回的投稿署名一起改了；已经进仓库的那些署名要改得另开一次提交`,
    });
  }

  if (action === 'ban') {
    /* 停用 + 顺手清掉失败计数：解封后不会带着旧锁定 */
    await env.DB.prepare(`UPDATE users SET banned = 1, fail_count = 0, locked_until = NULL WHERE id = ?1`).bind(id).run();
    await pushNotification(env, {
      userId: id,
      kind: 'account',
      title: '账号已被停用',
      body: '站长停用了这个账号：现在登不进来，已有的投稿也不再生效。有疑问请通过站内投稿的联系方式找站长。',
      link: '/account/',
    });
  } else if (action === 'unban') {
    await env.DB.prepare(`UPDATE users SET banned = 0 WHERE id = ?1`).bind(id).run();
    await pushNotification(env, {
      userId: id,
      kind: 'account',
      title: '账号已恢复',
      body: '站长恢复了你的账号，现在可以正常登录与投稿了。',
      link: '/account/',
    });
  } else if (action === 'unlock') {
    await env.DB.prepare(`UPDATE users SET fail_count = 0, locked_until = NULL WHERE id = ?1`).bind(id).run();
  } else {
    const temp = tempPassword();
    const hash = await hashPassword(temp);
    await env.DB.prepare(
      `UPDATE users SET pass_hash = ?1, pass_ver = pass_ver + 1, fail_count = 0, locked_until = NULL WHERE id = ?2`
    )
      .bind(hash, id)
      .run();
    /* 收件箱：这条**不写临时口令**（口令只回给拿着 ADMIN_TOKEN 的站长，靠人转告） */
    await pushNotification(env, {
      userId: id,
      kind: 'account',
      title: '口令已被站长重置',
      body:
        '站长给你换了一个临时口令（他那边看得到明文），请找他要；登录后到个人主页自己改成新口令。' +
        '重置后旧的登录状态已经失效（需要重新登录）。',
      link: '/account/',
    });
    return json({
      ok: true,
      id,
      action,
      /* 只在这里回明文口令：一次性、且只有拿着 ADMIN_TOKEN 的人看得到。
         页面上要提示站长「转告本人后让他自己改」。 */
      tempPassword: temp,
      message: `已给「${before.name}」换了一个临时口令（见下方），请转告本人；他登录后可以在账号页自己改。`,
    });
  }

  const message =
    action === 'ban'
      ? `已停用「${before.name}」—— 他手上的登录会立刻失效，投稿署名也不再挂到这个账号`
      : action === 'unban'
        ? `已恢复「${before.name}」`
        : `已解锁「${before.name}」（失败计数清零）`;
  return json({ ok: true, id, action, message });
}

/**
 * 临时口令：给人工转告用的，所以要好念好打。
 * 字母表去掉了容易看错的 0/O/1/l/I，长度 10 —— 用户登录后应当自己改掉。
 */
function tempPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}
