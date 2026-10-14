/**
 * R2 资产的**同源回退**：GET /terr/<工坊ID>.bin 与 GET /terr/gallery/<地图>/<文件>
 *
 * 为什么需要它：
 *   地形分片与图集图片本来只从 R2 自定义域（terr.ze-map.cn）取，那是**另一个域名**。
 *   国内手机网络 / App 内置浏览器里，这个跨域请求可能直接失败（前端只看到
 *   「Failed to fetch」），而站点自己的域名是通的 —— 于是用户在手机上
 *   只能看到「真实碰撞地形加载失败」，把块体一关就一片空（2026-10-05 反馈）。
 *   走同源就没有跨域这回事，也不需要 R2 的 CORS 配置。
 *
 *   2026-10-15 扩到图集图片：地图页的图片集有十几张、每张 ~45 KB，全在那个域上，
 *   而它**只有地形分片有回退** —— 域不通的网络里图片集就是一片裂图。前端给每张图挂了
 *   `onerror`（见 components/MapGallery.astro），失败时换成同源这条。
 *
 * 为什么不是「全部走同源」：Worker 要跑一遍、还占 CPU 时间。
 *   前端仍然优先直连 R2（快、不占 Worker），只有失败时才退到这里。
 *
 * 边缘缓存：用 Cache API 存一年（这些对象都是不可变的：分片路径里带工坊 ID，
 *   图集文件名是投稿时就定下的）。
 */
import { fail, type Env } from './http';

const TERR_RE = /^terr\/\d+\.bin$/;
/**
 * 图集图片的 R2 key：`gallery/<slug>/<文件>`。
 *
 * ⚠️ 注意「路由路径」与「R2 key」不是一回事：前端回退请求的是站点上的
 * `/terr/gallery/<slug>/<文件>`（路由带 `terr/` 前缀），而 R2 桶里存的是 `gallery/<slug>/<文件>`
 * （terr.ze-map.cn 是桶的根）。地形分片恰好两边同名（桶里就是 `terr/<id>.bin`），
 * 所以这里要把前缀剥掉 —— 2026-10-15 第一版就写错了，图集回退一直 400。
 */
const GALLERY_ROUTE_RE = /^terr\/gallery\/([A-Za-z0-9_]+\/[A-Za-z0-9_.-]+\.(?:webp|jpe?g|png))$/i;

function contentTypeOf(path: string): string {
  if (/\.webp$/i.test(path)) return 'image/webp';
  if (/\.png$/i.test(path)) return 'image/png';
  if (/\.jpe?g$/i.test(path)) return 'image/jpeg';
  return 'application/octet-stream';
}

export async function handleTerr(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail('只支持 GET', 405);

  const path = new URL(request.url).pathname.replace(/^\/+/, '');
  const galleryHit = GALLERY_ROUTE_RE.exec(path);
  /* 地形分片：路由路径 == R2 key；图集：剥掉路由前缀 terr/，桶里是 gallery/… */
  const key = galleryHit ? `gallery/${galleryHit[1]}` : path;
  if (!TERR_RE.test(path) && !galleryHit) {
    return fail('路径不对：应该是 /terr/<工坊ID>.bin 或 /terr/gallery/<地图>/<图片>', 400);
  }

  if (!env.TERR) {
    return fail('R2 回退没配置（wrangler.jsonc 缺少 r2_buckets 绑定 TERR）', 503);
  }

  /* 边缘缓存：key 用完整 URL（同一个对象只有一个 URL） */
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;

  let obj: { body: ReadableStream; size: number } | null = null;
  try {
    obj = await env.TERR.get(key);
  } catch (e) {
    return fail('读 R2 失败：' + (e instanceof Error ? e.message : String(e)), 502);
  }
  if (!obj) return new Response(galleryHit ? '没有这张图' : '没有这个地形分片', { status: 404 });

  const res = new Response(request.method === 'HEAD' ? null : obj.body, {
    status: 200,
    headers: {
      'content-type': galleryHit ? contentTypeOf(key) : 'application/octet-stream',
      /* 这些对象不可变：分片路径带工坊 ID，图集文件名投稿时就定下了 */
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*',
    },
  });
  /* 写缓存失败不该影响这次请求 */
  try {
    await cache.put(request, res.clone());
  } catch {
    /* 忽略：下次再来还是会读到 R2 */
  }
  return res;
}
