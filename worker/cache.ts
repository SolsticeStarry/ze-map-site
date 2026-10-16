/**
 * 边缘缓存（Workers Cache API）的薄封装 —— 2026-10-16 加。
 *
 * 只服务两处「所有访客算出来的结果都一样、且不需要实时」的活：
 *   · `/api/stats` 的票数聚合（按 IP 的 myVote **不进缓存**，仍逐次查）
 *   · `/api/video-meta` 的整份响应 —— 包括**回源失败的负结果**，那正是最贵的一种：
 *     索引里没有的新视频每次访问都要去问 B 站，国内实测 0.5~1.2 秒，还可能撞风控
 *
 * 实现走的 `caches.default`：命中就省掉 D1 / R2 / 回源。三条注意：
 *   1. **过期时间自己算**：条目里带写入时间 `at`，读出来比一下 TTL ——
 *      不去猜平台怎么解释 max-age，行为在任何环境里都一致。
 *   2. **测试环境没有 caches.default**（Node 里跑单测）：整个封装退化成「永远 miss」，
 *      逻辑与加缓存之前一模一样，所以单测不需要为它准备什么。
 *   3. **写失败不能影响正事**：所有 cache 操作都 try/catch —— 缓存坏了只是变慢，不该 500。
 *
 * 键名用自家的假域名 `edge-cache.ze-map.internal`：Cache API 的键就是一条 URL，
 * 跟真实路由无关，这样也不会和任何真实请求撞键。
 */

const PREFIX = 'https://edge-cache.ze-map.internal/';

/** 拿到默认缓存；没有（测试/受限环境）返回 null */
function store(): Cache | null {
  try {
    const c = (globalThis as { caches?: { default?: Cache } }).caches;
    return c && c.default ? c.default : null;
  } catch {
    return null;
  }
}

/** 缓存键：不允许出现别的字符，省得把查询串拼出歧义 */
export function cacheKey(name: string): string {
  return PREFIX + name;
}

/**
 * 读一条缓存。`ttlSec` 之内才算命中（不传就只看条目里记的时间戳，永远算命中）。
 * @returns 命中时返回当初存进去的值，否则 null
 */
export async function cacheGet<T>(name: string, ttlSec: number): Promise<T | null> {
  const c = store();
  if (!c) return null;
  try {
    const hit = await c.match(cacheKey(name));
    if (!hit) return null;
    const raw = (await hit.json()) as { at?: number; data?: T };
    if (typeof raw?.at !== 'number') return null;
    if (ttlSec > 0 && Date.now() - raw.at > ttlSec * 1000) return null;
    return (raw.data ?? null) as T | null;
  } catch {
    return null;
  }
}

/** 写一条缓存。ttlSec 只用来给平台一个提示（真正判过期的是 cacheGet 里的时间戳比较）。 */
export async function cachePut(name: string, data: unknown, ttlSec: number): Promise<void> {
  const c = store();
  if (!c) return;
  try {
    await c.put(
      cacheKey(name),
      new Response(JSON.stringify({ at: Date.now(), data }), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': `public, max-age=${Math.max(1, Math.floor(ttlSec))}`,
        },
      })
    );
  } catch (err) {
    console.error('cachePut 失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

/** 删一条缓存（投票后要把聚合作废，免得投票人自己看到旧票数）。失败不影响正事。 */
export async function cacheDelete(name: string): Promise<void> {
  const c = store();
  if (!c) return;
  try {
    await c.delete(cacheKey(name));
  } catch (err) {
    console.error('cacheDelete 失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

/**
 * 「取缓存 → 没有就算一遍 → 写回去」的常用套路。
 * @param compute 只在未命中时调用（所以里面的 D1 / R2 / 回源都省下来了）
 */
export async function cacheWrap<T>(name: string, ttlSec: number, compute: () => Promise<T>): Promise<T> {
  const hit = await cacheGet<T>(name, ttlSec);
  if (hit !== null) return hit;
  const fresh = await compute();
  await cachePut(name, fresh, ttlSec);
  return fresh;
}
