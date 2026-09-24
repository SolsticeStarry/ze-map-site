/**
 * /submit/maps.json —— 投稿表单用的地图索引（构建期生成）。
 *
 * 为什么不在 /submit/?map=x 上做动态路由：
 * 那会给 547 张图各生成一个近乎重复的投稿页，白白撑大构建产物和 sitemap。
 * 这里输出一份小索引，表单取一次就能拿到任意地图的当前值用于预填。
 */
import { getMaps } from '../../lib/maps';
import type { APIRoute } from 'astro';

export const GET: APIRoute = async () => {
  const maps = await getMaps();

  const index = maps.map((m) => {
    const d = m.data;
    const row: Record<string, unknown> = {
      slug: m.id,
      title: d.title,
      titleEn: d.titleEn,
      difficulty: d.difficulty,
      tags: d.tags,
      stages: d.stages,
    };
    /* 只为非空字段占位，文件能小一点 */
    if (d.author) row.author = d.author;
    if (d.authorNote) row.authorNote = d.authorNote;
    if (d.version) row.version = d.version;
    if (d.players) row.players = d.players;
    if (d.duration) row.duration = d.duration;
    if (d.videoUrls?.length) row.videoUrls = d.videoUrls;
    if (d.sources?.length) row.sources = d.sources;
    return row;
  });

  return new Response(JSON.stringify(index), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
