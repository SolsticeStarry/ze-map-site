import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

/** 静态 sitemap：首页 / 地图库 / 实体预览 / 标签页 + 全部地图详情页 */
export const GET: APIRoute = async ({ site }) => {
  const base = (site?.href ?? 'https://ze-map.cn/').replace(/\/+$/, '');
  const maps = await getCollection('maps');

  const urls: { loc: string; lastmod?: string; priority?: string }[] = [
    { loc: '/', priority: '1.0' },
    { loc: '/maps/', priority: '0.9' },
    { loc: '/preview/', priority: '0.8' },
    { loc: '/tags/', priority: '0.6' },
    { loc: '/contribute/', priority: '0.4' },
    { loc: '/about/', priority: '0.3' },
  ];

  for (const m of maps) {
    urls.push({
      loc: `/maps/${m.id}/`,
      lastmod: m.data.lastUpdated,
      priority: m.data.stub ? '0.5' : '0.7',
    });
  }

  const tags = [...new Set(maps.flatMap((m) => m.data.tags))].sort();
  for (const t of tags) {
    urls.push({ loc: `/tags/${encodeURIComponent(t)}/`, priority: '0.4' });
  }

  const body = urls
    .map(
      (u) =>
        `  <url><loc>${base}${u.loc}</loc>` +
        (u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : '') +
        (u.priority ? `<priority>${u.priority}</priority>` : '') +
        `</url>`
    )
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
