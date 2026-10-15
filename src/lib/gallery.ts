/**
 * 地图图片集（data/gallery/<slug>.json）—— **只放真实图片**：工坊预览图 + 玩家投稿。
 *
 * 图片本身存在 Cloudflare R2（`terr.ze-map.cn/gallery/<slug>/...`）——
 * 546 张地图 × 若干张图，塞进 git/dist 会重演 terr 那次的体积事故。
 * 入库的只有这份几百字节的清单（谁、什么说明），页面按清单取图。
 *
 * 清单有两个来源，两种都会被人手动改，所以**两边的写法必须一致**：
 *   · `scripts/gallery/fetch-workshop-previews.mjs` + `upload-gallery.mjs`：作者上传的工坊预览图
 *     （`kind: 'workshop'`，脚本重写清单时会保留玩家投稿的那些条目，不会冲掉）；
 *   · Worker 的写回（worker/gallery.ts + worker/submissions.ts 的 handleAdminFlush）：
 *     审核通过的玩家投稿（`kind: 'user'`，图片名 `u<投稿id>.<ext>`）。
 *
 * ⚠️ 以前这里还有「本站用真实碰撞地形渲染的 3D 视角图」（kind: 'render'）。
 *    2026-10-06 去掉了：那是本站画的示意图，和真实截图混在一起会误导人。
 *
 * ⚠️ 用 import.meta.glob 而不是 fs.readFile：预渲染时 cwd 是 dist/.prerender，
 * 相对路径读文件会直接构建失败（2026-09-23 线上部署失败的根因）。
 */
export interface GalleryImage {
  src: string;
  /** 同源地址（`/terr/gallery/…`，Worker 从 R2 取 + 边缘缓存一年）；取不到同源时回退用 src */
  localSrc: string;
  kind: string;
  caption: string;
  /** 投稿人昵称（玩家投稿才有） */
  by: string;
}

/**
 * R2 直连地址 → 同源地址。
 *
 * 为什么优先走同源（2026-10-15 改，实测数据）：国内直连 `terr.ze-map.cn` 取一张 44 KB 的图集图，
 * 中位 550~785 ms、最差 2.5 秒；同样的图走 `ze-map.cn/terr/gallery/…`（Worker 读 R2，
 * 边缘缓存一年）中位 ~273 ms —— 快一倍多，而且**不受那个域在国内部分网络不通的影响**
 * （站点自己在 worker/terr.ts 里早就为地形分片做过同源回退，图集图片一直没有）。
 * 代价是每张图一次 Worker 调用：升级 Workers Paid 后额度是 1000 万/月，够用。
 */
export function sameOriginGallery(src: string): string {
  return String(src ?? '').replace(/^https:\/\/terr\.ze-map\.cn\//, '/terr/');
}

const modules = import.meta.glob('../../data/gallery/*.json', { eager: true }) as Record<
  string,
  { default?: unknown }
>;

const cache = new Map<string, GalleryImage[]>();

/** 某张地图的图片集；没有就返回空数组（页面据此决定要不要渲染这一块） */
export function galleryFor(slug: string): GalleryImage[] {
  const hit = cache.get(slug);
  if (hit) return hit;
  const raw = modules[`../../data/gallery/${slug}.json`];
  const data = (raw?.default ?? raw) as { images?: unknown } | undefined;
  let out: GalleryImage[] = [];
  if (data && Array.isArray(data.images)) {
    out = data.images
      .filter((i): i is Record<string, unknown> => Boolean(i) && typeof i === 'object')
      .map((i) => ({
        src: String(i.src ?? ''),
        localSrc: sameOriginGallery(String(i.src ?? '')),
        kind: String(i.kind ?? 'other'),
        caption: String(i.caption ?? ''),
        by: String(i.by ?? ''),
      }))
      .filter((i) => i.src);
  }
  cache.set(slug, out);
  return out;
}
