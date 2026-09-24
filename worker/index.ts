/**
 * ze-map-site Worker —— 社区难度投票（P1）
 *
 * 背景：站点原本是**纯静态资源** Worker，一行脚本都没有。本文件是第一个脚本，
 * 只接管 /api/*，其余请求原样交回静态资源（见下方 fallback 注释）。
 *
 * 性能：Cloudflare 官方路由规则是「静态资源优先命中，匹配不到才调用 Worker」。
 * 所以：
 *   1. 808 个静态页面仍然由边缘直接发出，不经过这里，速度不受影响；
 *   2. 就算本文件抛异常，站点本身也照常访问，最坏只是投票接口 500。
 *
 * 依赖：D1 绑定 DB（见 wrangler.jsonc）、可选 secret IP_SALT。
 */

import { DIFFICULTIES, isDifficulty } from '../shared/difficulty.mjs';

/*
 * 只声明本文件真正用到的 D1 接口。
 * 这样不必为了类型引入 @cloudflare/workers-types 依赖（少一个包、少一次 lock 变更）。
 */
interface D1Prepared {
  bind(...values: unknown[]): D1Prepared;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
}
interface D1 {
  prepare(query: string): D1Prepared;
}
interface Env {
  DB: D1;
  /** 只声明用到的部分，避免依赖 workers-types */
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** 用于 IP 哈希的盐，必须用 `wrangler secret put IP_SALT` 设置 */
  IP_SALT?: string;
}

/** 地图 slug 形如 ze_flowering —— 与 src/content/maps/*.mdx 的文件名一致 */
const SLUG_RE = /^[a-z0-9][a-z0-9_]{0,63}$/;
/** 每个 IP 每小时最多写多少次（投票 + 改票都算） */
const WRITE_LIMIT_PER_HOUR = 30;
/** 请求体上限，防大包 */
const MAX_BODY_BYTES = 2048;

/* ===== 小工具 ===== */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function fail(error: string, status = 400): Response {
  return json({ ok: false, error }, status);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  );
}

/** 本地开发（`wrangler dev` 跑在 localhost）时允许缺省 IP_SALT */
function isLocalHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

/** 按小时分桶，如 '2026-09-24T06' */
function hourWindow(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 13);
}

/** 限流：同一 IP 每小时最多 WRITE_LIMIT_PER_HOUR 次写操作 */
async function allowWrite(env: Env, ipHash: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (ip_hash, window, count) VALUES (?1, ?2, 1)
     ON CONFLICT(ip_hash, window) DO UPDATE SET count = count + 1
     RETURNING count`
  )
    .bind(ipHash, hourWindow())
    .first<{ count: number }>();
  return (row?.count ?? 1) <= WRITE_LIMIT_PER_HOUR;
}

/* ===== 业务 ===== */

interface Stats {
  total: number;
  counts: Record<string, number>;
  myVote: string | null;
}

async function readStats(env: Env, slug: string, ipHash: string): Promise<Stats> {
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

/* ===== 入口 ===== */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    /*
     * 只处理 /api/*。
     * 其余（含未命中静态文件时的 404 兜底）一律交回资源绑定，
     * 这样站内 404 页、_headers 规则等行为与加脚本之前完全一致 ——
     * 千万别在这里自己 new Response('Not found')，那会把站内 404 页顶掉。
     */
    if (!path.startsWith('/api/')) {
      if (!env.ASSETS) return new Response('Not Found', { status: 404 });
      return env.ASSETS.fetch(request);
    }

    // 同源检查：挡掉别人页面上的跨站调用（本站不需要被外部站点调用）
    const origin = request.headers.get('origin');
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch {
        return fail('来源不合法', 403);
      }
      if (originHost !== url.host) return fail('跨站请求被拒绝', 403);
    }

    if (!env.DB) return fail('投票服务尚未配置（缺少 D1 绑定）', 503);

    /*
     * IP 盐必须显式配置（线上）。
     * 盐如果是个写在公开仓库里的常量，等于没有盐：别人能拿它暴力枚举整个 IPv4 空间，
     * 把 ip_hash 反查回具体 IP —— 那就变成在收集个人信息了。
     * 所以线上缺 IP_SALT 时直接 503（宁可功能不可用，也不静默降级），只在本地开发放行。
     */
    const salt = env.IP_SALT;
    if (!salt && !isLocalHost(url.host)) {
      return fail('投票服务尚未配置（缺少 IP_SALT 密钥）', 503);
    }

    const ipHash = await sha256Hex(`${salt ?? 'local-dev-only'}:${clientIp(request)}`);

    /* --- 读取统计 --- */
    if (path === '/api/stats') {
      if (request.method !== 'GET') return fail('只支持 GET', 405);
      const slug = url.searchParams.get('map') ?? '';
      if (!SLUG_RE.test(slug)) return fail('地图参数不合法');
      return json({ ok: true, map: slug, ...(await readStats(env, slug, ipHash)) });
    }

    /* --- 投票（含改票） --- */
    if (path === '/api/vote') {
      if (request.method !== 'POST') return fail('只支持 POST', 405);

      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return fail('请求体过大', 413);

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return fail('请求体不是合法 JSON');
      }
      if (typeof parsed !== 'object' || parsed === null) return fail('请求体格式不对');

      const body = parsed as { map?: unknown; value?: unknown };
      const slug = typeof body.map === 'string' ? body.map : '';
      const value = typeof body.value === 'string' ? body.value : '';

      if (!SLUG_RE.test(slug)) return fail('地图参数不合法');
      // 关键：难度必须在共享枚举内，否则脏数据会一路流进构建期 schema
      if (!isDifficulty(value)) return fail(`难度必须是：${DIFFICULTIES.join(' / ')}`);

      if (!(await allowWrite(env, ipHash))) return fail('操作太频繁了，请过一会儿再试', 429);

      await env.DB.prepare(
        `INSERT INTO difficulty_votes (map_slug, value, ip_hash, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(map_slug, ip_hash) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`
      )
        .bind(slug, value, ipHash, Date.now())
        .run();

      return json({ ok: true, map: slug, ...(await readStats(env, slug, ipHash)) });
    }

    return fail('未知接口', 404);
  },
};
