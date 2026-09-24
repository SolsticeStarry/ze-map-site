/**
 * 社区投稿（P2）—— 投稿进队列、审核、写回 git。
 *
 * 流程：
 *   任何人 POST /api/submit  →  submissions(status=pending)
 *   站长   GET  /api/admin/queue        （密钥）
 *   站长   POST /api/admin/review 通过  → 写 data/community/<slug>.json → status=applied
 *   站长   POST /api/admin/review 驳回  → status=rejected（可带理由）
 *   push 触发 Cloudflare 重建 → 页面出现社区内容
 */

import { applySubmission, touch } from '../shared/community-doc.mjs';
import { LIMITS, isField, validateValue } from '../shared/submission-fields.mjs';
import { GitError, readCommunityDoc, writeCommunityDoc } from './community';
import { allowWrite, fail, isBanned, json, readJsonBody, type Env } from './http';
import { SLUG_RE } from './votes';

interface SubmissionRow {
  id: number;
  map_slug: string;
  field: string;
  value: string;
  note: string | null;
  submitter: string | null;
  contact: string | null;
  status: string;
  created_at: number;
  reviewed_at: number | null;
  reviewer: string | null;
  reject_note: string | null;
  commit_sha: string | null;
  error: string | null;
}

/* ===== 小工具 ===== */

function optString(
  v: unknown,
  max: number,
  label: string
): { ok: true; value: string } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: '' };
  if (typeof v !== 'string') return { ok: false, error: `${label}格式不对` };
  const s = v.trim();
  if (s.length > max) return { ok: false, error: `${label}最多 ${max} 个字` };
  return { ok: true, value: s };
}

function short(v: unknown): string {
  if (v === null || v === undefined || v === '') return '（新增）';
  const s = Array.isArray(v) ? v.join('、') : String(v);
  return s.length > 40 ? s.slice(0, 40) + '…' : s;
}

function commitMessage(sub: SubmissionRow, change: { field: string; from: unknown; to: unknown }, reviewer: string): string {
  const who = sub.submitter || '匿名';
  const audit = reviewer ? `，审核 ${reviewer}` : '';
  if (change.field === 'body') {
    return `社区投稿：${sub.map_slug} 补充说明（by ${who}${audit}）`;
  }
  return `社区投稿：${sub.map_slug} ${change.field} ${short(change.from)} → ${short(change.to)}（by ${who}${audit}）`;
}

/** Turnstile 校验。没配 TURNSTILE_SECRET 就跳过（这时靠限流 + 人工审核兜底）。 */
async function verifyTurnstile(env: Env, token: unknown, ip: string): Promise<boolean> {
  if (typeof token !== 'string' || !token) return false;
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}

/* ===== 公开接口 ===== */

/** POST /api/submit */
export async function handleSubmit(
  request: Request,
  env: Env,
  ipHash: string,
  rawIp: string
): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);

  const parsed = await readJsonBody(request, 8192);
  if (!parsed.ok) return parsed.response;
  const b = parsed.body;

  const slug = typeof b.map === 'string' ? b.map.trim() : '';
  const field = typeof b.field === 'string' ? b.field.trim() : '';
  if (!SLUG_RE.test(slug)) return fail('地图参数不合法');
  if (!isField(field)) return fail('不认识的字段');

  const checked = validateValue(field, b.value);
  if (!checked.ok) return fail(checked.error);

  const submitter = optString(b.submitter, LIMITS.submitter, '昵称');
  if (!submitter.ok) return fail(submitter.error);
  const contact = optString(b.contact, LIMITS.contact, '联系方式');
  if (!contact.ok) return fail(contact.error);
  const note = optString(b.note, LIMITS.note, '理由');
  if (!note.ok) return fail(note.error);

  if (await isBanned(env, ipHash)) return fail('该来源已被禁止投稿', 403);

  if (env.TURNSTILE_SECRET && !(await verifyTurnstile(env, b.turnstileToken, rawIp))) {
    return fail('人机验证没通过，请重试', 400);
  }

  if (!(await allowWrite(env, ipHash, 'submit', LIMITS.perHour))) {
    return fail(`投稿太频繁了（每小时最多 ${LIMITS.perHour} 条），请过一会儿再试`, 429);
  }

  const row = await env.DB.prepare(
    `INSERT INTO submissions (map_slug, field, value, note, submitter, contact, ip_hash, status, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8) RETURNING id`
  )
    .bind(slug, field, JSON.stringify(checked.value), note.value, submitter.value, contact.value, ipHash, Date.now())
    .first<{ id: number }>();

  return json({
    ok: true,
    id: row?.id ?? null,
    message: '已收到，审核通过后会出现在条目里',
  });
}

/**
 * GET /api/submission?id=<id> —— 投稿人查自己的审核状态。
 *
 * 说明：id 是自增整数，理论上可被枚举。所以这里**只返回状态与理由**，
 * 不回显投稿内容、昵称和联系方式 —— 枚举者拿不到别人填了什么。
 */
export async function handleSubmissionStatus(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  if (request.method !== 'GET') return fail('只支持 GET', 405);
  const id = Number(url.searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) return fail('id 不合法');

  const row = await env.DB.prepare(
    `SELECT status, field, map_slug, reject_note, created_at, commit_sha FROM submissions WHERE id = ?1`
  )
    .bind(id)
    .first<{
      status: string;
      field: string;
      map_slug: string;
      reject_note: string | null;
      created_at: number;
      commit_sha: string | null;
    }>();

  if (!row) return fail('没有这条投稿', 404);
  return json({ ok: true, id, ...row });
}

/* ===== 审核台接口（全部要 ADMIN_TOKEN） ===== */

/** GET /api/admin/queue?status=pending&limit=50 */
export async function handleAdminQueue(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return fail('只支持 GET', 405);

  const status = url.searchParams.get('status') ?? 'pending';
  if (!['pending', 'applied', 'rejected'].includes(status)) return fail('状态不合法');
  const limitRaw = Number(url.searchParams.get('limit') ?? 50);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

  const { results } = await env.DB.prepare(
    `SELECT id, map_slug, field, value, note, submitter, contact, status, created_at,
            reviewed_at, reviewer, reject_note, commit_sha, error
     FROM submissions WHERE status = ?1 ORDER BY created_at ASC LIMIT ?2`
  )
    .bind(status, limit)
    .all<SubmissionRow>();

  const counts = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM submissions GROUP BY status`
  ).all<{ status: string; n: number }>();

  /*
   * 附上社区文档里该字段的当前值，审核员好做「现值 vs 新值」对比。
   * 读不到（没配 GITHUB_TOKEN、网络抽风）不算错误 —— 队列照样要能看，
   * 每张图只读一次。
   */
  const cache = new Map<string, Record<string, { v: unknown }> | null>();
  const items = [];
  for (const row of results ?? []) {
    let current: unknown = null;
    try {
      if (!cache.has(row.map_slug)) {
        const { doc } = await readCommunityDoc(env, row.map_slug);
        cache.set(row.map_slug, doc.fields as Record<string, { v: unknown }>);
      }
      const fields = cache.get(row.map_slug);
      current = row.field === 'body' ? null : (fields?.[row.field]?.v ?? null);
    } catch {
      cache.set(row.map_slug, null);
    }

    let value: unknown = null;
    try {
      value = JSON.parse(row.value);
    } catch {
      value = null;
    }
    items.push({ ...row, value, current });
  }

  return json({
    ok: true,
    status,
    items,
    counts: Object.fromEntries((counts.results ?? []).map((r) => [r.status, r.n])),
    gitReady: Boolean(env.GITHUB_TOKEN),
  });
}

/** POST /api/admin/review  body: {id, action: 'approve'|'reject', rejectNote?, reviewer?} */
export async function handleAdminReview(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);

  const parsed = await readJsonBody(request, 4096);
  if (!parsed.ok) return parsed.response;
  const b = parsed.body;

  const id = Number(b.id);
  const action = typeof b.action === 'string' ? b.action : '';
  if (!Number.isInteger(id) || id <= 0) return fail('id 不合法');
  if (action !== 'approve' && action !== 'reject') return fail('action 只能是 approve / reject');

  const reviewerRaw = optString(b.reviewer, 32, '审核人');
  if (!reviewerRaw.ok) return fail(reviewerRaw.error);
  const reviewer = reviewerRaw.value;

  const sub = await env.DB.prepare(`SELECT * FROM submissions WHERE id = ?1`)
    .bind(id)
    .first<SubmissionRow>();
  if (!sub) return fail('找不到这条投稿', 404);
  if (sub.status === 'applied') return fail('这条已经写回仓库了', 409);

  /* --- 驳回 --- */
  if (action === 'reject') {
    const reasonRaw = optString(b.rejectNote, 300, '驳回理由');
    if (!reasonRaw.ok) return fail(reasonRaw.error);
    await env.DB.prepare(
      `UPDATE submissions SET status='rejected', reviewed_at=?1, reviewer=?2, reject_note=?3, error=NULL WHERE id=?4`
    )
      .bind(Date.now(), reviewer, reasonRaw.value, id)
      .run();
    return json({ ok: true, id, status: 'rejected' });
  }

  /* --- 通过：写回 git --- */
  let value: unknown;
  try {
    value = JSON.parse(sub.value);
  } catch {
    return fail('这条投稿的值已损坏，无法应用', 500);
  }

  try {
    const { doc, sha } = await readCommunityDoc(env, sub.map_slug);
    const change = applySubmission(doc, {
      id: sub.id,
      field: sub.field,
      value,
      submitter: sub.submitter,
      reviewedAt: Date.now(),
    });
    touch(doc);
    const { sha: commitSha, created } = await writeCommunityDoc(
      env,
      sub.map_slug,
      doc,
      commitMessage(sub, change, reviewer),
      sha
    );

    await env.DB.prepare(
      `UPDATE submissions SET status='applied', reviewed_at=?1, reviewer=?2, commit_sha=?3, error=NULL WHERE id=?4`
    )
      .bind(Date.now(), reviewer, commitSha, id)
      .run();

    return json({
      ok: true,
      id,
      status: 'applied',
      map: sub.map_slug,
      field: change.field,
      commit: commitSha,
      createdFile: created,
      /* 提示前端：这次提交会触发 Cloudflare 重新构建，约 1~2 分钟后页面才更新 */
      note: '已写回仓库，Cloudflare 会在 1~2 分钟内重建上线',
    });
  } catch (err) {
    const e = err as GitError;
    const message = e?.message || String(err);
    // 失败也要留痕，但**不改状态** —— 投稿仍是 pending，修好配置后可以重试
    await env.DB.prepare(`UPDATE submissions SET error=?1 WHERE id=?2`)
      .bind(message.slice(0, 300), id)
      .run();
    return fail(message, typeof e?.status === 'number' ? e.status : 500);
  }
}

/** POST /api/admin/ban  body: {id, reason?} —— 用投稿 id 封禁，审核台不需要接触 ip_hash */
export async function handleAdminBan(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);

  const parsed = await readJsonBody(request, 2048);
  if (!parsed.ok) return parsed.response;

  const id = Number(parsed.body.id);
  if (!Number.isInteger(id) || id <= 0) return fail('id 不合法');
  const reasonRaw = optString(parsed.body.reason, 200, '封禁理由');
  if (!reasonRaw.ok) return fail(reasonRaw.error);

  const sub = await env.DB.prepare(`SELECT ip_hash, map_slug FROM submissions WHERE id = ?1`)
    .bind(id)
    .first<{ ip_hash: string; map_slug: string }>();
  if (!sub) return fail('找不到这条投稿', 404);

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO bans (ip_hash, reason, banned_at) VALUES (?1,?2,?3)
     ON CONFLICT(ip_hash) DO UPDATE SET reason=excluded.reason, banned_at=excluded.banned_at`
  )
    .bind(sub.ip_hash, reasonRaw.value, now)
    .run();

  // 顺手把这个来源所有待审投稿一并驳回，免得还要一条条点
  const cleared = await env.DB.prepare(
    `UPDATE submissions SET status='rejected', reject_note='来源已被封禁', reviewed_at=?1
     WHERE ip_hash=?2 AND status='pending'`
  )
    .bind(now, sub.ip_hash)
    .run();

  return json({ ok: true, banned: true, alsoRejected: cleared ? true : true });
}
