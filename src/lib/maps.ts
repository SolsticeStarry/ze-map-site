/**
 * 地图数据的**统一读取入口**。
 *
 * ⚠️ 页面里请一律用 getMaps()，不要直接 getCollection('maps')。
 *
 * 为什么需要这一层：
 * 站点有近十处读地图数据（地图库卡片、首页、标签索引、标签详情、同类推荐、
 * 投稿表单索引、404、关于页、搜索页）。社区投稿可以覆盖难度/标签/作者等字段
 * （data/community/<slug>.json），如果只在详情页合并，就会出现
 * 「详情页显示困难、地图库里还是中等」这种自相矛盾。合并放在这里一次，
 * 所有调用方自动一致。
 *
 * 曾经试过的方案（记录一下，别再走一遍）：
 * 包一层 content loader、在 load() 里 context.store.set() 回写合并结果 ——
 * **不行**。实测：glob 命中、store 能读能写、预演也显示「会合并 1 条」，
 * 但合并后回读仍是原值，渲染出来的页面也没变。Astro 的 content store
 * 不认这种「包一层再回写」的用法，所以改成在读取层合并。
 */
import { getCollection } from 'astro:content';
import { contributors, fieldValue, hasContent, normalizeDoc } from '../../shared/community-doc.mjs';

/*
 * 社区文件由打包器解析路径 —— 绝不要改成 fs.readFile + 相对路径，
 * 那正是 2026-09-23「/bundle」构建失败的根因（构建期 cwd 会变）。
 */
const communityModules = import.meta.glob('../../data/community/*.json', { eager: true });

/** 社区可以覆盖的字段（与 shared/submission-fields.mjs 保持一致） */
const OVERRIDABLE = [
  'difficulty',
  'tags',
  'author',
  'authorNote',
  'version',
  'players',
  'duration',
  'stages',
  'sources',
  'videoUrls',
];

const docCache = new Map<string, ReturnType<typeof normalizeDoc> | null>();

function communityFor(slug: string) {
  if (docCache.has(slug)) return docCache.get(slug) ?? null;
  const raw = communityModules[`../../data/community/${slug}.json`] as
    | { default?: unknown }
    | undefined;
  const doc = raw ? normalizeDoc(slug, raw.default ?? raw) : null;
  docCache.set(slug, doc);
  return doc;
}

/** 把社区覆盖合并进一个条目（返回新对象，不改原条目） */
export function mergeEntry<T extends { id: string; data: Record<string, any> }>(entry: T): T {
  const doc = communityFor(entry.id);
  const data: Record<string, any> = { ...entry.data };

  if (!doc || !hasContent(doc)) {
    data.communityFields = [];
    data.communityNotes = [];
    data.communityPeople = [];
    return { ...entry, data } as T;
  }

  const applied: string[] = [];
  for (const field of OVERRIDABLE) {
    const v = fieldValue(doc, field);
    if (v === undefined || v === null) continue;
    data[field] = v;
    applied.push(field);
  }

  /* 有社区补充正文就不再算「资料待补充」 */
  if (doc.notes.length > 0) data.stub = false;

  data.communityFields = applied;
  data.communityNotes = doc.notes;
  data.communityPeople = contributors(doc);

  return { ...entry, data } as T;
}

/** 所有地图（已合并社区覆盖） */
export async function getMaps() {
  const maps = await getCollection('maps');
  return maps.map((m) => mergeEntry(m as any));
}
