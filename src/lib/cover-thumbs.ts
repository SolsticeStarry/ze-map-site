/**
 * 卡片封面用哪张图（2026-10-15 加）。
 *
 * 背景：人工封面（`public/images/covers/custom/`）是 1280×720、平均 ~100 KB、最大 220 KB，
 * 而卡片里只显示 379×213。首页那三张精选卡片因此要下 400+ KB —— 实测「有时候很慢」的主因之一
 * （同一条链路上 183 KB 的图，下载耗时 349~1430 ms，差 4 倍）。
 *
 * 做法：`npm run images:thumbs` 生成一批 640 宽的缩略图放在 `custom-640/`，
 * 卡片优先用它；**地图页顶部那张氛围大图仍然用原图**（它是全宽铺底的，缩图会糊）。
 *
 * 构建期查一次目录索引（模块级缓存，850 张卡片只 readdir 一次）；找不到缩略图就返回原图，
 * 所以「还没跑过 images:thumbs」不会让任何页面缺图。
 */
import fs from 'node:fs';
import path from 'node:path';

const THUMB_DIR = 'public/images/covers/custom-640';
const CUSTOM_PREFIX = '/images/covers/custom/';

let index: Set<string> | null = null;

function thumbs(): Set<string> {
  if (index) return index;
  try {
    index = new Set(fs.readdirSync(path.join(process.cwd(), THUMB_DIR)).map((f) => f.toLowerCase()));
  } catch {
    /* 还没生成过缩略图：当作一张都没有 */
    index = new Set();
  }
  return index;
}

/**
 * 卡片用图：人工封面有缩略图就换成缩略图，其它（工坊封面已经是 555×312）原样返回。
 * @param cover frontmatter 里的 cover（如 /images/covers/custom/ze_foo.webp），可能为空
 */
export function cardCover(cover?: string | null): string | undefined {
  if (!cover || !cover.startsWith(CUSTOM_PREFIX)) return cover ?? undefined;
  const name = cover.slice(CUSTOM_PREFIX.length);
  /* 缩略图统一是 .webp（原图可能是 png/jpg） */
  const thumbName = name.replace(/\.(jpe?g|png)$/i, '.webp');
  return thumbs().has(thumbName.toLowerCase()) ? `/images/covers/custom-640/${thumbName}` : cover;
}
