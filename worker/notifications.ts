/**
 * 站内收件箱（2026-10-14 加）。
 *
 * 站长要的那件事：投稿被**审核通过 / 写回上线 / 草稿被采纳**，或者站里发了**公告**，
 * 用户在自己的账号旁边能看到一个小红点，点开是收件箱，逐条看细节，也能一键全标已读。
 *
 * 三条设计约束（和账号系统其它部分一致）：
 *   1. **静态页面 + 一个接口**：页面照旧是构建产物，红点靠页面加载后问一次
 *      `/api/me/notifications`（可见时每 2 分钟再问一次）。没登录就不问、也不显示铃铛。
 *   2. **写通知绝不能拖垮正事**：审核 / 写回 / 采纳这些路径里的插入全部 try/catch，
 *      失败只记日志 —— 收件箱坏了不该让「通过一条投稿」变成 500。
 *   3. **公告只存一行**：全员公告用 `user_id IS NULL` 表示，已读状态放另一张表
 *      （`notification_reads`），所以一条公告发给 100 个人也只有一行、各自的已读互不影响。
 *
 * 表（懒建，见 ensureNotifSchema）：
 *   notifications       id / user_id(NULL=全员) / kind / title / body / link / submission_id / created_at
 *   notification_reads  user_id + notification_id（主键）/ read_at
 *
 * 接口：
 *   GET  /api/me/notifications?limit=10&offset=0   我的收件箱（含 unread 计数）
 *   POST /api/me/notifications/read                { ids:[…] } 或 { all:true }
 *   GET  /api/admin/announce                       最近发过的公告（避免重复发）
 *   POST /api/admin/announce                       { title, body?, link? } 发一条全员公告
 *
 * 谁在写通知：worker/submissions.ts（reject / approve / flush / adopt）、
 * worker/auth.ts（停用 / 恢复 / 重置口令 / 改名 / 称号）。见各处的 pushNotification 调用。
 */
import { fail, json, readJsonBody, type Env } from './http';

/** 通知分类：只是给前端分个图标/颜色，别拿它当权限用 */
export type NotifKind = 'review' | 'flush' | 'adopt' | 'account' | 'announce';

export interface NotifInput {
  /** 收件人；**不填 = 全员公告** */
  userId?: number | null;
  kind: NotifKind;
  title: string;
  body?: string;
  /** 点进详情后可以去哪（站内路径或 https 链接），没写就只展开正文 */
  link?: string | null;
  submissionId?: number | null;
}

const LIMITS = { title: 60, body: 800, link: 300 } as const;
const MAX_LIMIT = 50;

let schemaReady = false;

/**
 * `.run()` 的结果在两种 D1 实现里长得不一样：
 *   · 线上 D1：`{ success, meta: { changes, last_row_id } }`
 *   · 测试里的 node:sqlite 壳（worker/auth.test.mjs 的 makeD1）：`{ changes, lastInsertRowid }`
 * 两边都读一下，省得测试只能靠「插入后自己再查一遍」来断言。
 */
function runMeta(res: unknown): { changes: number; lastRowId: number } {
  const r = (res ?? {}) as { changes?: number; lastInsertRowid?: number; meta?: { changes?: number; last_row_id?: number } };
  return {
    changes: Number(r.meta?.changes ?? r.changes ?? 0) || 0,
    lastRowId: Number(r.meta?.last_row_id ?? r.lastInsertRowid ?? 0) || 0,
  };
}

/** 建表（幂等）。schemaReady 只是本 isolate 的短路，真正的保证来自 IF NOT EXISTS。 */
export async function ensureNotifSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  const step = async (what: string, sql: string) => {
    try {
      await env.DB.prepare(sql).run();
    } catch (err) {
      console.error(`ensureNotifSchema(${what}) 失败：` + (err instanceof Error ? err.message : String(err)));
    }
  };
  await step(
    'notifications',
    `CREATE TABLE IF NOT EXISTS notifications (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       user_id INTEGER,
       kind TEXT NOT NULL DEFAULT 'system',
       title TEXT NOT NULL,
       body TEXT NOT NULL DEFAULT '',
       link TEXT,
       submission_id INTEGER,
       created_at INTEGER NOT NULL
     )`
  );
  await step(
    'idx_notif_user',
    `CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at DESC)`
  );
  await step(
    'idx_notif_time',
    `CREATE INDEX IF NOT EXISTS idx_notif_time ON notifications(created_at DESC)`
  );
  await step(
    'notification_reads',
    `CREATE TABLE IF NOT EXISTS notification_reads (
       user_id INTEGER NOT NULL,
       notification_id INTEGER NOT NULL,
       read_at INTEGER NOT NULL,
       PRIMARY KEY (user_id, notification_id)
     )`
  );
  schemaReady = true;
}

/** 入库前把内容削到安全范围：长度封顶、去掉控制字符，链接只收站内路径或 https */
function clean(input: NotifInput): { title: string; body: string; link: string | null } | null {
  const title = String(input.title ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, LIMITS.title);
  if (!title) return null;
  const body = String(input.body ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, LIMITS.body);
  const rawLink = String(input.link ?? '').trim().slice(0, LIMITS.link);
  const link = !rawLink
    ? null
    : rawLink.startsWith('/')
      ? rawLink
      : /^https:\/\/[\w.-]+\//.test(rawLink)
        ? rawLink
        : null;
  return { title, body, link };
}

/**
 * 写一条通知。**永不抛**：调用它的都是审核/写回/采纳这些正事，收件箱坏了不该把它们弄挂。
 * 返回新行 id（写失败返回 null，调用方可以无视）。
 */
export async function pushNotification(env: Env, input: NotifInput): Promise<number | null> {
  try {
    await ensureNotifSchema(env);
    const row = clean(input);
    if (!row) return null;
    const res = await env.DB.prepare(
      `INSERT INTO notifications (user_id, kind, title, body, link, submission_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    )
      .bind(
        Number.isInteger(input.userId) && Number(input.userId) > 0 ? Number(input.userId) : null,
        String(input.kind || 'account'),
        row.title,
        row.body,
        row.link,
        Number.isInteger(input.submissionId) && Number(input.submissionId) > 0 ? Number(input.submissionId) : null,
        Date.now()
      )
      .run();
    return runMeta(res).lastRowId || null;
  } catch (err) {
    console.error('pushNotification 失败：' + (err instanceof Error ? err.message : String(err)));
    return null;
  }
}

/** 批量（写回一批常常对应好几条投稿）：逐条兜错，别因为一条坏数据全丢 */
export async function pushNotifications(env: Env, list: NotifInput[]): Promise<number> {
  let n = 0;
  for (const item of list) {
    if ((await pushNotification(env, item)) !== null) n++;
  }
  return n;
}

interface NotifRow {
  id: number;
  user_id: number | null;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  submission_id: number | null;
  created_at: number;
  read_at: number | null;
}

const visible = `(n.user_id = ?1 OR n.user_id IS NULL)`;

/**
 * GET /api/me/notifications?limit=10&offset=0 —— 我的收件箱
 *
 * 登录态由调用方（worker/index.ts）先解析好再传进来：这样本文件不必 import auth.ts，
 * 避免和「auth.ts 里写账号类通知」形成循环依赖。
 */
export async function handleMyNotifications(env: Env, url: URL, userId: number): Promise<Response> {
  await ensureNotifSchema(env);

  const limitRaw = Number(url.searchParams.get('limit') ?? 10);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : 10;
  const offsetRaw = Number(url.searchParams.get('offset') ?? 0);
  const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? Math.min(offsetRaw, 100000) : 0;

  const { results } = await env.DB.prepare(
    `SELECT n.id, n.user_id, n.kind, n.title, n.body, n.link, n.submission_id, n.created_at, r.read_at
       FROM notifications n
       LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?1
      WHERE ${visible}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ?2 OFFSET ?3`
  )
    .bind(userId, limit, offset)
    .all<NotifRow>();

  const unreadRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM notifications n
       LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?1
      WHERE ${visible} AND r.read_at IS NULL`
  )
    .bind(userId)
    .first<{ n: number }>();

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM notifications n WHERE ${visible}`)
    .bind(userId)
    .first<{ n: number }>();

  return json({
    ok: true,
    items: (results ?? []).map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      link: r.link,
      submissionId: r.submission_id,
      /** 公告（user_id 为空）前端可以标一下「公告」 */
      broadcast: r.user_id === null,
      createdAt: r.created_at,
      read: r.read_at !== null,
    })),
    unread: Number(unreadRow?.n ?? 0),
    total: Number(totalRow?.n ?? 0),
    limit,
    offset,
  });
}

/**
 * POST /api/me/notifications/read  body: { ids: [1,2] } 或 { all: true }
 *
 * 已读 = 在 notification_reads 里插一行（主键 user_id+notification_id，重复插是 OR IGNORE，幂等）。
 * 只能标记**自己看得到**的那些（自己的 + 公告）—— 别人的私信即使猜到 id 也插不进去。
 */
export async function handleNotificationsRead(request: Request, env: Env, userId: number): Promise<Response> {
  const parsed = await readJsonBody(request, 4096);
  if (!parsed.ok) return parsed.response;
  await ensureNotifSchema(env);

  const now = Date.now();
  const all = parsed.body.all === true;
  let marked = 0;

  if (all) {
    /*
     * 一条语句把「现在看得见的全部」标成已读：OR IGNORE 让已经读过的那几行保留原来的 read_at。
     * 只影响**此刻已存在**的通知（之后来的新通知照旧是未读）。
     */
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO notification_reads (user_id, notification_id, read_at)
       SELECT ?1, n.id, ?2 FROM notifications n WHERE ${visible}`
    )
      .bind(userId, now)
      .run();
    marked = runMeta(res).changes;
  } else {
    const ids = Array.isArray(parsed.body.ids)
      ? [...new Set(parsed.body.ids.map((v: unknown) => Number(v)).filter((n: number) => Number.isInteger(n) && n > 0))]
      : [];
    if (!ids.length) return fail('要写 ids 或 all');
    if (ids.length > 100) return fail('一次最多标 100 条');
    const holes = ids.map((_, i) => `?${i + 2}`).join(',');
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO notification_reads (user_id, notification_id, read_at)
       SELECT ?1, n.id, ?${ids.length + 2} FROM notifications n
        WHERE n.id IN (${holes}) AND ${visible}`
    )
      .bind(userId, ...ids, now)
      .run();
    marked = runMeta(res).changes;
  }

  const unreadRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM notifications n
       LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?1
      WHERE ${visible} AND r.read_at IS NULL`
  )
    .bind(userId)
    .first<{ n: number }>();

  return json({ ok: true, marked, unread: Number(unreadRow?.n ?? 0) });
}

/**
 * GET /api/admin/announce —— 最近发过的公告（审核台发之前看一眼，别重复发）
 * POST /api/admin/announce —— 发一条全员公告：{ title, body?, link? }
 */
export async function handleAdminAnnounce(request: Request, env: Env, url: URL): Promise<Response> {
  await ensureNotifSchema(env);

  if (request.method === 'GET') {
    const limitRaw = Number(url.searchParams.get('limit') ?? 10);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 10;
    const { results } = await env.DB.prepare(
      `SELECT id, title, body, link, created_at FROM notifications
        WHERE user_id IS NULL ORDER BY created_at DESC, id DESC LIMIT ?1`
    )
      .bind(limit)
      .all<{ id: number; title: string; body: string; link: string | null; created_at: number }>();
    const users = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE banned = 0`).first<{ n: number }>();
    return json({
      ok: true,
      items: (results ?? []).map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        link: r.link,
        createdAt: r.created_at,
      })),
      /** 这条公告会发给多少个账号（未登录的人看不到收件箱，所以是账号数） */
      recipients: Number(users?.n ?? 0),
    });
  }

  if (request.method !== 'POST') return fail('只支持 GET / POST', 405);
  const parsed = await readJsonBody(request, 4096);
  if (!parsed.ok) return parsed.response;
  const title = String(parsed.body.title ?? '').trim();
  if (!title) return fail('公告得有标题');
  if ([...title].length > LIMITS.title) return fail(`标题最多 ${LIMITS.title} 个字`);
  const bodyRaw = String(parsed.body.body ?? '').trim();
  if ([...bodyRaw].length > LIMITS.body) return fail(`正文最多 ${LIMITS.body} 个字`);

  const id = await pushNotification(env, {
    userId: null,
    kind: 'announce',
    title,
    body: bodyRaw,
    link: String(parsed.body.link ?? '').trim() || null,
  });
  if (id === null) return fail('公告没发出去（写库失败），请稍后重试', 500);
  const users = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE banned = 0`).first<{ n: number }>();
  return json({
    ok: true,
    id,
    recipients: Number(users?.n ?? 0),
    message: `公告已发出（#${id}），${Number(users?.n ?? 0)} 个账号下次打开页面就能在收件箱看到`,
  });
}
