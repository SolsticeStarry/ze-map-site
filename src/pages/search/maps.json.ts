/**
 * /search/maps.json —— 站内搜索用来兜「图名精确匹配」的轻量索引（构建期生成）。
 *
 * 为什么搜索页需要它：Pagefind 的中文分词对短词组不可靠 —— 实测「指环王」匹配不到
 * 标题就叫《指环王：米那斯提力斯》的那张图（那一页正文里「指环王」出现 9 次，h1 就是它），
 * 却返回一批正文里只出现过「指」的页面；而单独搜「指」时那张图排第 1。
 * 换排序参数救不了（标题权重 12、termSimilarity、termSaturation、pageLength 五组都试过，
 * 因为问题出在「匹不匹配」而不是「排第几」），所以搜索页自己拿这份索引兜一层。
 *
 * 只输出兜底需要的四个字段，比 /submit/maps.json 小得多（那个要预填表单字段）。
 */
import { getMaps } from '../../lib/maps';
import type { APIRoute } from 'astro';

export const GET: APIRoute = async () => {
  const maps = await getMaps();
  const index = maps.map((m) => ({
    s: m.id, // slug
    t: m.data.title, // 中文名
    e: m.data.titleEn, // 英文名（内部名）
    d: m.data.difficulty, // 难度，用于结果里的徽章
  }));

  return new Response(JSON.stringify(index), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
