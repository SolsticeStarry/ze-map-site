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

import { applySubmission, isNoteField, touch } from '../shared/community-doc.mjs';
import { FIELD_RULES, LIMITS, isField, validateValue } from '../shared/submission-fields.mjs';
import { GitError, readCommunityDoc, writeCommunityDoc } from './community';
import {
  checkCoverBytes,
  commitCoverToRepo,
  coverMetaOf,
  coverRepoPath,
  coverUrl,
  dropPendingCover,
  imageResponse,
  pendingCoverKey,
  putPendingCover,
  readPendingCover,
} from './covers';
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

/** 投稿内容存在 submissions.value 里（TEXT，JSON）。坏掉时返回 null，由调用方决定怎么报错。 */
function parseStoredValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function commitMessage(sub: SubmissionRow, change: { field: string; from: unknown; to: unknown }, reviewer: string): string {
  const who = sub.submitter || '匿名';
  const audit = reviewer ? `，审核 ${reviewer}` : '';
  /* 正文类字段（补充说明 / 背景故事）是「追加一条」，没有 from → to 可言，
     所以用字段标签写一条更可读的提交信息；标签来自字段表，加字段不用改这里。 */
  if (isNoteField(change.field)) {
    return `社区投稿：${sub.map_slug} ${FIELD_RULES[change.field]?.label ?? '补充说明'}（by ${who}${audit}）`;
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

/* ===== 封面投稿（B 方案）：multipart 上传 → KV 暂存 → 审核后进仓库 ===== */

/**
 * POST /api/submit-cover —— multipart/form-data
 *   map / submitter / contact / note / turnstileToken + 文件字段 cover
 *
 * 与 /api/submit 的关系：走同一套限流桶（免得有人靠两个入口把额度翻倍）、
 * 同一套封禁与人机校验，只是内容从 JSON 换成文件。
 */
export async function handleSubmitCover(
  request: Request,
  env: Env,
  ipHash: string,
  rawIp: string
): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);

  /* 先看 Content-Length：明显超限的直接拒，别把整个 body 读进内存 */
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared && declared > 2 * 1024 * 1024) return fail('上传内容过大', 413);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail('上传格式不对（应为 multipart/form-data）');
  }

  const slug = typeof form.get('map') === 'string' ? String(form.get('map')).trim() : '';
  if (!SLUG_RE.test(slug)) return fail('地图参数不合法');

  const file = form.get('cover');
  if (!(file instanceof File) && !(file instanceof Blob)) return fail('没有收到图片文件');
  const bytes = new Uint8Array(await (file as Blob).arrayBuffer());

  /* 服务端权威校验：不看 content-type，只看字节（客户端压缩只是省流量，不算数） */
  const check = checkCoverBytes(bytes);
  if (!check.ok || !check.format) return fail(check.error ?? '图片不合法');

  const submitter = optString(form.get('submitter'), LIMITS.submitter, '昵称');
  if (!submitter.ok) return fail(submitter.error);
  const contact = optString(form.get('contact'), LIMITS.contact, '联系方式');
  if (!contact.ok) return fail(contact.error);
  const note = optString(form.get('note'), LIMITS.note, '理由');
  if (!note.ok) return fail(note.error);

  if (await isBanned(env, ipHash)) return fail('该来源已被禁止投稿', 403);

  if (env.TURNSTILE_SECRET && !(await verifyTurnstile(env, form.get('turnstileToken'), rawIp))) {
    return fail('人机验证没通过，请重试', 400);
  }

  if (!(await allowWrite(env, ipHash, 'submit', LIMITS.perHour))) {
    return fail(`投稿太频繁了（每小时最多 ${LIMITS.perHour} 条），请过一会儿再试`, 429);
  }

  /* 先写 KV 再写 D1：反过来的话 D1 里会留下指向不存在图片的记录 */
  const key = pendingCoverKey(check.format);
  try {
    await putPendingCover(env, key, bytes, check.format);
  } catch (err) {
    const e = err as GitError;
    return fail(e?.message || '图片暂存失败', typeof e?.status === 'number' ? e.status : 500);
  }

  const meta = {
    key,
    ext: check.format,
    bytes: bytes.length,
    width: check.width ?? 0,
    height: check.height ?? 0,
  };

  try {
    const row = await env.DB.prepare(
      `INSERT INTO submissions (map_slug, field, value, note, submitter, contact, ip_hash, status, created_at)
       VALUES (?1,'cover',?2,?3,?4,?5,?6,'pending',?7) RETURNING id`
    )
      .bind(slug, JSON.stringify(meta), note.value, submitter.value, contact.value, ipHash, Date.now())
      .first<{ id: number }>();

    return json({
      ok: true,
      id: row?.id ?? null,
      width: meta.width,
      height: meta.height,
      bytes: meta.bytes,
      message: '已收到封面，审核通过后会出现在条目里',
    });
  } catch (err) {
    await dropPendingCover(env, key); // 回滚：别留下没人认领的图片
    throw err;
  }
}

/** GET /api/admin/cover/<id> —— 审核台取待审图片（走 /api/admin/* 的密钥校验） */
export async function handleAdminCover(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== 'GET') return fail('只支持 GET', 405);

  const id = Number(path.slice('/api/admin/cover/'.length));
  if (!Number.isInteger(id) || id <= 0) return fail('id 不合法');

  const row = await env.DB.prepare(`SELECT field, value FROM submissions WHERE id = ?1`)
    .bind(id)
    .first<{ field: string; value: string }>();
  if (!row) return fail('没有这条投稿', 404);
  if (row.field !== 'cover') return fail('这条投稿不是封面', 400);

  const meta = coverMetaOf(parseStoredValue(row.value));
  if (!meta) return fail('这条封面投稿缺少图片信息', 500);

  try {
    const pending = await readPendingCover(env, meta.key);
    if (!pending) {
      return fail(
        `待审图片在 KV 里找不到（key=${meta.key}）。常见原因是投稿时线上还是旧版本或换了存储，也可能已过期 —— 让投稿人重新上传即可`,
        410
      );
    }
    return imageResponse(pending.bytes, pending.contentType);
  } catch (err) {
    const e = err as GitError;
    return fail(e?.message || '读取图片失败', typeof e?.status === 'number' ? e.status : 500);
  }
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
      current = isNoteField(row.field) ? null : (fields?.[row.field]?.v ?? null);
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
    /* 封面被驳回：把 KV 里的待审图删掉，别白占空间（也没人会再来看了） */
    if (sub.field === 'cover') {
      const meta = coverMetaOf(parseStoredValue(sub.value));
      if (meta) await dropPendingCover(env, meta.key);
    }
    return json({ ok: true, id, status: 'rejected' });
  }

  /* --- 通过：写回 git --- */
  const value = parseStoredValue(sub.value);
  if (value === null) return fail('这条投稿的值已损坏，无法应用', 500);

  /* 封面走单独一条路：先把图片提交进仓库，再把路径记进社区文档 */
  if (sub.field === 'cover') return applyCoverSubmission(env, sub, reviewer, value);

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

/**
 * 封面投稿的落盘：图片进仓库 → 路径记进社区文档 → 删掉 KV 里的待审副本。
 *
 * 为什么单独一条路：普通字段只要写一次 JSON，封面要动二进制（还会顺带清掉同名其它扩展名）、
 * 再写一次社区文档、最后清理临时文件 —— 混在主干里会把那段读成一团。
 *
 * 失败语义与主干一致：任何一步抛错都**不改状态**（投稿仍 pending），修好后可以重试。
 */
async function applyCoverSubmission(
  env: Env,
  sub: SubmissionRow,
  reviewer: string,
  value: unknown
): Promise<Response> {
  const meta = coverMetaOf(value);
  if (!meta) return fail('这条封面投稿缺少图片信息，无法应用', 500);

  try {
    const pending = await readPendingCover(env, meta.key);
    if (!pending) {
      return fail(
        `待审图片在 KV 里找不到（key=${meta.key}），无法写回。请让投稿人重新上传`,
        410
      );
    }
    /* 再校验一次：KV 里的字节才是真正要进仓库的东西 */
    const check = checkCoverBytes(pending.bytes);
    if (!check.ok || !check.format) return fail(`待审图片校验未通过：${check.error}`, 400);

    const repoPath = coverRepoPath(sub.map_slug, check.format);
    /* ⚠️ 存进社区文档的必须是 **URL**（/images/...），不是仓库路径：
       页面会把 data.cover 直接当 <img src>，存成 public/images/... 就是破图。 */
    const url = coverUrl(sub.map_slug, check.format);
    const who = sub.submitter || '匿名';
    const audit = reviewer ? `，审核 ${reviewer}` : '';

    /* 1) 图片进仓库（顺带删掉同一张图的其它扩展名，避免 custom/ 里留两份） */
    const { sha: imageSha, removed } = await commitCoverToRepo(
      env,
      sub.map_slug,
      pending.bytes,
      check.format,
      `社区投稿：${sub.map_slug} 封面（by ${who}${audit}）`
    );

    /* 2) 社区文档里记一笔：谁什么时候换的（值为页面用的 URL） */
    const { doc, sha } = await readCommunityDoc(env, sub.map_slug);
    const change = applySubmission(doc, {
      id: sub.id,
      field: 'cover',
      value: url,
      submitter: sub.submitter,
      reviewedAt: Date.now(),
    });
    touch(doc);
    const { created } = await writeCommunityDoc(
      env,
      sub.map_slug,
      doc,
      `社区投稿：${sub.map_slug} 封面登记（by ${who}${audit}）`,
      sha
    );

    /* 3) 清理临时副本（失败不影响结果，另有 KV 的 30 天过期兜底） */
    await dropPendingCover(env, meta.key);

    await env.DB.prepare(
      `UPDATE submissions SET status='applied', reviewed_at=?1, reviewer=?2, commit_sha=?3, error=NULL WHERE id=?4`
    )
      .bind(Date.now(), reviewer, imageSha, sub.id)
      .run();

    return json({
      ok: true,
      id: sub.id,
      status: 'applied',
      map: sub.map_slug,
      field: change.field,
      commit: imageSha,
      coverPath: repoPath,
      coverUrl: url,
      removedOldCovers: removed,
      createdDoc: created,
      note: '封面已写回仓库，Cloudflare 会在 1~2 分钟内重建上线',
    });
  } catch (err) {
    const e = err as GitError;
    const message = e?.message || String(err);
    await env.DB.prepare(`UPDATE submissions SET error=?1 WHERE id=?2`)
      .bind(message.slice(0, 300), sub.id)
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
