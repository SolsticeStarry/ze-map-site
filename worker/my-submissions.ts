/**
 * 「改自己的投稿 / 撤回自己的投稿」（2026-10-19 站长要求）
 *
 * 背景：投稿投出去之后，作者自己发现写错了却改不了 —— 只能再投一条或者找站长，
 * 审核队列里也不干净。这里给登录用户两个自助操作：
 *   POST /api/my-submission/edit      { id, value?, note? }
 *   POST /api/my-submission/withdraw  { id }
 *
 * 规则（故意的保守）：
 *   · 只能动**自己的**投稿（user_id 必须等于登录用户）；匿名投稿没有归属，改不了；
 *   · 只有 `pending` / `rejected` 能改或撤回 —— 已经写回仓库（applied）的内容不能在这里改，
 *     那要走「修订」流程重新审核，否则等于绕过审核直接改已发布的页面；
 *   · 改完状态回到 `pending`、清掉驳回理由，重新排队；
 *   · 撤回是软删除：status='withdrawn'，行还在（保留审计），审核台不再看到它。
 */
import type { Env } from './index';
import { fail, json, readJsonBody } from './http';
import { getSessionUser } from './auth';
import { FIELD_RULES, isField, validateValue } from '../shared/submission-fields.mjs';

const EDITABLE = new Set(['pending', 'rejected']);

interface Row {
  id: number;
  user_id: number | null;
  map_slug: string;
  field: string;
  value: string;
  note: string | null;
  status: string;
}

async function loadOwn(request: Request, env: Env, id: number): Promise<{ row?: Row; response?: Response }> {
  const me = await getSessionUser(request, env).catch(() => null);
  if (!me) return { response: fail('请先登录', 401) };
  const row = await env.DB.prepare(
    `SELECT id, user_id, map_slug, field, value, note, status FROM submissions WHERE id = ?1`
  )
    .bind(id)
    .first<Row>();
  if (!row) return { response: fail('没有这条投稿', 404) };
  if (row.user_id !== me.id) return { response: fail('只能修改自己的投稿', 403) };
  return { row };
}

/** POST /api/my-submission/withdraw —— { id } */
export async function handleMySubmissionWithdraw(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  const parsed = await readJsonBody(request, 4096);
  if (!parsed.ok) return parsed.response;
  const id = Number((parsed.body as { id?: unknown }).id);
  if (!Number.isInteger(id) || id <= 0) return fail('id 不合法');

  const { row, response } = await loadOwn(request, env, id);
  if (!row) return response!;
  if (!EDITABLE.has(row.status)) {
    return fail(
      row.status === 'applied'
        ? '这条已经写进站里了，不能直接撤回。要改内容请重新投稿（会走审核），要撤下整条请找站长。'
        : '当前状态不能撤回'
    );
  }

  await env.DB.prepare(`UPDATE submissions SET status = 'withdrawn' WHERE id = ?1 AND user_id = ?2`)
    .bind(id, row.user_id)
    .run();
  return json({ ok: true, id, status: 'withdrawn' });
}

/** POST /api/my-submission/edit —— { id, value?, note? } */
export async function handleMySubmissionEdit(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  const parsed = await readJsonBody(request, 16384);
  if (!parsed.ok) return parsed.response;
  const b = parsed.body as { id?: unknown; value?: unknown; note?: unknown };
  const id = Number(b.id);
  if (!Number.isInteger(id) || id <= 0) return fail('id 不合法');

  const { row, response } = await loadOwn(request, env, id);
  if (!row) return response!;
  if (!EDITABLE.has(row.status)) {
    return fail(
      row.status === 'applied'
        ? '这条已经写进站里了，不能再直接改。请重新投一次（会重新审核），或联系站长。'
        : '当前状态不能修改'
    );
  }
  if (!isField(row.field)) return fail('这条投稿的字段已经不在支持范围内，请联系站长');

  /* value 不传就沿用原来的（只改理由的场合） */
  const nextRaw = b.value === undefined ? JSON.parse(row.value) : b.value;
  const checked = validateValue(row.field, nextRaw);
  if (!checked.ok) return fail(`没通过校验：${checked.error}`);

  const note =
    typeof b.note === 'string'
      ? b.note.trim().slice(0, 200)
      : (row.note ?? '');

  await env.DB.prepare(
    `UPDATE submissions
        SET value = ?1, note = ?2, status = 'pending', reject_note = NULL, reviewed_at = NULL
      WHERE id = ?3 AND user_id = ?4`
  )
    .bind(JSON.stringify(checked.value), note || null, id, row.user_id)
    .run();

  return json({
    ok: true,
    id,
    status: 'pending',
    field: row.field,
    label: FIELD_RULES[row.field]?.label ?? row.field,
  });
}
