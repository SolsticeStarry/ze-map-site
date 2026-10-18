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

import {
  applySubmission,
  emptyDoc,
  findNoteIndex,
  isItemField,
  isDocField,
  isNoteField,
  isReviseId,
  isTitledField,
  notePayload,
  revisionTarget,
  titledReviseOf,
  titledSections,
  touch,
} from '../shared/community-doc.mjs';
import { FIELD_RULES, LIMITS, MAX_SECTIONS_PER_MAP, docSections, isField, looksLikeBannerTitle, parseDoc, validateValue } from '../shared/submission-fields.mjs';
import { mergeDraft, serializeResearch } from '../shared/draft-merge.mjs';
import {
  GitError,
  type CommitFile,
  type CommunityFile,
  commitFiles,
  commitFilesViaContents,
  communityPath,
  listRepoDir,
  readCommunityDoc,
  readCommunityDocs,
  readRepoText,
} from './community';
import {
  COVER_DIR,
  COVER_EXTS,
  checkCoverBytes,
  coverMetaOf,
  coverRepoPath,
  coverUrl,
  dropPendingImage,
  imageResponse,
  pendingCoverKey,
  pendingImageKey,
  putPendingImage,
  readPendingImage,
} from './covers';
import {
  GALLERY_CAPTION_MAX,
  GALLERY_PENDING_PREFIX,
  GALLERY_PER_FLUSH,
  GALLERY_PER_MAP_MAX,
  GALLERY_PER_REQUEST_MAX,
  checkGalleryBytes,
  galleryEntryName,
  galleryEntryUrl,
  galleryManifestPath,
  galleryMetaOf,
  galleryObjectKey,
  parseManifest,
  putGalleryImage,
  serializeManifest,
  withImages,
  type GalleryEntry,
  type GalleryManifest,
} from './gallery';
import { allowWrite, fail, isBanned, json, readJsonBody, type Env } from './http';
import { ensureSchema } from './auth';
import { pushNotification, pushNotifications } from './notifications';
import { turnstileMessage, verifyTurnstile } from './turnstile';
import { SLUG_RE } from './votes';
import { accountForSubmit, recalcUserStats } from './auth';

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
  /** 账号 id（P4）：登录后投稿才有；匿名投稿为 null */
  user_id: number | null;
  /** 作者自助修订（2026-10-19）：指向原投稿 id；delete_request=1 表示「申请删除」 */
  revise_of: number | null;
  delete_request: number | null;
}

/* ===== 小工具 ===== */

/**
 * 投稿额度：小时桶 + 天桶（文本投稿与封面投稿**共用** `submit` 桶，防止靠两个入口翻倍）。
 * 为什么不设成「无限」：`TURNSTILE_SECRET` 没配时，这两个桶是唯一的防刷闸门 ——
 * 脚本灌满待审队列会挤掉正常投稿，也会吃掉 D1 免费额度（每天 10 万行写入）。
 * 300 条/小时对正常人是天文数字（手打一天也到不了），所以它实际只拦脚本。
 */
async function submissionQuota(env: Env, ipHash: string): Promise<Response | null> {
  if (!(await allowWrite(env, ipHash, 'submit', LIMITS.perHour))) {
    return fail(`投稿太频繁了（一小时最多 ${LIMITS.perHour} 条），请过一会儿再试`, 429);
  }
  if (LIMITS.perDay > 0 && !(await allowWrite(env, ipHash, 'submit', LIMITS.perDay, 'day'))) {
    return fail(`这个网络出口今天投得太多了（上限 ${LIMITS.perDay} 条），请明天再试`, 429);
  }
  return null;
}

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

/** 投稿内容存在 submissions.value 里（TEXT，JSON）。坏掉时返回 null，由调用方决定怎么报错。 */
function parseStoredValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* Turnstile 校验搬到 worker/turnstile.ts 了 —— 注册/登录/投稿三个入口共用同一份，
   而且它把「token 不对」和「校验服务不可达」分开返回，提示才不会误导用户。 */

/**
 * 写入一条投稿 —— 三个入口（文本 / 封面 / 图片集）共用。
 *
 * 为什么要包一层（这是踩过的坑）：
 * `user_id` 这一列是账号系统上线后才有的（worker/auth.ts 的懒建表）。老库的
 * submissions 表里没有它，如果匿名投稿也把 `user_id` 写进列清单，
 * 「还没人登录过」时的第一条投稿就会整条报 `no column named user_id` → 500。
 * 这正好是最不能接受的失败方式：账号系统拖垮投稿。
 *
 * 所以：
 *   · 匿名投稿**压根不提 user_id**（老库、新库都能跑，缺列时默认就是 NULL）；
 *   · 登录投稿才带上它；万一那一列还是写不进去（懒建表失败），退回匿名待审，
 *     稿子照收 —— 宁可丢署名与免审，也不能丢稿。
 *
 * @returns degraded=true 表示退回了匿名待审（账号信息没写进去）
 */
async function insertSubmission(
  env: Env,
  v: {
    slug: string;
    field: string;
    value: unknown;
    note: string;
    submitter: string;
    contact: string;
    ipHash: string;
    status: string;
    userId: number | null;
    /** 同一批提交的编号（2026-10-13 批量投稿用；单条投稿为空串） */
    batch?: string;
  }
): Promise<{ id: number | null; degraded: boolean }> {
  const base = [v.slug, v.field, JSON.stringify(v.value), v.note, v.submitter, v.contact, v.ipHash];
  const batch = v.batch ?? '';

  /* batch 这一列是后加的：老库没有它。写不进去就退回不带 batch 的写法（稿子不能丢） */
  const anonymous = (status: string) =>
    env.DB.prepare(
      `INSERT INTO submissions (map_slug, field, value, note, submitter, contact, ip_hash, status, created_at, batch)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) RETURNING id`
    )
      .bind(...base, status, Date.now(), batch || null)
      .first<{ id: number }>()
      .catch(async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/batch/i.test(msg)) throw err;
        console.error('batch 列不存在，这条投稿按单条写：' + msg);
        return env.DB.prepare(
          `INSERT INTO submissions (map_slug, field, value, note, submitter, contact, ip_hash, status, created_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) RETURNING id`
        )
          .bind(...base, status, Date.now())
          .first<{ id: number }>();
      });

  if (v.userId === null) {
    const row = await anonymous(v.status);
    return { id: row?.id ?? null, degraded: false };
  }

  try {
    const row = await env.DB.prepare(
      `INSERT INTO submissions (map_slug, field, value, note, submitter, contact, ip_hash, status, created_at, user_id, batch)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) RETURNING id`
    )
      .bind(...base, v.status, Date.now(), v.userId, batch || null)
      .first<{ id: number }>();
    return { id: row?.id ?? null, degraded: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/user_id|batch/i.test(msg)) throw err;
    console.error('user_id / batch 写不进去，这条投稿退回匿名待审：' + msg);
    const row = await anonymous('pending');
    return { id: row?.id ?? null, degraded: true };
  }
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

  /* 16 KB：神器 / 道具一次能交 40 行（字段规则里另有 6000 字的文本总量上限），
     8 KB 装不下 —— 但也没有放开到「随便传」的程度。 */
  const parsed = await readJsonBody(request, 16384);
  if (!parsed.ok) return parsed.response;
  const b = parsed.body;

  const slug = typeof b.map === 'string' ? b.map.trim() : '';
  const field = typeof b.field === 'string' ? b.field.trim() : '';
  if (!SLUG_RE.test(slug)) return fail('地图参数不合法');

  /*
   * 批量投稿（2026-10-13）：一次整理常常同时改好几项（难度 + 标签 + 视频 + 正文…）。
   * 收到 `items[]` 就逐项校验、逐项入库，共用同一个 batch 号 —— 审核台据此把它们标成同一批。
   * 上限 10 项：再多就该拆开投（也顺便挡住「一次性灌一堆」的脚本）。
   */
  const rawItems = Array.isArray(b.items) ? (b.items as Array<{ field?: unknown; value?: unknown }>) : null;
  const items: Array<{ field: string; value: unknown }> = [];
  if (rawItems) {
    if (!rawItems.length) return fail('items 是空的');
    if (rawItems.length > 10) return fail('一次最多提交 10 项，请分两次');
    for (const [i, it] of rawItems.entries()) {
      const f = typeof it?.field === 'string' ? it.field.trim() : '';
      if (!isField(f)) return fail(`第 ${i + 1} 项：不认识的字段`);
      const checked = validateValue(f, it?.value);
      if (!checked.ok) return fail(`第 ${i + 1} 项（${FIELD_RULES[f]?.label ?? f}）：${checked.error}`);
      items.push({ field: f, value: checked.value });
    }
  } else {
    if (!isField(field)) return fail('不认识的字段');
    const checked = validateValue(field, b.value);
    if (!checked.ok) return fail(checked.error);
    items.push({ field, value: checked.value });
  }
  /* 单条投稿沿用老变量，后面「修订」「草稿」这些分支读的是它 */
  const single = items.length === 1 ? items[0] : null;
  const singleField = single?.field ?? '';
  const singleValue = single?.value ?? '';

  const submitter = optString(b.submitter, LIMITS.submitter, '昵称');
  if (!submitter.ok) return fail(submitter.error);
  const contact = optString(b.contact, LIMITS.contact, '联系方式');
  if (!contact.ok) return fail(contact.error);
  const note = optString(b.note, LIMITS.note, '理由');
  if (!note.ok) return fail(note.error);

  /*
   * 修订：投稿人要改的是**已经通过的那一条**（背景故事 / 攻略 / 补充说明这类 note 字段）。
   * 值仍然存在 submissions.value 里，但换成 { text, reviseOf } —— 为一个可选字段动 D1 表结构
   * （要写迁移、要多一次全表变更）不值得，value 本来就是 JSON 一列。
   * 非 note 字段带上 reviseOf 直接忽略：那些字段是覆盖式的，本来就等于修订。
   */
  const reviseOf = isReviseId(b.reviseOf) ? String(b.reviseOf).trim() : '';
  /*
   * 「社区整理」（自定义小节，kind=titledtext）的值本来就是 { title, text }，
   * 修订时把 reviseOf 并进同一个对象即可；普通长文本仍是 { text, reviseOf } 那个包。
   */
  const stored = isTitledField(singleField)
    ? { ...(singleValue as Record<string, unknown>), ...(reviseOf ? { reviseOf } : {}) }
    : isNoteField(singleField) && reviseOf
      ? { text: singleValue, reviseOf }
      : singleValue;

  if (await isBanned(env, ipHash)) return fail('该来源已被禁止投稿', 403);

  const human = await verifyTurnstile(env, b.turnstileToken, rawIp, { required: false });
  if (!human.ok) return fail(turnstileMessage(human.reason), 400);

  const quota = await submissionQuota(env, ipHash);
  if (quota) return quota;

  /*
   * 账号（P4）：登录了就挂到账号上 ——
   *   · `user_id` 记进 submissions，等级统计靠它；
   *   · 昵称用**账号昵称**覆盖手填值，否则谁都能填别人的昵称投稿，署名与等级都会失真；
   *   · 高等级（通过 ≥10 条、驳回 ≤20%）免审：直接进「待写回」队列，省掉人工点通过那一步。
   * 没登录就完全按老路子走（匿名投稿，署名用手填昵称）。
   */
  const account = await accountForSubmit(request, env).catch(() => ({ id: null, name: null, trusted: false }));

  /*
   * 需要登录的字段（`requireLogin`）：现在是「整篇草稿」（大面积改写）与「社区整理」（长文小节）。
   * 两者都会长期留在页面上、要能追到人；匿名通道一行没动，其它字段照旧谁都能投（站长定的底线）。
   */
  const needsLogin = items.some((it) => FIELD_RULES[it.field]?.requireLogin);
  if (needsLogin && !account.id) {
    const label = FIELD_RULES[items.find((it) => FIELD_RULES[it.field]?.requireLogin)!.field]?.label ?? '这一项';
    return fail(`「${label}」需要先登录再提交（长篇内容要能追到人）；其它字段不登录也能投`, 401);
  }

  const finalSubmitter = account.name ?? submitter.value;
  const status = account.trusted ? 'approved' : 'pending';

  /*
   * 「社区整理」小节（2026-10-15）：**一张图累计最多 MAX_SECTIONS_PER_MAP 节**。
   * 在这里用 D1 拦一道（不读 GitHub，就一次查询）：把这张图已有投稿里的节数数一遍
   * （待审 / 待写回 / 已上线都算），加上这次要投的节数，超了就退回去。
   * 为什么按「节」而不是按「条」数：一次投稿可以带 1~3 节（`{ sections: [...] }`）。
   *
   * ⚠️ **修订是替换，不占新名额**（2026-10-15 修，站长点的 bug）：
   * 点「修订这条」改一节会插一条新投稿行、老行仍是 applied —— 直接按行累加的话，
   * 同一节改两次就吃掉 3 个名额，页面上明明只有 6 节却提示「超过上限」。
   * 口径改成「**页面上实际有几节**」：
   *   · 普通投稿行：它有几节算几节；
   *   · 修订行（带 reviseOf）：目标是**真实存在的普通投稿**时不计数 —— 它替换的是已有那一节；
   *     目标没了（被删 / 被手改）时按新增算（写回时也是这个降级规则，见 applySubmission）；
   *   · 这次要投的那一条同理：单节 + 目标在 → 不计入；多节投稿写回时一律按新增（见 flush），
   *     所以这里也照新增算。
   */
  const sectionItem = items.find((it) => it.field === 'section');
  if (sectionItem) {
    const incoming = titledSections(sectionItem.value);
    const { results: rows } = await env.DB.prepare(
      `SELECT id, value FROM submissions
        WHERE map_slug = ?1 AND field = 'section' AND status IN ('pending','approved','applied')`
    )
      .bind(slug)
      .all<{ id: number; value: string }>();

    const parsed = (value: unknown): { n: number; reviseOf: string } => {
      try {
        const v = JSON.parse(String(value));
        return { n: titledSections(v).length || 1, reviseOf: titledReviseOf(v) };
      } catch {
        return { n: 1, reviseOf: '' };
      }
    };
    /** 这条投稿是不是「替换某条已有投稿」的修订（目标得是真存在、且本身不是修订行） */
    const isReplacement = (reviseOf: string): boolean => {
      const target = revisionTarget(reviseOf);
      if (!target) return false;
      const row = (rows ?? []).find((r) => Number(r.id) === target.submission);
      return Boolean(row) && !parsed(row!.value).reviseOf;
    };

    let existing = 0;
    for (const row of rows ?? []) {
      const { n, reviseOf } = parsed(row.value);
      if (reviseOf && isReplacement(reviseOf)) continue; /* 替换掉的那一节：不计入（它没让页面多出一节） */
      existing += n;
    }
    /* 这次要投的：单节修订且目标在 → 也是替换，不占名额；多节一律按新增算 */
    const replaces = incoming.length === 1 && isReplacement(titledReviseOf(sectionItem.value));
    const incomingCount = replaces ? 0 : incoming.length;

    if (existing + incomingCount > MAX_SECTIONS_PER_MAP) {
      return fail(
        `这张图已经有 ${existing} 节「社区整理」，再加 ${incomingCount} 节会超过上限 ${MAX_SECTIONS_PER_MAP} 节。` +
          '要改已有那几节：在投稿页右侧那一条上点「修订这条」，改完再提交（替换不占名额）。',
        409
      );
    }
  }

  /* 一批多于一項才打 batch 号：单条投稿还是老样子（队列里不受影响） */
  const batch = items.length > 1 ? `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` : '';

  const ids: number[] = [];
  let degradedAny = false;
  for (const it of items) {
    const payload = it === single ? stored : it.value;
    const { id, degraded } = await insertSubmission(env, {
      slug,
      field: it.field,
      value: payload,
      note: note.value,
      submitter: finalSubmitter,
      contact: contact.value,
      ipHash,
      status,
      userId: account.id,
      batch,
    });
    ids.push(id);
    if (degraded) degradedAny = true;
  }
  /* 账号信息没写进去时不能再按「免审直发」处理：那条已经退回待审了 */
  const autoApproved = account.trusted && !degradedAny;

  return json({
    ok: true,
    id: ids[ids.length - 1],
    ids,
    count: ids.length,
    batch,
    autoApproved,
    message: autoApproved
      ? '已收到。你的账号已获免审资格，这些稿子会直接随下一批写回 —— 几分钟后就能在条目里看到'
      : items.length > 1
        ? `已收到 ${items.length} 项（同一批，编号 ${ids.join('、')}），审核通过后会出现在条目里`
        : '已收到，审核通过后会出现在条目里',
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

  const human = await verifyTurnstile(env, form.get('turnstileToken'), rawIp, { required: false });
  if (!human.ok) return fail(turnstileMessage(human.reason), 400);

  const quota = await submissionQuota(env, ipHash);
  if (quota) return quota;

  /* 先写 KV 再写 D1：反过来的话 D1 里会留下指向不存在图片的记录 */
  const key = pendingCoverKey(check.format);
  try {
    await putPendingImage(env, key, bytes, check.format);
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
    /* 账号（P4）：登录了的封面投稿也挂到账号上 —— 图片类贡献同样计等级 */
    const account = await accountForSubmit(request, env).catch(() => ({ id: null, name: null, trusted: false }));
    const { id } = await insertSubmission(env, {
      slug,
      field: 'cover',
      value: meta,
      note: note.value,
      submitter: account.name ?? submitter.value,
      contact: contact.value,
      ipHash,
      status: account.trusted ? 'approved' : 'pending',
      userId: account.id,
    });

    return json({
      ok: true,
      id,
      width: meta.width,
      height: meta.height,
      bytes: meta.bytes,
      message: '已收到封面，审核通过后会出现在条目里',
    });
  } catch (err) {
    await dropPendingImage(env, key); // 回滚：别留下没人认领的图片
    throw err;
  }
}

/**
 * POST /api/submit-gallery —— multipart/form-data
 *   map / submitter / contact / note / turnstileToken + **一个或多个** 文件字段 image
 *   + 每个 image 对应一个 caption（重复字段，按顺序对齐；少给的当空）
 *
 * 与封面接口的差别只有三点：不裁 16:9（截图本来就该保持原样）、上限放到 1.5 MB、
 * 通过后进的是 R2 的 `gallery/` 前缀而不是仓库里的二进制（见 worker/gallery.ts）。
 * 限流桶、封禁、人机校验与文本 / 封面投稿完全共用。
 *
 * ⚠️ **一批可以带多张**（2026-10-16 改，社区反馈的真 bug）：
 * 以前一次请求只收一张，投稿页就逐张发 —— 而 Turnstile 的 token 是**一次性**的，
 * 于是第 1 张成功、第 2 张必被判「人机验证没通过」（社区朋友传 10 多张时正好撞上，
 * 原话是「图片太多的话每张图片都要人机验证一遍，然后又容易卡验证，导致不能批量化」）。
 * 现在一次请求最多收 GALLERY_PER_REQUEST_MAX 张，**一次请求只验一次人机**，
 * 每张仍旧各成一条投稿（审核台照旧一张一张看），返回值里带每张的结果。
 */
export async function handleSubmitGallery(
  request: Request,
  env: Env,
  ipHash: string,
  rawIp: string
): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);

  /*
   * 一批最多 GALLERY_PER_REQUEST_MAX 张（与单图上限解耦：单图上限 2026-10-16 提到 36，
   * 但一次请求仍只收 24 —— 24 × 1.5 MB ≈ 36 MB，配 48 MB 的请求体上限刚好）。
   */
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared && declared > 48 * 1024 * 1024) {
    return fail(`上传内容过大（一次最多 ${GALLERY_PER_REQUEST_MAX} 张、每张 1.5 MB）`, 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail('上传格式不对（应为 multipart/form-data）');
  }

  const slug = typeof form.get('map') === 'string' ? String(form.get('map')).trim() : '';
  if (!SLUG_RE.test(slug)) return fail('地图参数不合法');

  const files = form.getAll('image').filter((f): f is File => f instanceof File || f instanceof Blob);
  if (!files.length) return fail('没有收到图片文件');
  if (files.length > GALLERY_PER_REQUEST_MAX) {
    return fail(`一次最多传 ${GALLERY_PER_REQUEST_MAX} 张（这次收到 ${files.length} 张），请分几次传`, 413);
  }

  /* 说明按顺序对齐：第 i 个 caption 对应第 i 张图（少给的当空） */
  const captions = form.getAll('caption').map((c) => (typeof c === 'string' ? c : ''));
  const captionChecks = files.map((_, i) => optString(captions[i] ?? '', GALLERY_CAPTION_MAX, '图片说明'));
  const badCaption = captionChecks.find((c) => !c.ok);
  if (badCaption) return fail(badCaption.error);

  const submitter = optString(form.get('submitter'), LIMITS.submitter, '昵称');
  if (!submitter.ok) return fail(submitter.error);
  const contact = optString(form.get('contact'), LIMITS.contact, '联系方式');
  if (!contact.ok) return fail(contact.error);
  const note = optString(form.get('note'), LIMITS.note, '理由');
  if (!note.ok) return fail(note.error);

  if (await isBanned(env, ipHash)) return fail('该来源已被禁止投稿', 403);

  /* 人机验证**一次请求验一次**（不是每张一次）—— 这正是这次改动的目的 */
  const human = await verifyTurnstile(env, form.get('turnstileToken'), rawIp, { required: false });
  if (!human.ok) return fail(turnstileMessage(human.reason), 400);

  const quota = await submissionQuota(env, ipHash);
  if (quota) return quota;

  /* 账号（P4）：登录了的图片集投稿同样挂到账号上（署名也用账号昵称）—— 一批只查一次 */
  const account = await accountForSubmit(request, env).catch(() => ({ id: null, name: null, trusted: false }));

  interface GalleryItemResult {
    /** 在这一批里的下标（从 0 开始），前端据此对上「第几张」 */
    index: number;
    ok: boolean;
    id?: number;
    error?: string;
  }
  const items: GalleryItemResult[] = [];
  const ids: number[] = [];

  for (const [i, file] of files.entries()) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const check = checkGalleryBytes(bytes);
    if (!check.ok || !check.format) {
      /* 单张不合格**不拖累整批**：把它标出来，其余照收（旧行为是整批 400） */
      items.push({ index: i, ok: false, error: check.error ?? '图片不合法' });
      continue;
    }

    /* 先写 KV 再写 D1（同封面）：反过来 D1 里会留下指向不存在图片的记录 */
    const key = pendingImageKey(GALLERY_PENDING_PREFIX, check.format);
    try {
      await putPendingImage(env, key, bytes, check.format);
    } catch (err) {
      const e = err as GitError;
      items.push({ index: i, ok: false, error: e?.message || '图片暂存失败' });
      continue;
    }

    const meta = {
      key,
      ext: check.format,
      bytes: bytes.length,
      width: check.width ?? 0,
      height: check.height ?? 0,
      caption: captionChecks[i].value,
    };

    try {
      const { id } = await insertSubmission(env, {
        slug,
        field: 'gallery',
        value: meta,
        note: note.value,
        submitter: account.name ?? submitter.value,
        contact: contact.value,
        ipHash,
        status: account.trusted ? 'approved' : 'pending',
        userId: account.id,
      });
      items.push({ index: i, ok: true, id });
      ids.push(id);
    } catch (err) {
      await dropPendingImage(env, key); // 回滚：别留下没人认领的图片
      items.push({ index: i, ok: false, error: err instanceof Error ? err.message : '入库失败' });
    }
  }

  /* 一张都没成：按失败回（老页面单张时读 data.error，语义与以前一致） */
  if (!ids.length) {
    return fail(items[0]?.error ?? '图片不合法', 400);
  }

  return json({
    ok: true,
    /* id = 第一张的编号：老页面（单张）读的就是它，保持兼容 */
    id: ids[0],
    ids,
    /** 这一批收到几张 / 成功几张 */
    total: files.length,
    count: ids.length,
    items,
    message: `已收到 ${ids.length} 张图片，审核通过后会出现在条目的「图片集」里`,
  });
}

/**
 * GET /api/admin/cover/<id> 或 /api/admin/gallery/<id> —— 审核台取待审图片。
 *
 * 两条路径共用一个实现：都是「按 id 找到那条投稿 → 从 KV 取它的待审图」，
 * 差别只在字段名与元数据的解析方式。走 /api/admin/* 的密钥校验。
 */
export async function handleAdminImage(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== 'GET') return fail('只支持 GET', 405);

  const m = /^\/api\/admin\/(cover|gallery)\/(\d+)$/.exec(path);
  if (!m) return fail('路径不对', 400);
  const id = Number(m[2]);
  if (!Number.isInteger(id) || id <= 0) return fail('id 不合法');

  const row = await env.DB.prepare(`SELECT field, value FROM submissions WHERE id = ?1`)
    .bind(id)
    .first<{ field: string; value: string }>();
  if (!row) return fail('没有这条投稿', 404);
  if (row.field !== 'cover' && row.field !== 'gallery') return fail('这条投稿不是图片', 400);

  const value = parseStoredValue(row.value);
  const key = row.field === 'cover' ? coverMetaOf(value)?.key : galleryMetaOf(value)?.key;
  if (!key) return fail('这条投稿缺少图片信息', 500);

  try {
    const pending = await readPendingImage(env, key);
    if (!pending) {
      return fail(
        `待审图片在 KV 里找不到（key=${key}）。常见原因是投稿时线上还是旧版本或换了存储，也可能已过期 —— 让投稿人重新上传即可`,
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

/** 字段的中文名（收件箱文案里用；认不出来就退回字段名本身） */
const fieldLabel = (field: string): string => FIELD_RULES[field]?.label ?? field;

/**
 * POST /api/admin/adopt —— 把某张图的「整篇草稿」采纳为人工原稿（2026-10-13 加）。
 *
 * 这是「大面积修改」的最后一步，只有审核台的人能做（`ADMIN_TOKEN` 之后的接口，
 * 谁拿得到密钥谁就能采纳 —— 分工与守则见 docs/admin-guide.md）。
 *
 * 做三件事，一个 commit 装完：
 *   1. 读 `data/research/<slug>.json`，按小节合并草稿（同名替换、新节追加、没提到的不动）；
 *   2. 把社区文档里的草稿清掉，并在 `fields.draft` 记一条「已采纳」—— 贡献者继续留在
 *      「社区参与」名单里（mergeEntry 的 contributors 会读到），不会因为采纳而变成无名氏；
 *   3. 提交信息写清是谁整理的、谁采纳的，`git log` 就是内容变更史。
 *
 * 为什么不在 `handleAdminFlush` 的攒批里做：采纳是**低频、要单独确认**的动作，
 * 而且它写的是原稿（比社区文档重），单独一次提交的 diff 最干净、回滚最容易。
 */
export async function handleAdminAdopt(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  /* 采纳要在收件箱里通知整理者，得读 submissions.user_id —— 老库可能还没这一列，先补一次表
     （和 handleAdminQueue 同一个理由：审核台这条路以前不建表，缺列时会 500）。 */
  await ensureSchema(env);
  const parsed = await readJsonBody(request, 4096);
  if (!parsed.ok) return parsed.response;

  const slug = typeof parsed.body.slug === 'string' ? parsed.body.slug.trim() : '';
  if (!SLUG_RE.test(slug)) return fail('地图参数不合法');

  /* 草稿必须是**已经写回仓库**的那一篇（页面上正以「未采纳」显示），否则页面与实际不一致 */
  const row = await env.DB.prepare(
    `SELECT id, value, submitter, reviewed_at, commit_sha, user_id FROM submissions
      WHERE map_slug = ?1 AND field = 'draft' AND status = 'applied'
      ORDER BY id DESC LIMIT 1`
  )
    .bind(slug)
    .first<{
      id: number;
      value: string;
      submitter: string | null;
      reviewed_at: number | null;
      commit_sha: string | null;
      user_id: number | null;
    }>();
  if (!row) {
    return fail('这张图没有「已写回、待采纳」的草稿：先把它通过并写回仓库，页面上会出现「社区整理版（未采纳）」', 404);
  }

  const researchPath = `data/research/${slug}.json`;

  /*
   * ⚠️ 必须 **JSON.parse** 之后再交给 mergeDraft（2026-10-14 修的真事故）：
   * submissions.value 存的是 `JSON.stringify(投稿值)`（见 insertSubmission 的 base 数组），
   * 所以草稿在库里长这样：`"## 小节标题\n正文…"` —— 带外层引号、换行是字面 `\n`。
   * 以前这里直接 `String(row.value)` 传下去，于是：
   *   · `parseDoc()` 找不到行首的 `##`（那一行以引号开头）→ 0 个小节；
   *   · 整段被当成「导语」写进 summary（还是带引号和 \n 的原文）；
   *   · `sections` 被写成 `[]` → **generate-map-entries 的断言「sections 必须是非空数组」直接让构建挂掉**。
   * 队列页（handleAdminQueue）和写回（flush）那两处一直是先 parse 的，只有这里漏了 ——
   * 于是「审核台看得见草稿、写回也正常、唯独采纳会写坏原稿」，线上真的踩到了（ze_tenkinoko_welkin_z）。
   */
  let draftText = String(row.value ?? '');
  try {
    const parsedValue: unknown = JSON.parse(draftText);
    if (typeof parsedValue === 'string') draftText = parsedValue;
    /* 正文类字段是 { text, reviseOf } 的包；草稿理论上不会，但兼容一下不亏 */
    else if (parsedValue && typeof parsedValue === 'object' && typeof (parsedValue as { text?: unknown }).text === 'string') {
      draftText = String((parsedValue as { text: string }).text);
    }
  } catch {
    /* 不是 JSON（老数据 / 手写进去的）：就当它本来就是纯文本 */
  }

  /*
   * 采纳前先确认它**真的是分节草稿**：没有 `## 小节` 的文本合并进去只会得到空的 sections，
   * 而 generate-map-entries 的断言「sections 必须是非空数组」会让整站构建挂掉。
   * 这条检查放在读仓库之前 —— 注定要拒的稿子，不该先去动仓库（也少两次 GitHub 调用）。
   */
  if (!docSections(draftText).length) {
    return fail(
      '这条草稿里没有 `## 小节标题`，无法按小节合并（合并出空正文会让站点构建失败）。' +
        '请在审核台**驳回**它并请投稿人重投一版（编辑器里每节都要有标题）；或者你直接改 data/research 里的原稿。',
      400
    );
  }

  /*
   * 这一条是不是**已经采纳过**了（2026-10-14 加）：
   * 采纳之后投稿行仍是 applied（页面要能对账、也能在队列里看到），所以「采纳为原稿」按钮还在，
   * 手一抖再点一次就会拿**同一份草稿**再合并一遍 —— 对刚合并好的原稿来说，这一下是二次覆盖：
   * 原稿若在那之后被手工修过（ze_tenkinoko_welkin_z 就是这样修回来的），修好的内容会被盖回去。
   * 判据全在社区文档里：草稿位空了（采纳时 doc.draft = null），且「已采纳」那条记的正是这条投稿号。
   * 注意只看**这一条**投稿号：之后又有新草稿通过并写回时 doc.draft 非空，这里不会误拦。
   * 真要重来，显式带 force（审核台会再弹一次确认）。
   */
  const community = await readCommunityDoc(env, slug).catch(() => null);
  const doc = community?.doc ?? emptyDoc(slug);
  const adopted = (doc.fields as Record<string, { v?: string; submission?: number; by?: string; at?: string }>).draft;
  if (
    parsed.body.force !== true &&
    !doc.draft &&
    adopted &&
    typeof adopted.v === 'string' &&
    adopted.v.startsWith('已采纳') &&
    Number(adopted.submission) === row.id
  ) {
    const when = String(adopted.at ?? '').slice(0, 10);
    return json(
      {
        ok: false,
        code: 'already-adopted',
        submission: row.id,
        adoptedAt: adopted.at ?? null,
        adoptedBy: adopted.by ?? null,
        error:
          `这条草稿（投稿 #${row.id}）已经在 ${when || '此前'} 采纳过了，页面上也没有待采纳的草稿。` +
          '再采纳一次等于用同一份草稿重新合并，可能覆盖你之后手动改过的原稿。确实要重来请点「强制再合并」。',
      },
      409
    );
  }

  const raw = await readRepoText(env, researchPath);
  if (!raw) return fail(`仓库里没有 ${researchPath}（这张图还没有人工原稿，需要先建一份）`, 404);

  let research: Record<string, unknown>;
  try {
    research = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    return fail(`${researchPath} 不是合法 JSON，先修好它再采纳：${err instanceof Error ? err.message : String(err)}`, 500);
  }

  /*
   * 小节标题改写 + 「标题行混进来」的护栏（2026-10-14 加）。
   *
   * 起因：投稿人常把**条目标题行**当小节名写进草稿（整篇草稿会长成
   * `## - ze_flower (花之声) -\n\n地图由 [Karon] 绘制…`）。它跟原稿里的任何一节都不同名，
   * 于是被当成**新小节**追加：页面上多出一个叫「- ze_flower (花之声) -」的标题，
   * 内容还跟「基本信息」重复（ze_tenkinoko_welkin_z 就这么丑过一次，最后手工回滚）。
   *
   * 处理办法分两步，都不猜：
   *   1. `retitle`（可选，审核台采纳前填）：把这些标题改写成正经小节名（一般是「基本信息」）。
   *      改写结果会照实报出来（返回里的 renamed），提交信息里也写一笔。
   *   2. 没改写、又会在原稿里**新增**一个标题行小节 → 直接拒绝（400 placeholder-title），
   *      并告诉审核员怎么改。注意「原稿里已经有同名小节」的情况不拦：那是替换，不会多出标题。
   */
  const retitleRaw = parsed.body.retitle;
  const retitle: Record<string, string> = {};
  if (retitleRaw && typeof retitleRaw === 'object' && !Array.isArray(retitleRaw)) {
    for (const [from, to] of Object.entries(retitleRaw as Record<string, unknown>)) {
      const key = String(from).trim();
      const val = typeof to === 'string' ? to.trim().replace(/\s+/g, ' ') : '';
      if (!key) continue;
      if (!val) continue; /* 留空 = 不改写，照原样保留 */
      if (val.length > 40 || /[<>{}#]/.test(val)) {
        return fail(`小节标题「${val}」不像话（最多 40 字，且不能含 < > { } #）`, 400);
      }
      retitle[key] = val;
    }
  }

  const parsedDoc = parseDoc(draftText);
  const renamed: Array<{ from: string; to: string }> = [];
  const draftSecs = parsedDoc.sections.map((s) => {
    const to = retitle[s.title];
    if (!to || to === s.title) return s;
    renamed.push({ from: s.title, to });
    return { title: to, body: s.body };
  });

  const existingTitles = new Set(
    (Array.isArray(research.sections) ? research.sections : [])
      .map((s) => (s && typeof (s as { title?: unknown }).title === 'string' ? String((s as { title: string }).title).trim() : ''))
      .filter(Boolean)
  );
  const junky = draftSecs.filter((s) => looksLikeBannerTitle(s.title, slug) && !existingTitles.has(s.title.trim()));
  if (junky.length) {
    const list = junky.map((s) => `\`${s.title.trim()}\``).join('、');
    return json(
      {
        ok: false,
        code: 'placeholder-title',
        titles: junky.map((s) => s.title.trim()),
        existing: [...existingTitles],
        error:
          `草稿里的小节标题 ${list} 看着是**标题行**、不是小节名（原稿里没有这一节，` +
          '采纳后页面上就会多出这么一个标题，内容还常和「基本信息」重复）。' +
          '两个办法：① 在采纳框里把它改写成正经小节名（一般是「基本信息」），审核台会带着改写重发；' +
          '② 驳回这条草稿，请投稿人在编辑器里把 `## ` 后面那行改成小节名（例如 `## 基本信息`）再投。',
      },
      400
    );
  }
  /* 只有真的改写过才重建草稿文本（没改写就原样交给 mergeDraft，避免顺手重排人家的格式） */
  const mergedText = renamed.length
    ? [parsedDoc.intro, ...draftSecs.map((s) => `## ${s.title}\n${s.body}`)].filter((x) => String(x ?? '').trim()).join('\n\n')
    : draftText;

  const merged = mergeDraft(research, mergedText);
  /* 兜底：合并结果绝不能是空小节数组（generate-map-entries 会当场抛错） */
  if (!Array.isArray(merged.next.sections) || !merged.next.sections.length) {
    return fail('合并结果是空的（草稿与现有一节都对不上），已中止采纳，仓库未改动', 400);
  }
  const researchText = serializeResearch(merged.next, raw);

  /* 社区文档（上面已读过：既用于「是否已采纳」判断，也在这里写回）：清草稿 + 记一条「已采纳」 */
  const at = new Date().toISOString();
  const by = row.submitter || '匿名';
  doc.draft = null;
  doc.fields.draft = { v: `已采纳 ${at.slice(0, 10)}`, by, at, submission: row.id };
  doc.log = Array.isArray(doc.log) ? doc.log : [];
  doc.log.push({ field: 'draft', from: '社区整理版（未采纳）', to: '已采纳为原稿', by, at, submission: row.id });
  touch(doc, at);

  const files: CommitFile[] = [
    { path: researchPath, text: researchText },
    { path: communityPath(slug), text: JSON.stringify(doc, null, 2) + '\n' },
  ];
  const message =
    `社区采纳：${slug} 整篇草稿合并进原稿` +
    `（替换 ${merged.replaced.length} 节${merged.replaced.length ? `：${merged.replaced.join('、')}` : ''}` +
    `${merged.added.length ? `，新增 ${merged.added.length} 节：${merged.added.join('、')}` : ''}` +
    `${merged.kept.length ? `，保留 ${merged.kept.length} 节` : ''}` +
    `${renamed.length ? `，改写标题：${renamed.map((r) => `${r.from} → ${r.to}`).join('；')}` : ''}` +
    `；整理 ${by}，投稿 #${row.id}）`;

  let commitSha = '';
  try {
    const res = await commitFiles(env, files, message);
    commitSha = res.sha;
  } catch (err) {
    if (err instanceof GitError) return fail(`写回仓库失败：${err.message}`, err.status ?? 502);
    return fail(`写回仓库失败：${err instanceof Error ? err.message : String(err)}`, 502);
  }

  /* 记一笔提交号，方便日后对账（这条投稿本身仍是 applied）。
     adopted_at 一起落下：审核台靠它把「已经采纳过」的草稿从「待采纳」里排除，
     不然采纳完的还堆在那一档里，攒多了又变成翻不完的存货。
     （提交号拿不到也照样落 adopted_at —— 合并已经写进仓库了，别让列表骗人。） */
  await env.DB.prepare(`UPDATE submissions SET commit_sha = COALESCE(?1, commit_sha), adopted_at = ?2 WHERE id = ?3`)
    .bind(commitSha || null, Date.now(), row.id)
    .run()
    .catch(() => {});

  /* 收件箱：告诉整理者「你写的那篇草稿进百科正文了」（草稿必须登录才能投，所以基本都有 user_id） */
  if (row.user_id) {
    await pushNotification(env, {
      userId: row.user_id,
      kind: 'adopt',
      title: `你整理的《${slug}》草稿已被采纳`,
      body:
        `按小节合并进人工原稿：替换 ${merged.replaced.length} 节、新增 ${merged.added.length} 节、保留 ${merged.kept.length} 节。` +
        `构建完成后正文就是这一版：https://ze-map.cn/maps/${slug}/`,
      link: `/maps/${slug}/`,
      submissionId: row.id,
    });
  }

  return json({
    ok: true,
    slug,
    commit: commitSha,
    replaced: merged.replaced,
    added: merged.added,
    kept: merged.kept,
    renamed,
    summaryUpdated: Boolean(merged.summary),
    message:
      `已采纳：${slug} 的草稿合并进原稿（替换 ${merged.replaced.length} 节、新增 ${merged.added.length} 节、` +
      `保留 ${merged.kept.length} 节${merged.summary ? '，并更新了简介' : ''}` +
      `${renamed.length ? `；小节标题改写 ${renamed.map((r) => `「${r.from}」→「${r.to}」`).join('、')}` : ''}）。` +
      '等下一次构建完成后生效；页面上的「社区整理版（未采纳）」会同时消失。',
  });
}

/** GET /api/admin/queue?status=pending&limit=50 */
export async function handleAdminQueue(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return fail('只支持 GET', 405);
  /* 老库可能还没有 batch / user_id 这两列（懒建表由投稿/注册路径触发）——
     审核台是只读入口，先补一次表，否则这里会 500「no such column: batch」。 */
  await ensureSchema(env);

  const status = url.searchParams.get('status') ?? 'pending';
  /* approved = 审核通过但还没写回仓库（攒批队列），见 handleAdminFlush */
  if (!['pending', 'approved', 'applied', 'rejected'].includes(status)) return fail('状态不合法');
  const limitRaw = Number(url.searchParams.get('limit') ?? 50);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
  const offsetRaw = Number(url.searchParams.get('offset') ?? 0);
  const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? Math.min(offsetRaw, 100000) : 0;

  /*
   * 关键词 / 地图过滤（2026-10-13 审核台改版加）。
   * 以前只能在浏览器里翻已加载的那 50 条 —— 队列上百条时等于没法找。
   * 现在下沉到 SQL：q 匹配地图代码 / 字段 / 署名 / 理由 / 内容，map 精确匹配某张图。
   * 参数全部走绑定，LIKE 的通配符由我们自己拼（用户输入里的 % _ 会被转义掉）。
   */
  const qRaw = (url.searchParams.get('q') ?? '').trim().slice(0, 60);
  const mapRaw = (url.searchParams.get('map') ?? '').trim();
  const mapFilter = SLUG_RE.test(mapRaw) ? mapRaw : '';
  /*
   * field：按字段筛（2026-10-15 加）。直接原因是审核台要一个**只看整篇草稿**的入口 ——
   * 草稿混在所有字段里，站长很难找到「已写回、等着采纳」的那几条。
   */
  const fieldRaw = (url.searchParams.get('field') ?? '').trim();
  if (fieldRaw && !isField(fieldRaw)) return fail('字段不合法');
  const fieldFilter = fieldRaw;
  /*
   * adopted：整篇草稿里「已经采纳为原稿」的那些要不要一起列（2026-10-15 加）。
   * 默认**不列** —— 「待采纳」这一档的意义就是「还等着我按采纳的」，
   * 采纳过的留在里面只会重新变成一堆翻不完的存货（站长报的痛点）。
   * 想看已采纳的（比如怀疑哪篇被采纳后又手工回滚了）就显式带 adopted=1。
   */
  const adoptedRaw = (url.searchParams.get('adopted') ?? '').trim();
  const adoptedOnly = adoptedRaw === '1' || adoptedRaw === 'true';

  const where: string[] = ['status = ?1'];
  const binds: unknown[] = [status];
  if (qRaw) {
    const like = `%${qRaw.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    binds.push(like);
    const i = binds.length;
    where.push(
      `(map_slug LIKE ?${i} ESCAPE '\\' OR field LIKE ?${i} ESCAPE '\\'` +
        ` OR IFNULL(submitter,'') LIKE ?${i} ESCAPE '\\'` +
        ` OR IFNULL(note,'') LIKE ?${i} ESCAPE '\\'` +
        ` OR value LIKE ?${i} ESCAPE '\\')`
    );
  }
  if (mapFilter) {
    binds.push(mapFilter);
    where.push(`map_slug = ?${binds.length}`);
  }
  if (fieldFilter) {
    binds.push(fieldFilter);
    where.push(`field = ?${binds.length}`);
    /* 只有整篇草稿有「采纳」这一步；别的字段照旧全列 */
    if (fieldFilter === 'draft') {
      where.push(adoptedOnly ? 'adopted_at IS NOT NULL' : 'adopted_at IS NULL');
      /*
       * 「待采纳」里每张图只留**最新的一条**已写回草稿。
       * 同一张图可以攒下好几条 applied 草稿（作者改一版重投一次），而采纳时服务端取的是
       * `ORDER BY id DESC LIMIT 1` —— 老的那几条既采纳不到、内容还跟真正会合并的那篇不一样，
       * 列出来只会让「待采纳」重新变长、还容易照着旧文本做判断。
       * 只对 applied 生效：待审 / 待写回 / 已驳回那几档该有几条是几条。
       */
      if (!adoptedOnly && status === 'applied') {
        where.push(
          `id = (SELECT MAX(s2.id) FROM submissions s2
                  WHERE s2.map_slug = submissions.map_slug AND s2.field = 'draft' AND s2.status = 'applied')`
        );
      }
    }
  }
  const whereSql = where.join(' AND ');

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE ${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();

  const { results } = await env.DB.prepare(
    `SELECT id, map_slug, field, value, note, submitter, contact, status, created_at,
            reviewed_at, reviewer, reject_note, commit_sha, error, batch, adopted_at
     FROM submissions WHERE ${whereSql} ORDER BY created_at ASC LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`
  )
    .bind(...binds, limit, offset)
    .all<SubmissionRow & { batch?: string | null; adopted_at?: number | null }>();

  /* 批量投稿的「同批还有几条」：审核台据此知道这几条要一起看（一次整理，别只通过一半） */
  const batchCounts = new Map<string, number>();
  for (const row of results ?? []) {
    const b = (row as { batch?: string | null }).batch;
    if (b) batchCounts.set(b, (batchCounts.get(b) ?? 0) + 1);
  }

  const counts = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM submissions GROUP BY status`
  ).all<{ status: string; n: number }>();

  /* 指定字段时另给一份「这个字段各状态几条」——审核台的「整篇草稿」标签靠它显示待采纳数 */
  const fieldCounts = fieldFilter
    ? (Object.fromEntries(
        (
          await env.DB.prepare(
            `SELECT status, COUNT(*) AS n FROM submissions WHERE field = ?1 AND adopted_at IS NULL GROUP BY status`
          )
            .bind(fieldFilter)
            .all<{ status: string; n: number }>()
        ).results?.map((r) => [r.status, r.n]) ?? []
      ) as Record<string, number>)
    : null;
  /*
   * 「待采纳」的计数必须跟列表同一个口径（上面列表只列每张图最新的一条已写回草稿）——
   * 否则角标说 3 条、点进去只有 1 条，审核员会以为漏了。
   */
  if (fieldCounts && fieldFilter === 'draft') {
    const dedup = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM submissions
        WHERE field = 'draft' AND status = 'applied' AND adopted_at IS NULL
          AND id = (SELECT MAX(s2.id) FROM submissions s2
                     WHERE s2.map_slug = submissions.map_slug AND s2.field = 'draft' AND s2.status = 'applied')`
    ).first<{ n: number }>();
    fieldCounts.applied = Number(dedup?.n ?? 0);
  }
  /*
   * 草稿档还要一句「已经采纳了几条」（它们不在上面那份计数里）。
   * 光看「待采纳 0」会让人以为草稿没了 —— 说清楚只是采纳完了。
   */
  const adoptedCount = fieldFilter
    ? Number(
        (
          await env.DB.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE field = ?1 AND adopted_at IS NOT NULL`)
            .bind(fieldFilter)
            .first<{ n: number }>()
        )?.n ?? 0
      )
    : 0;

  /*
   * ⚠️ 这里**不再**顺手去读每张图的社区文档（2026-10-13 改）。
   *
   * 以前为了给审核员看「现值 vs 新值」，对页面上每个不同的地图都调一次 GitHub API。
   * 一次 Worker 调用只有 50 个子请求额度（免费版），而 limit 允许到 200 ——
   * 队列里 50 张不同的图时正好撞在线上限上，报 500 Too many subrequests，
   * 整个审核台打不开。现在改成：列表只返回投稿本身，「现值」由审核台按需另取
   * （GET /api/admin/current，一次最多 10 条），列表永远只花 3 个子请求。
   */
  const items = (results ?? []).map((row) => {
    let value: unknown = null;
    try {
      value = JSON.parse(row.value);
    } catch {
      value = null;
    }
    const payload = isNoteField(row.field) ? notePayload(value) : null;
    const batchId = (row as { batch?: string | null }).batch ?? '';
    /* 社区整理：可能是多节，审核台要能看到每一节的标题 */
    const titles = isTitledField(row.field) ? titledSections(value).map((s) => s.title).filter(Boolean) : [];
    /* 「社区整理」的修订包是 `{ sections, reviseOf }`，notePayload 不认 —— 单独取一下，
       审核台才会显示「✏️ 修订稿：通过后替换 #123p2 那一条」 */
    const reviseOf = (isTitledField(row.field) ? titledReviseOf(value) : '') || (payload?.reviseOf ?? '');
    return {
      ...row,
      ...(batchId ? { batch: batchId, batchCount: batchCounts.get(batchId) ?? 1 } : {}),
      value: isTitledField(row.field)
        ? titledSections(value).map((s) => `## ${s.title}\n${s.text}`).join('\n\n')
        : payload
          ? payload.text
          : value,
      ...(reviseOf ? { reviseOf } : {}),
      /* 「社区整理」的标题：审核台要能一眼看出这几节都叫什么 */
      ...(titles.length ? { title: titles[0], titles } : payload?.title ? { title: payload.title, titles: [payload.title] } : {}),
      /* 现值没取（由 /api/admin/current 按需拉）；神器 / 道具不需要「一个现值」 */
      current: null,
      currentPending: row.status === 'pending' || row.status === 'approved',
    };
  });

  return json({
    ok: true,
    status,
    items,
    q: qRaw,
    map: mapFilter,
    field: fieldFilter,
    limit,
    offset,
    total: Number(totalRow?.n ?? 0),
    counts: Object.fromEntries((counts.results ?? []).map((r) => [r.status, r.n])),
    fieldCounts,
    adoptedCount,
    gitReady: Boolean(env.GITHUB_TOKEN),
  });
}

/**
 * GET /api/admin/current?ids=1,2,3
 *
 * 取「这几条投稿对应的现值」——审核台按需调用（一次最多 10 条），
 * 让队列列表不必为每张图各读一次 GitHub。
 * 一张图只读一次（同一次调用内缓存）；读不到（没配 token / 网络问题）不回错误，
 * 对应条目返回 current: null —— 审核台照常能审，只是没有对比。
 */
export async function handleAdminCurrent(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return fail('只支持 GET', 405);
  await ensureSchema(env);

  const raw = (url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const ids = [...new Set(raw.map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return fail('要给 ids');
  if (ids.length > 10) return fail('一次最多取 10 条');

  const placeholders = ids.map((_, i) => `?${i + 1}`).join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, map_slug, field, value FROM submissions WHERE id IN (${placeholders})`
  )
    .bind(...ids)
    .all<{ id: number; map_slug: string; field: string; value: string }>();

  const cache = new Map<string, CommunityFile | null>();
  const out: Record<string, unknown> = {};
  for (const row of results ?? []) {
    try {
      if (!cache.has(row.map_slug)) cache.set(row.map_slug, await readCommunityDoc(env, row.map_slug));
    } catch {
      cache.set(row.map_slug, null as never);
    }
    const doc = cache.get(row.map_slug)?.doc ?? null;

    let value: unknown = null;
    try {
      value = JSON.parse(row.value);
    } catch {
      value = null;
    }

    let current: unknown = null;
    if (isDocField(row.field)) {
      /*
       * 整篇草稿（2026-10-15）：审核台要能一眼看出「这篇采纳过没有」。
       * 光看 D1 看不出来 —— 采纳的痕迹只写在社区文档里（`fields.draft = 已采纳 …`，同时 doc.draft 清空）。
       * 所以这里回一个小对象：页面上挂着的那篇草稿（字数 / 谁整理的）+ 有没有采纳过。
       * 审核台据此把已采纳的标出来，免得对着同一条反复点「采纳为原稿」。
       */
      const draft = doc?.draft && typeof doc.draft === 'object' ? doc.draft : null;
      const adopted = doc?.fields?.draft;
      current = {
        draftChars: draft?.text ? [...String(draft.text)].length : 0,
        draftBy: draft?.by ?? null,
        draftAt: draft?.at ?? null,
        adopted: typeof adopted?.v === 'string' && adopted.v ? adopted.v : null,
        adoptedAt: adopted?.at ?? null,
        adoptedBy: adopted?.by ?? null,
      };
    } else if (isItemField(row.field)) {
      /* 神器 / 道具的「现值」是社区文档里已有的行，不是 fields 里的某个值 */
      current = doc?.items ?? [];
    } else if (isNoteField(row.field)) {
      /*
       * 正文类字段是追加 / 修订 note，没有「一个现值」。
       * 修订时把**目标那一条的原文**当成现值，审核台就能看到正常的 diff。
       * 「社区整理」（titledtext）的包是 `{ sections, reviseOf }`，得用 titledReviseOf 取
       * （notePayload 只认 `{ text, reviseOf }`）—— 否则审核台看不到「这是修订稿」那一条提示。
       */
      const reviseId = (isTitledField(row.field) ? titledReviseOf(value) : '') || notePayload(value).reviseOf;
      const notes: Array<{ text?: string }> = doc?.notes ?? [];
      const ni = reviseId ? findNoteIndex(notes, reviseId) : -1;
      current = ni >= 0 ? (notes[ni].text ?? null) : null;
    } else {
      current = doc?.fields?.[row.field]?.v ?? null;
    }
    out[String(row.id)] = current;
  }

  return json({ ok: true, current: out, docsRead: cache.size });
}

/**
 * POST /api/admin/review
 *   body: { id, action: 'approve'|'reject', rejectNote?, reviewer? }
 *   也接受批量：{ ids: [1,2,3], action: 'approve', reviewer? }
 *
 * ⚠️ 2026-10-05 起「通过」**不再立刻写回仓库**，而是把状态置成 `approved`（攒着），
 * 由 POST /api/admin/flush 一次性写回 —— 一次提交 = 一次 Cloudflare 重建。
 * 以前每条通过都独立提交，攒 20 条就是 20 次重建（免费版每月只有 3000 构建分钟）。
 */
export async function handleAdminReview(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);

  const parsed = await readJsonBody(request, 8192);
  if (!parsed.ok) return parsed.response;
  const b = parsed.body;

  const action = typeof b.action === 'string' ? b.action : '';
  if (action !== 'approve' && action !== 'reject') return fail('action 只能是 approve / reject');

  const reviewerRaw = optString(b.reviewer, 32, '审核人');
  if (!reviewerRaw.ok) return fail(reviewerRaw.error);
  const reviewer = reviewerRaw.value;

  /* 单个 id 与批量 ids 都收：批量只是省几次请求，逻辑完全一样 */
  const ids = Array.isArray(b.ids)
    ? [...new Set(b.ids.map((v: unknown) => Number(v)).filter((n: number) => Number.isInteger(n) && n > 0))]
    : [Number(b.id)];
  if (!ids.length || ids.some((n: number) => !Number.isInteger(n) || n <= 0)) return fail('id 不合法');

  const rejectNoteRaw = action === 'reject' ? optString(b.rejectNote, 300, '驳回理由') : null;
  if (rejectNoteRaw && !rejectNoteRaw.ok) return fail(rejectNoteRaw.error);
  const rejectNote = rejectNoteRaw && rejectNoteRaw.ok ? rejectNoteRaw.value : '';

  const results: Array<{ id: number; ok: boolean; status?: string; error?: string }> = [];

  for (const id of ids) {
    const sub = await env.DB.prepare(`SELECT * FROM submissions WHERE id = ?1`)
      .bind(id)
      .first<SubmissionRow>();
    if (!sub) {
      results.push({ id, ok: false, error: '找不到这条投稿' });
      continue;
    }
    if (sub.status === 'applied') {
      results.push({ id, ok: false, error: '已经写回仓库了' });
      continue;
    }
    if (sub.status === 'rejected') {
      results.push({ id, ok: false, error: '已被驳回' });
      continue;
    }

    /* --- 驳回 --- */
    if (action === 'reject') {
      await env.DB.prepare(
        `UPDATE submissions SET status='rejected', reviewed_at=?1, reviewer=?2, reject_note=?3, error=NULL WHERE id=?4`
      )
        .bind(Date.now(), reviewer, rejectNote, id)
        .run();
      /* 图片被驳回：KV 里的待审图没人会再来看了，直接删掉（R2 里没东西：通过时才落盘） */
      if (sub.field === 'cover' || sub.field === 'gallery') {
        const rejected = parseStoredValue(sub.value);
        const meta = sub.field === 'cover' ? coverMetaOf(rejected) : galleryMetaOf(rejected);
        if (meta) await dropPendingImage(env, meta.key);
      }
      /* 收件箱：登录用户的投稿被驳回时说一声（理由是审核员写的，原样带上） */
      if (sub.user_id) {
        await pushNotification(env, {
          userId: sub.user_id,
          kind: 'review',
          title: `投稿被驳回：《${sub.map_slug}》`,
          body: `字段：${fieldLabel(sub.field)}${rejectNote ? `\n理由：${rejectNote}` : ''}`,
          link: '/account/',
          submissionId: id,
        });
      }
      results.push({ id, ok: true, status: 'rejected' });
      continue;
    }

    /* --- 通过：只入队（攒批），不改仓库 --- */
    if (parseStoredValue(sub.value) === null) {
      results.push({ id, ok: false, error: '这条投稿的值已损坏，无法应用' });
      continue;
    }
    await env.DB.prepare(
      `UPDATE submissions SET status='approved', reviewed_at=?1, reviewer=?2, reject_note=NULL, error=NULL WHERE id=?3`
    )
      .bind(Date.now(), reviewer, id)
      .run();
    /* 收件箱：通过时说一声，并讲清楚「还没上线，等写回」—— 免得他看到页面没变以为没通过 */
    if (sub.user_id) {
      await pushNotification(env, {
        userId: sub.user_id,
        kind: 'review',
        title: `投稿已通过：《${sub.map_slug}》`,
        body: `字段：${fieldLabel(sub.field)}\n已进入「待写回」队列，等站长写回仓库后会上线，届时再通知你一次。`,
        link: '/account/',
        submissionId: id,
      });
    }
    results.push({ id, ok: true, status: 'approved' });
  }

  const staged = await env.DB.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE status='approved'`).first<{ n: number }>();
  return json({
    ok: results.every((r) => r.ok),
    results,
    staged: staged?.n ?? 0,
    message: action === 'approve'
      ? '已攒下。到「待写回」里点一次「写回仓库」才会生效（一次提交 = 一次重建）'
      : '已驳回',
  });
}

/**
 * POST /api/admin/flush  body: { reviewer? }
 *
 * 把「审核通过但还没写回仓库」的投稿（status=approved）**一次性**写回：
 * 不管涉及多少张图、多少条投稿、多少张封面，都只有**一个 commit** —— 于是只触发一次
 * Cloudflare 重建（2026-10-05 之前是一条一次提交一次重建，攒批后省掉大量构建分钟）。
 *
 * 分组顺序：
 *   1. 读出所有 approved 投稿，按地图分组，逐条 applySubmission 到内存里的文档；
 *   2. 封面：从 KV 取待审图 → 作为二进制写进同一个 commit，顺带把同名的其它扩展名删掉，
 *      并在文档里把 cover 记成 **URL**（页面直接当 <img src> 用，绝不能存仓库路径）；
 *   3. 一次提交（worker/community.ts 的 commitFiles，Git Data API）；
 *   4. 提交成功后才改 D1 状态、才清 KV —— 中途失败什么都不动，重试即可。
 */
export async function handleAdminFlush(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);

  const parsed = await readJsonBody(request, 2048);
  if (!parsed.ok) return parsed.response;
  const reviewerRaw = optString(parsed.body.reviewer, 32, '审核人');
  if (!reviewerRaw.ok) return fail(reviewerRaw.error);
  const reviewer = reviewerRaw.value;
  const audit = reviewer ? `，审核 ${reviewer}` : '';

  const { results: allRows } = await env.DB.prepare(
    `SELECT * FROM submissions WHERE status='approved' ORDER BY created_at ASC LIMIT 200`
  ).all<SubmissionRow>();
  if (!allRows?.length) return json({ ok: true, committed: 0, message: '没有待写回的投稿' });

  /* 按地图分组：同一张图的多条投稿合并进同一份文档 */
  const grouped = new Map<string, SubmissionRow[]>();
  for (const row of allRows) {
    const list = grouped.get(row.map_slug) ?? [];
    list.push(row);
    grouped.set(row.map_slug, list);
  }

  /*
   * 一批最多写这么多张图：Workers 免费版一次调用只有 50 个子请求，
   * 而每张图至少一次目录/文件读取、每个封面图一次 blob 上传，最后还有 tree/commit/ref 三次。
   * 攒批攒得越多越容易撞上限（线上真的撞过：HTTP 500 Too many subrequests）。
   * 超出的部分留在「待写回」，审核台会自动再发一次请求继续写 —— 每批一个 commit。
   *
   * 图片集投稿另有 GALLERY_PER_FLUSH 张的额度：每张要读一次 KV、写一次 R2、还要多读一份
   * 清单，比文本投稿贵，所以单独限；额度用完的那几条状态不变，下一轮接着写。
   */
  const MAX_MAPS = 6;
  const picked = [...grouped.entries()].slice(0, MAX_MAPS);
  const rows = picked.flatMap(([, list]) => list);
  let remainingRows = allRows.length - rows.length;
  const remainingMaps = grouped.size - picked.length;

  const skipped: Array<{ id: number; reason: string }> = [];
  const files: CommitFile[] = [];
  const pendingImages: Array<{ id: number; key: string }> = [];
  const authors = new Set<string>();
  const fieldSummary = new Set<string>();
  /* 本批「轮不上写」的图片集投稿（额度用完），下一轮自动接着写 —— 不算失败 */
  const deferred: number[] = [];
  let galleryBudget = GALLERY_PER_FLUSH;

  try {
    /* 一次把所有要改的社区文档读回来（1 个子请求，而不是每张图一个） */
    const docs = await readCommunityDocs(env, picked.map(([slug]) => slug));

    /*
     * 图片集清单：只读本批**真的有图片投稿**的那几张图（通常 0~2 张，1 个子请求/张）。
     * 清单不在社区文档那套模型里，所以单独读；读到就整批带在内存里改，
     * 提交成功后随社区文档一起进同一个 commit。
     */
    const galleryDocs = new Map<string, { manifest: GalleryManifest; dirty: boolean }>();
    for (const slug of new Set(rows.filter((r) => r.field === 'gallery').map((r) => r.map_slug))) {
      const text = await readRepoText(env, galleryManifestPath(slug));
      galleryDocs.set(slug, { manifest: parseManifest(text, slug), dirty: false });
    }

    /* 本批有封面投稿时，先列一次封面目录（1 个子请求）—— 用来判断哪些扩展名真的存在，
       不存在的路径不能出现在删除条目里（见下面删旧扩展名处的说明）。
       列目录失败就当成「一个都没有」：宁可留下一个用不上的旧扩展名文件，
       也不能让整批写回因为一个幽灵删除而失败。 */
    const existingCovers = new Set<string>();
    if (rows.some((r) => r.field === 'cover')) {
      try {
        for (const e of await listRepoDir(env, COVER_DIR)) existingCovers.add(e.name.toLowerCase());
      } catch {
        /* 忽略：existingCovers 留空 */
      }
    }

    for (const [slug, list] of picked) {
      const { doc } = docs.get(slug) ?? (await readCommunityDoc(env, slug));
      let touched = false;

      for (const row of list) {
        const value = parseStoredValue(row.value);
        if (value === null) {
          skipped.push({ id: row.id, reason: '投稿的值已损坏' });
          continue;
        }

        /*
         * 图片集：**图片进 R2，不进 git**（见 worker/gallery.ts 的说明），
         * 仓库里只改那份几百字节的清单 —— 和社区文档同一个 commit、同一次重建。
         * 注意这里不碰社区文档：清单是独立文件，所以不设 touched。
         */
        if (row.field === 'gallery') {
          const gal = galleryDocs.get(slug);
          if (!gal) {
            skipped.push({ id: row.id, reason: '这张图的图片集清单没有读到，稍后重试' });
            continue;
          }
          if (galleryBudget <= 0) {
            /* 额度用完：状态保持 approved，下一轮（审核台会自动再发一次）接着写 */
            deferred.push(row.id);
            continue;
          }
          /* 一张图的图片集有上限：超了就留在待写回并说明原因（审核员可以驳回或删掉几张） */
          if (gal.manifest.images.filter((i) => i.kind === 'user').length >= GALLERY_PER_MAP_MAX) {
            skipped.push({
              id: row.id,
              reason: `这张图的图片集已经有 ${GALLERY_PER_MAP_MAX} 张玩家投稿，写不进去了`,
            });
            continue;
          }
          const meta = galleryMetaOf(value);
          /*
           * 作者申请删除图片集里的某一张（2026-10-19 站长要求）：
           * 审核通过后**真删** —— 清单里去掉那一条，R2 对象也删掉（站长明确说「真没了也无所谓」）。
           * 用文件名 `u<投稿id>.<ext>` 反查是哪一条投稿，所以不会误删别人或工坊预览图。
           */
          if (Number(row.delete_request ?? 0) === 1) {
            const targetId = Number(row.revise_of ?? 0);
            const keep: GalleryEntry[] = [];
            const removed: string[] = [];
            for (const im of gal.manifest.images) {
              const file = decodeURIComponent(String(im.src).split('/').pop() ?? '');
              const m = /^u(\d+)\./i.exec(file);
              if (im.kind === 'user' && m && Number(m[1]) === targetId) {
                removed.push(file);
                continue;
              }
              keep.push(im);
            }
            if (!removed.length) {
              skipped.push({ id: row.id, reason: '图片集里找不到这条投稿的图片（可能已经删过）' });
              continue;
            }
            gal.manifest = { ...gal.manifest, images: keep, count: keep.length };
            gal.dirty = true;
            /* R2 删除失败不阻塞写回：清单已经不再引用它，最坏留下一张孤儿图（下一轮人工清） */
            for (const name of removed) {
              try {
                await env.TERR?.delete(galleryObjectKey(slug, name));
              } catch (err) {
                console.error(`删除 R2 图片失败 ${slug}/${name}：` + (err instanceof Error ? err.message : String(err)));
              }
            }
            fieldSummary.add(`${slug} 图片集 -${removed.length}`);
            if (row.submitter) authors.add(row.submitter);
            continue;
          }
          if (!meta) {
            skipped.push({ id: row.id, reason: '缺少图片信息' });
            continue;
          }
          const pending = await readPendingImage(env, meta.key);
          if (!pending) {
            skipped.push({ id: row.id, reason: 'KV 里的待审图片已不在（让投稿人重新上传）' });
            continue;
          }
          const check = checkGalleryBytes(pending.bytes);
          if (!check.ok || !check.format) {
            skipped.push({ id: row.id, reason: `待审图片校验未通过：${check.error ?? '未知'}` });
            continue;
          }
          const name = galleryEntryName(row.id, check.format);
          try {
            /* 先落 R2 再改清单：清单绝不能指向一张并不存在的图 */
            await putGalleryImage(env, slug, name, pending.bytes, check.format);
          } catch (err) {
            skipped.push({
              id: row.id,
              reason: `写入图片存储失败：${err instanceof Error ? err.message : String(err)}`,
            });
            continue;
          }
          galleryBudget--;
          const entry: GalleryEntry = {
            src: galleryEntryUrl(slug, name),
            kind: 'user',
            caption: meta.caption || '玩家截图',
          };
          if (row.submitter) entry.by = row.submitter;
          gal.manifest = withImages(gal.manifest, [entry]);
          gal.dirty = true;
          pendingImages.push({ id: row.id, key: meta.key });
          fieldSummary.add(`${slug} 图片集`);
          if (row.submitter) authors.add(row.submitter);
          continue;
        }

        /* 封面：图片进同一个 commit，文档里只记 URL */
        if (row.field === 'cover') {
          const meta = coverMetaOf(value);
          if (!meta) {
            skipped.push({ id: row.id, reason: '缺少图片信息' });
            continue;
          }
          const pending = await readPendingImage(env, meta.key);
          if (!pending) {
            skipped.push({ id: row.id, reason: 'KV 里的待审图片已不在（让投稿人重新上传）' });
            continue;
          }
          const check = checkCoverBytes(pending.bytes);
          if (!check.ok || !check.format) {
            skipped.push({ id: row.id, reason: `待审图片校验未通过：${check.error ?? '未知'}` });
            continue;
          }
          let bin = '';
          const CHUNK = 0x8000;
          for (let i = 0; i < pending.bytes.length; i += CHUNK) {
            bin += String.fromCharCode(...pending.bytes.subarray(i, i + CHUNK));
          }
          files.push({ path: coverRepoPath(slug, check.format), base64: btoa(bin) });
          /* ⚠️ 只删**确实存在**的其它扩展名。
             GitHub 的 Git Data API 对「删除一个并不存在的路径」会整单失败：
             422 GitRPC::BadObjectState（2026-10-06 线上实遇，整个写回 500/409）。
             以前这里无条件塞 3 个（webp/png/jpg/jpeg 里除当前格式外的），
             而绝大多数地图只有一个扩展名的文件 —— 于是只有带封面的那批会炸。 */
          for (const ext of COVER_EXTS) {
            if (ext === check.format) continue;
            if (!existingCovers.has(`${slug}.${ext}`.toLowerCase())) continue;
            files.push({ path: coverRepoPath(slug, ext), remove: true });
          }
          pendingImages.push({ id: row.id, key: meta.key });
          applySubmission(doc, {
            id: row.id,
            field: 'cover',
            value: coverUrl(slug, check.format),
            submitter: row.submitter,
            reviewedAt: row.reviewed_at ?? Date.now(),
          });
          touched = true;
        } else if (isTitledField(row.field)) {
          /*
           * 社区整理（2026-10-15 支持一次多节）：`{ sections: [{title, text}, …] }`
           * 拆成 N 条 note 逐节落进社区文档；修订（reviseOf）只对**单节**投稿有意义 ——
           * 多节的一次投递按新增处理（审核台看到的就是「新增 N 节」）。
           */
          const secs = titledSections(value);
          const reviseId = titledReviseOf(value);
          let first = true;
          for (const [i, sec] of secs.entries()) {
            const change = applySubmission(doc, {
              id: row.id,
              field: row.field,
              value: sec.text,
              title: sec.title,
              /* 修订只带第一条（页面上点「修订这条」时也只带一节） */
              reviseOf: first && secs.length === 1 ? reviseId : '',
              /* 多节投稿：每节记个节号，note id 才是唯一的（否则「修订这条」会改错节，
                  见 shared/community-doc.mjs 的 notePublicId） */
              part: secs.length > 1 ? i + 1 : 0,
              submitter: row.submitter,
              reviewedAt: row.reviewed_at ?? Date.now(),
            });
            first = false;
            fieldSummary.add(`${slug} 社区整理（${sec.title}）`);
            touched = true;
            void change;
          }
          if (secs.length > 1) fieldSummary.add(`${slug} 社区整理共 ${secs.length} 节`);
        } else {
          /* note 字段的修订包（{ text, reviseOf }）与「社区整理」的 { title, text } 都在这里拆开；
             普通投稿 notePayload 直接返回原文，所以几条路径共用一句 —— 拆包规则只有 shared 那一份。 */
          const payload = isNoteField(row.field) ? notePayload(value) : null;
          /*
           * 作者申请删除（2026-10-19）：delete_request=1 的行不按普通内容写回，
           * 交给 applySubmission 的 remove 分支：note 按 reviseOf 删、神器按行名删、
           * 其它字段移除社区覆盖。
           */
          const isRemove = Number(row.delete_request ?? 0) === 1;
          const change = applySubmission(doc, {
            id: row.id,
            field: row.field,
            value: payload ? payload.text : value,
            reviseOf: isRemove ? String(row.revise_of ?? '') : payload?.reviseOf ?? '',
            remove: isRemove,
            ...(payload?.title ? { title: payload.title } : {}),
            submitter: row.submitter,
            reviewedAt: row.reviewed_at ?? Date.now(),
          });
          const label = isItemField(change.field) ? `${slug} 神器/道具` : `${slug} ${change.field}`;
          fieldSummary.add(change.revised ? `${label} 修订` : label);
          touched = true;
        }
        if (row.submitter) authors.add(row.submitter);
      }

      if (touched) {
        touch(doc);
        files.push({ path: communityPath(slug), text: JSON.stringify(doc, null, 2) + '\n' });
      }
      const gal = galleryDocs.get(slug);
      if (gal?.dirty) files.push({ path: galleryManifestPath(slug), text: serializeManifest(gal.manifest) });
    }

    const committedIds = rows.filter((r) => !skipped.some((s) => s.id === r.id) && !deferred.includes(r.id));
    /* 额度用完、还没轮上写的也算「还没写完」：审核台会接着再发一次请求 */
    remainingRows += deferred.length;
    if (!committedIds.length) {
      await markErrors(env, skipped);
      /* 全是「额度用完、还没轮到写」的：状态没变，让审核台接着再发一次，别报成失败 */
      if (deferred.length) {
        return json({
          ok: true,
          committed: 0,
          skipped,
          files: 0,
          remaining: remainingRows,
          remainingMaps: 0,
          note: `一次最多写 ${GALLERY_PER_FLUSH} 张图片集图片，还有 ${remainingRows} 条待写回，正在继续…`,
        });
      }
      return json({ ok: false, committed: 0, skipped, message: '没有可写回的投稿，见 skipped 原因' }, 409);
    }

    const who = authors.size ? [...authors].slice(0, 3).join('、') : '匿名';
    const summary = fieldSummary.size > 4
      ? `${[...fieldSummary].slice(0, 4).join('、')} 等 ${fieldSummary.size} 项`
      : [...fieldSummary].join('、');
    const message = `社区投稿：${picked.length} 张图 · ${committedIds.length} 条（${summary}）（by ${who}${audit}）`;

    const { sha: commitSha, files: fileCount } = await commitFilesWithFallback(env, files, message);

    /* 提交成功后才动 D1 与 KV */
    const now = Date.now();
    for (const row of committedIds) {
      await env.DB.prepare(
        `UPDATE submissions SET status='applied', commit_sha=?1, error=NULL WHERE id=?2`
      )
        .bind(commitSha, row.id)
        .run();
    }
    /*
     * 这批写回里的账号，顺手把等级统计刷新一遍（`/api/me` 与登录时也会刷）。
     * 不刷也不会错，只是「免审资格」要等他自己打开一次个人页才算数 —— 顺手做了更顺。
     */
    for (const userId of new Set(committedIds.map((r) => r.user_id).filter((x): x is number => Number.isInteger(x)))) {
      await recalcUserStats(env, userId).catch(() => undefined);
    }
    /*
     * 收件箱：写回上线通知。**按「人 + 图」聚合成一条** —— 一次攒批可能同时写回某人的
     * 十几条投稿（同一张图好几个字段），一条一发会刷屏，聚合后正好一句「你在《x》的 N 条已上线」。
     */
    const byUserMap = new Map<string, { userId: number; slug: string; fields: string[] }>();
    for (const row of committedIds) {
      if (!Number.isInteger(row.user_id)) continue;
      const key = `${row.user_id}|${row.map_slug}`;
      const hit = byUserMap.get(key) ?? { userId: row.user_id as number, slug: row.map_slug, fields: [] };
      hit.fields.push(fieldLabel(row.field));
      byUserMap.set(key, hit);
    }
    if (byUserMap.size) {
      await pushNotifications(
        env,
        [...byUserMap.values()].map((g) => ({
          userId: g.userId,
          kind: 'flush' as const,
          title: `投稿已上线：《${g.slug}》`,
          body:
            `你在《${g.slug}》的 ${g.fields.length} 条投稿已写回仓库（${[...new Set(g.fields)].join('、')}）。` +
            `构建大约 1~2 分钟后生效：https://ze-map.cn/maps/${g.slug}/`,
          link: `/maps/${g.slug}/`,
        }))
      );
    }
    for (const c of pendingImages) await dropPendingImage(env, c.key);
    await markErrors(env, skipped);

    return json({
      ok: true,
      committed: committedIds.length,
      maps: picked.length,
      files: fileCount,
      commit: commitSha,
      skipped,
      /* 本批里额度用完、还没轮到写的图片集投稿（状态没变） */
      deferred: deferred.length,
      /* 还没写完的（这一批之外的）：审核台会接着再发一次请求，每批一个 commit */
      remaining: remainingRows,
      remainingMaps,
      note: remainingRows
        ? `本批已写回 ${committedIds.length} 条（一个 commit），还有 ${remainingRows} 条待写回，正在继续…`
        : '已写回仓库，Cloudflare 会在 1~2 分钟内重建上线（一次提交只重建一次）',
      _now: now,
    });
  } catch (err) {
    const e = err as GitError;
    const text = e?.message || String(err);
    /* 失败时**不改状态**：投稿仍在「待写回」里，修好（比如换 token）再点一次即可 */
    await markErrors(env, [{ id: 0, reason: text.slice(0, 280) }]);
    return fail(text, typeof e?.status === 'number' ? e.status : 500);
  }
}

/**
 * 写回仓库：优先「一个 commit 装完一批」（Git Data API），失败再退化成逐文件写。
 *
 * 为什么要兜底：线上遇到过 Git Data API 返回
 * `创建目录树失败（HTTP 422）：GitRPC::BadObjectState` —— 整批写回直接卡住，
 * 审核员只能反复点。逐文件写慢、会多几次构建，但内容一定落地；
 * 而且每批最多 6 张图，子请求数仍然安全（见 handleAdminFlush 的 MAX_MAPS）。
 */
async function commitFilesWithFallback(
  env: Env,
  files: CommitFile[],
  message: string
): Promise<{ sha: string; files: number }> {
  try {
    return await commitFiles(env, files, message);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    console.warn('Git Data API 写回失败，改用逐文件写：' + text);
    try {
      const r = await commitFilesViaContents(env, files, `${message}（Git Data API 失败，逐文件提交）`);
      await markErrors(env, [{ id: 0, reason: `上一次批量提交失败（${text.slice(0, 120)}），已改用逐文件提交成功` }]);
      return r;
    } catch (err2) {
      /* 两种都失败：把两次原因都带上，审核台能看到全貌 */
      throw new GitError(
        `${text}；改用逐文件写也失败：${err2 instanceof Error ? err2.message : String(err2)}`,
        502
      );
    }
  }
}

/** 把「这条为什么没写回」记进 D1，审核台能直接看到（id=0 表示整体失败） */async function markErrors(env: Env, skipped: Array<{ id: number; reason: string }>): Promise<void> {
  for (const s of skipped) {
    if (!s.id) continue;
    await env.DB.prepare(`UPDATE submissions SET error=?1 WHERE id=?2`)
      .bind(s.reason.slice(0, 300), s.id)
      .run();
  }
}

/** POST /api/admin/unstage  body: {id} —— 把「待写回」的投稿退回待审（改主意时用） */
export async function handleAdminUnstage(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  const parsed = await readJsonBody(request, 1024);
  if (!parsed.ok) return parsed.response;
  const id = Number(parsed.body.id);
  if (!Number.isInteger(id) || id <= 0) return fail('id 不合法');

  const sub = await env.DB.prepare(`SELECT status FROM submissions WHERE id=?1`)
    .bind(id)
    .first<{ status: string }>();
  if (!sub) return fail('找不到这条投稿', 404);
  if (sub.status !== 'approved') return fail('只有「待写回」的投稿可以撤回', 409);

  await env.DB.prepare(
    `UPDATE submissions SET status='pending', reviewed_at=NULL, reviewer=NULL, error=NULL WHERE id=?1`
  )
    .bind(id)
    .run();
  return json({ ok: true, id, status: 'pending' });
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
