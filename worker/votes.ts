/**
 * 难度投票（P1）—— 从 index.ts 拆出来，逻辑没变。
 */

import { DIFFICULTIES, isDifficulty } from '../shared/difficulty.mjs';
import { allowWrite, fail, json, readJsonBody, type Env } from './http';

/** 地图 slug 形如 ze_flowering —— 与 src/content/maps/*.mdx 的文件名一致 */
export const SLUG_RE = /^[a-z0-9][a-z0-9_]{0,63}$/;

/** 每个 IP 每小时最多写多少次（投票 + 改票都算） */
const WRITE_LIMIT_PER_HOUR = 30;

export interface Stats {
  total: number;
  counts: Record<string, number>;
  myVote: string | null;
}

export async function readStats(env: Env, slug: string, ipHash: string): Promise<Stats> {
  const { results } = await env.DB.prepare(
    `SELECT value, COUNT(*) AS n FROM difficulty_votes WHERE map_slug = ?1 GROUP BY value`
  )
    .bind(slug)
    .all<{ value: string; n: number }>();

  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of results ?? []) {
    counts[row.value] = row.n;
    total += row.n;
  }

  const mine = await env.DB.prepare(
    `SELECT value FROM difficulty_votes WHERE map_slug = ?1 AND ip_hash = ?2`
  )
    .bind(slug, ipHash)
    .first<{ value: string }>();

  return { total, counts, myVote: mine?.value ?? null };
}

/** GET /api/stats?map=<slug> */
export async function handleStats(
  request: Request,
  env: Env,
  url: URL,
  ipHash: string
): Promise<Response> {
  if (request.method !== 'GET') return fail('只支持 GET', 405);
  const slug = url.searchParams.get('map') ?? '';
  if (!SLUG_RE.test(slug)) return fail('地图参数不合法');
  return json({ ok: true, map: slug, ...(await readStats(env, slug, ipHash)) });
}

/** POST /api/vote  body: {map, value} */
export async function handleVote(
  request: Request,
  env: Env,
  ipHash: string
): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);

  const parsed = await readJsonBody(request, 2048);
  if (!parsed.ok) return parsed.response;

  const slug = typeof parsed.body.map === 'string' ? parsed.body.map : '';
  const value = typeof parsed.body.value === 'string' ? parsed.body.value : '';

  if (!SLUG_RE.test(slug)) return fail('地图参数不合法');
  // 关键：难度必须在共享枚举内，否则脏数据会一路流进构建期 schema
  if (!isDifficulty(value)) return fail(`难度必须是：${DIFFICULTIES.join(' / ')}`);

  if (!(await allowWrite(env, ipHash, 'vote', WRITE_LIMIT_PER_HOUR))) {
    return fail('操作太频繁了，请过一会儿再试', 429);
  }

  await env.DB.prepare(
    `INSERT INTO difficulty_votes (map_slug, value, ip_hash, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(map_slug, ip_hash) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`
  )
    .bind(slug, value, ipHash, Date.now())
    .run();

  return json({ ok: true, map: slug, ...(await readStats(env, slug, ipHash)) });
}
