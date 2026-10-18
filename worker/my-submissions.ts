/**
 * 「改自己的投稿 / 撤回自己的投稿」（2026-10-19 站长要求，10-19 夜补已上线内容的修订）
 *
 * 背景：投稿投出去之后，作者自己发现写错了却改不了 —— 只能再投一条或者找站长，
 * 审核队列里也不干净。这里给登录用户两个自助操作：
 *   POST /api/my-submission/edit      { id, value?, note? }
 *   POST /api/my-submission/withdraw  { id }
 *
 * 两种状态，两种走法：
 *   · **待审核 / 被驳回**：直接改原来那一行、清掉驳回理由、重新排队（不产生新行）；
 *   · **已上线（applied）**：不直接改线上内容（那等于绕过审核），而是**插一条待审的修订行**：
 *       改内容 → revise_of=原 id，审核通过后替换原内容；
 *       要删除 → delete_request=1，审核通过后由写回逻辑把这条内容从社区文件里移除。
 *     审核台会把它们标成「作者修订 #123 / 作者申请删除 #123」，管理员只需点通过。
 *
 * 其余规则：只能动**自己的**投稿；匿名投稿没有归属，改不了。
 */
import type { Env } from './index';
import { fail, json, readJsonBody } from './http';
import { getSessionUser } from './auth';
import { FIELD_RULES, isField, validateValue } from '../shared/submission-fields.mjs';
import { isNoteField, isTitledField } from '../shared/community-doc.mjs';

const EDITABLE = new Set(['pending', 'rejected']);

interface Row {
  id: number;
  user_id: number | null;
  map_slug: string;
  field: string;
  value: string;
  note: string | null;
  ip_hash: string;
  submitter: string | null;
  status: string;
}

async function loadOwn(
  request: Request,
  env: Env,
  id: number
): Promise<{ row?: Row; me?: { id: number; name: string }; response?: Response }> {
  const me = await getSessionUser(request, env).catch(() => null);
  if (!me) return { response: fail('请先登录', 401) };
  const row = await env.DB.prepare(
    `SELECT id, user_id, map_slug, field, value, note, ip_hash, submitter, status
       FROM submissions WHERE id = ?1`
  )
    .bind(id)
    .first<Row>();
  if (!row) return { response: fail('没有这条投稿', 404) };
  if (row.user_id !== me.id) return { response: fail('只能修改自己的投稿', 403) };
  return { row, me: { id: me.id, name: me.name } };
}

/** 以「新的待审行」形式提交一次作者操作（修订或删除申请） */
async function queueAuthorAction(
  env: Env,
  row: Row,
  me: { id: number; name: string },
  opts: { value: unknown; note: string; deleteRequest?: boolean }
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO submissions
       (map_slug, field, value, note, submitter, contact, ip_hash, status, created_at, user_id, revise_of, delete_request)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, 'pending', ?7, ?8, ?9, ?10)`
  )
    .bind(
      row.map_slug,
      row.field,
      JSON.stringify(opts.value),
      opts.note,
      me.name,
      row.ip_hash,
      Date.now(),
      me.id,
      row.id,
      opts.deleteRequest ? 1 : 0
    )
    .run();
  return Number(res.meta?.last_row_id ?? 0);
}

/** POST /api/my-submission/withdraw —— { id }（待审：撤回；已上线：申请删除） */
export async function handleMySubmissionWithdraw(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  const parsed = await readJsonBody(request, 4096);
  if (!parsed.ok) return parsed.response;
  const id = Number((parsed.body as { id?: unknown }).id);
  if (!Number.isInteger(id) || id <= 0) return fail('id 不合法');

  const { row, me, response } = await loadOwn(request, env, id);
  if (!row || !me) return response!;

  if (row.status === 'pending' || row.status === 'rejected') {
    await env.DB.prepare(`UPDATE submissions SET status = 'withdrawn' WHERE id = ?1 AND user_id = ?2`)
      .bind(id, me.id)
      .run();
    return json({ ok: true, id, status: 'withdrawn', mode: 'withdrawn' });
  }

  if (row.status === 'applied') {
    if (row.field === 'cover') {
      return fail('封面请找站长处理（删封面要回退到工坊预览图，属于另一条流程）');
    }
    /*
     * 图片集：只删自己投的那一张。写回时按 revise_of（原投稿 id）去清单里找
     * 文件名 `u<id>.<ext>` 的那一条，所以这里不需要额外指定图片。
     */
    const originalValue = (() => {
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    })();
    const newId = await queueAuthorAction(env, row, me, {
      value: originalValue,
      note: `作者申请删除原投稿 #${row.id}`,
      deleteRequest: true,
    });
    return json({
      ok: true,
      id: newId,
      status: 'pending',
      mode: 'delete-request',
      message:
        row.field === 'gallery'
          ? '删除申请已提交，审核通过后会从图片集里移除并删掉原图'
          : '删除申请已提交，审核通过后会从条目里移除',
    });
  }

  return fail('当前状态不能撤回');
}

/** POST /api/my-submission/edit —— { id, value?, note? } */
export async function handleMySubmissionEdit(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  const parsed = await readJsonBody(request, 16384);
  if (!parsed.ok) return parsed.response;
  const b = parsed.body as { id?: unknown; value?: unknown; note?: unknown };
  const id = Number(b.id);
  if (!Number.isInteger(id) || id <= 0) return fail('id 不合法');

  const { row, me, response } = await loadOwn(request, env, id);
  if (!row || !me) return response!;
  if (!isField(row.field)) return fail('这条投稿的字段已经不在支持范围内，请联系站长');
  if (row.field === 'cover' || row.field === 'gallery') {
    return fail('封面 / 图片集不支持直接改文字，请重新投稿，或联系站长');
  }

  const nextRaw = b.value === undefined ? JSON.parse(row.value) : b.value;

  /* 已上线：新增一条「修订」待审行（审核通过后替换原内容） */
  if (row.status === 'applied') {
    /*
     * note 类字段要带 reviseOf（写回时按它找到原来那一条替换）；
     * 其它字段是覆盖式的，直接投新值即可 —— 审核通过后自然覆盖。
     */
    if (isNoteField(row.field) && !isTitledField(row.field)) {
      const checked = validateValue(row.field, String(nextRaw ?? ''));
      if (!checked.ok) return fail(`没通过校验：${checked.error}`);
      const newId = await queueAuthorAction(env, row, me, {
        value: { text: checked.value, reviseOf: String(row.id) },
        note: `作者修订原投稿 #${row.id}`,
      });
      return json({ ok: true, id: newId, status: 'pending', mode: 'revision', field: row.field, message: '修订已提交，审核通过后会替换原内容' });
    }
    const checked = validateValue(row.field, nextRaw);
    if (!checked.ok) return fail(`没通过校验：${checked.error}`);
    const newId = await queueAuthorAction(env, row, me, {
      value: checked.value,
      note: `作者修订原投稿 #${row.id}`,
    });
    return json({
      ok: true,
      id: newId,
      status: 'pending',
      mode: 'revision',
      field: row.field,
      label: FIELD_RULES[row.field]?.label ?? row.field,
      message: '修订已提交，审核通过后会替换原内容',
    });
  }

  if (!EDITABLE.has(row.status)) return fail('当前状态不能修改');

  const checked = validateValue(row.field, nextRaw);
  if (!checked.ok) return fail(`没通过校验：${checked.error}`);

  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 200) : (row.note ?? '');

  await env.DB.prepare(
    `UPDATE submissions
        SET value = ?1, note = ?2, status = 'pending', reject_note = NULL, reviewed_at = NULL
      WHERE id = ?3 AND user_id = ?4`
  )
    .bind(JSON.stringify(checked.value), note || null, id, me.id)
    .run();

  return json({
    ok: true,
    id,
    status: 'pending',
    mode: 'in-place',
    field: row.field,
    label: FIELD_RULES[row.field]?.label ?? row.field,
  });
}
