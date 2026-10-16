/**
 * 难度投票（P1）—— 从 index.ts 拆出来，逻辑没变。
 */

import { DIFFICULTIES, isDifficulty, normalizeDifficulty } from '../shared/difficulty.mjs';
import { cacheDelete, cacheWrap } from './cache';
import { allowWrite, fail, json, readJsonBody, type Env } from './http';

/** 地图 slug 形如 ze_flowering —— 与 src/content/maps/*.mdx 的文件名一致 */
export const SLUG_RE = /^[a-z0-9][a-z0-9_]{0,63}$/;

/** 每个 IP 每小时最多写多少次（投票 + 改票都算） */
const WRITE_LIMIT_PER_HOUR = 30;

/**
 * 聚合票数在边缘缓存多少秒（2026-10-16 加）。
 * 为什么是这个量级：投票分布晚十几秒更新，除了刚投完票的本人**没人会察觉**；
 * 而本人那一票走的是「POST /api/vote 的返回」与**逐次查的 myVote**，永远是新的。
 * 换来的是每次 GET 少一次 D1 聚合查询（实测国内 ~550 ms → 命中缓存后只剩网络往返）。
 */
const COUNTS_TTL_S = 20;

export interface Stats {
  total: number;
  counts: Record<string, number>;
  myVote: string | null;
}

/** 票数聚合（所有人一样，可缓存） */
async function readCounts(env: Env, slug: string): Promise<{ total: number; counts: Record<string, number> }> {
  const { results } = await env.DB.prepare(
    `SELECT value, COUNT(*) AS n FROM difficulty_votes WHERE map_slug = ?1 GROUP BY value`
  )
    .bind(slug)
    .all<{ value: string; n: number }>();

  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of results ?? []) {
    /*
     * 历史票可能是改名之前的旧称（中等 / 极难 / 地狱）。
     * 归一后再统计 —— 否则它们会被算进总票数，却不出现在任何一个按钮上，
     * 页面上就会出现「共 8 票」但各按钮加起来只有 6 票的怪现象。
     * 用 += 而不是 = ：万一新旧称同时存在，要合并到同一个键。
     */
    const key = normalizeDifficulty(row.value);
    counts[key] = (counts[key] ?? 0) + row.n;
    total += row.n;
  }
  return { total, counts };
}

export async function readStats(env: Env, slug: string, ipHash: string): Promise<Stats> {
  /* 聚合走缓存、myVote 每次现查：投完票自己立刻能看到，别人最多晚 20 秒 */
  const [agg, mine] = await Promise.all([
    cacheWrap(`stats?map=${slug}`, COUNTS_TTL_S, () => readCounts(env, slug)),
    env.DB.prepare(`SELECT value FROM difficulty_votes WHERE map_slug = ?1 AND ip_hash = ?2`)
      .bind(slug, ipHash)
      .first<{ value: string }>(),
  ]);

  return { total: agg.total, counts: agg.counts, myVote: mine?.value ? normalizeDifficulty(mine.value) : null };
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

  /*
   * 投完票把聚合缓存作废（2026-10-16）：不然投票人自己会看到「我投了但分布没动」——
   * 下面这次 readStats 会顺手把新的聚合算好再写回缓存，所以只多一次查询，别人也立刻看到。
   */
  await cacheDelete(`stats?map=${slug}`);

  return json({ ok: true, map: slug, ...(await readStats(env, slug, ipHash)) });
}
