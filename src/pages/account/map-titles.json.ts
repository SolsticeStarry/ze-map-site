/**
 * /account/map-titles.json —— 账号页「我的投稿」用的地图名 + 封面索引（构建期生成）。
 *
 * 为什么单独开一份：投稿记录在 D1 里只存 `map_slug`（`ze_flowering`），
 * 直接把它显示出来太生硬。整站的地图索引 `/submit/maps.json` 有 590 KB
 * （神器表、正文、字段现状都在里面），为一个个人页拉它太浪费。
 * 这里只输出「slug → [中文名, 封面]」，键名压到最短，954 张图约 60 KB、gzip 后十几 KB，
 * 而且**只有登录的人才会请求它**（游客页不会 fetch）。
 *
 * 拿不到这份索引也不影响用：页面会退回显示 slug（见 account.astro 里的 titleOf()）。
 */
import { getMaps } from '../../lib/maps';
import type { APIRoute } from 'astro';

export const GET: APIRoute = async () => {
  const maps = await getMaps();

  /* [中文名, 封面路径?] —— 没封面就只给一个元素，省掉每行一个 null */
  const index: Record<string, [string] | [string, string]> = {};
  for (const m of maps) {
    index[m.id] = m.data.cover ? [m.data.title, m.data.cover] : [m.data.title];
  }

  return new Response(JSON.stringify(index), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      /* 个人页专用；构建产物带哈希外的静态文件，给一小时缓存足够 */
      'cache-control': 'public, max-age=3600',
    },
  });
};
