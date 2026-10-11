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

import { allowWrite, fail, isLocalHost, json, readJsonBody, safeEqual, type Env } from './http';

/* ===== 常量 ===== */

/** Cookie 名 */
const COOKIE = 'zc_sess';
/** 会话有效期 90 天 */
const SESSION_TTL = 90 * 24 * 60 * 60;
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

/** 令牌桶：同一个 IP 每小时最多注册/登录多少次 */
const AUTH_LIMIT_PER_HOUR = 30;

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
}

/** 等级：按**已通过**的投稿条数算（同图同字段只算一次，见 recalcUserStats 的去重口径） */
const LEVELS: Array<{ min: number; name: string; hint: string }> = [
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
 */
let schemaReady = false;

export async function ensureSchema(env: Env): Promise<void> {
  if (schemaReady) return;
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
         rejected INTEGER NOT NULL DEFAULT 0
       )`
    ).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_users_name_key ON users(name_key)`).run();
    /* submissions.user_id：老的库没有这一列，补上（SQLite 没有 ADD COLUMN IF NOT EXISTS） */
    const cols = await env.DB.prepare(`PRAGMA table_info(submissions)`).all<{ name: string }>();
    if (!(cols.results ?? []).some((c) => c.name === 'user_id')) {
      await env.DB.prepare(`ALTER TABLE submissions ADD COLUMN user_id INTEGER`).run();
    }
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_sub_user ON submissions(user_id, created_at)`).run();
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

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

function checkName(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const v = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (v.length < NAME_MIN) return { ok: false, error: `昵称至少 ${NAME_MIN} 个字` };
  if (v.length > NAME_MAX) return { ok: false, error: `昵称最多 ${NAME_MAX} 个字` };
  if (/[<>{}[\]|*?/\\"']/.test(v)) return { ok: false, error: '昵称里有不支持的字符（< > { } [ ] | * ? / \\ " \'）' };
  return { ok: true, value: v };
}

function checkPassword(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const v = String(raw ?? '');
  if (v.length < PASS_MIN) return { ok: false, error: `口令至少 ${PASS_MIN} 位` };
  if (v.length > PASS_MAX) return { ok: false, error: `口令最多 ${PASS_MAX} 位` };
  return { ok: true, value: v };
}

/** 对外的用户信息（绝不回传 pass_hash） */
function publicUser(user: UserRow) {
  return {
    id: user.id,
    name: user.name,
    contact: user.contact ?? '',
    createdAt: user.created_at,
    ...levelOf(user.approved, user.rejected),
  };
}

/* ===== 接口 ===== */

/** POST /api/register —— 昵称 + 口令 + 选填联系方式 */
export async function handleRegister(request: Request, env: Env, url: URL, ipHash: string): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  const parsed = await readJsonBody(request, 2048);
  if (!parsed.ok) return parsed.response;
  const b = parsed.body;

  if (!(await allowWrite(env, ipHash, 'auth', AUTH_LIMIT_PER_HOUR))) {
    return fail(`注册/登录太频繁了（一小时最多 ${AUTH_LIMIT_PER_HOUR} 次），请过一会儿再试`, 429);
  }
  await ensureSchema(env);

  const name = checkName(b.name);
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

/** POST /api/login */
export async function handleLogin(request: Request, env: Env, url: URL, ipHash: string): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  const parsed = await readJsonBody(request, 2048);
  if (!parsed.ok) return parsed.response;
  const b = parsed.body;

  if (!(await allowWrite(env, ipHash, 'auth', AUTH_LIMIT_PER_HOUR))) {
    return fail(`注册/登录太频繁了（一小时最多 ${AUTH_LIMIT_PER_HOUR} 次），请过一会儿再试`, 429);
  }
  await ensureSchema(env);

  const name = String(b.name ?? '').trim();
  const pass = String(b.password ?? '');
  if (!name || !pass) return fail('请填写昵称与口令');

  const row = await env.DB.prepare(`SELECT * FROM users WHERE name_key = ?1`).bind(nameKey(name)).first<UserRow>();
  /* 昵称不存在与口令错给同一句话：不给撞库的人区分依据 */
  const okPass = row ? await verifyPassword(pass, row.pass_hash) : false;
  if (!row || !okPass) return fail('昵称或口令不对', 401);
  if (row.banned) return fail('这个账号已被停用，有疑问请在 QQ 群里找站长', 403);

  await env.DB.prepare(`UPDATE users SET last_login = ?1 WHERE id = ?2`).bind(Date.now(), row.id).run();
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
  if (!user) return json({ ok: true, user: null });

  if (url.searchParams.get('lite') === '1') {
    return json({ ok: true, user: publicUser(user), lite: true });
  }

  await recalcUserStats(env, user.id);
  const fresh = await env.DB.prepare(`SELECT * FROM users WHERE id = ?1`).bind(user.id).first<UserRow>();
  const { results } = await env.DB.prepare(
    `SELECT id, map_slug, field, status, created_at, reviewed_at, reject_note, commit_sha
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

  return json({ ok: true, user: publicUser(fresh ?? user), submissions: results ?? [], counts: tally });
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
  if (!(await verifyPassword(oldPass, user.pass_hash))) return fail('原口令不对', 401);

  const hash = await hashPassword(next.value);
  await env.DB.prepare(`UPDATE users SET pass_hash = ?1, pass_ver = pass_ver + 1 WHERE id = ?2`).bind(hash, user.id).run();
  const fresh = await env.DB.prepare(`SELECT * FROM users WHERE id = ?1`).bind(user.id).first<UserRow>();
  const token = await makeToken(env, fresh ?? user);
  return setSessionCookie(env, url, { ok: true, message: '口令已更新（其它设备上的登录会失效）' }, token);
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
    const name = checkName(parsed.body.name);
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
