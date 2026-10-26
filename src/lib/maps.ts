/**
 * 地图数据的统一读取入口：research（基线）+ data/content（玩家覆盖）+ 自动生成。
 * 页面、列表、搜索、标签、推荐、编辑页全部走这里。
 */
import { getCollection } from 'astro:content';
import { normalizePageContent, contentRevision, researchRevision } from '../../shared/page-schema.mjs';
import { mergeItems, docItemDetails } from '../../shared/items.mjs';

const contentModules = import.meta.glob('../../data/content/*.json', { eager: true });
const researchModules = import.meta.glob('../../data/research/*.json', { eager: true });
const gflModules = import.meta.glob('../../data/gfl-parsed/*.json', { eager: true });

const contentCache = new Map<string, ReturnType<typeof normalizePageContent> | null>();
const researchCache = new Map<string, Record<string, any> | null>();
const itemCache = new Map<string, any[]>();
const researchRevCache = new Map<string, string>();
const contentRevCache = new Map<string, string | null>();

function contentFor(slug: string) {
  if (contentCache.has(slug)) return contentCache.get(slug) ?? null;
  const raw = contentModules[`../../data/content/${slug}.json`] as { default?: unknown } | undefined;
  const content = raw ? normalizePageContent(slug, raw.default ?? raw) : null;
  contentCache.set(slug, content);
  return content;
}

function researchFor(slug: string) {
  if (researchCache.has(slug)) return researchCache.get(slug) ?? null;
  const raw = researchModules[`../../data/research/${slug}.json`] as { default?: Record<string, any> } | undefined;
  const value = raw?.default ?? raw ?? null;
  researchCache.set(slug, value);
  return value;
}

function gflFor(slug: string) {
  const exact = gflModules[`../../data/gfl-parsed/${slug}.json`] as { default?: Record<string, any> } | undefined;
  if (exact) return exact.default ?? exact;
  const key = Object.keys(gflModules).find((path) => path.toLowerCase().endsWith(`/${slug.toLowerCase()}.json`));
  const raw = key ? (gflModules[key] as { default?: Record<string, any> }) : undefined;
  return raw?.default ?? raw ?? null;
}

function itemsFor(slug: string, body: string) {
  if (itemCache.has(slug)) return itemCache.get(slug)!;
  const base = gflFor(slug)?.items ?? [];
  const rows = mergeItems(base, docItemDetails(body)).rows;
  itemCache.set(slug, rows);
  return rows;
}

/** 合并 research 与 content；content 是覆盖层，缺省字段继续读 research。 */
export function mergeEntry<T extends { id: string; data: Record<string, any> }>(entry: T, options: { items?: boolean } = {}): T {
  const withItems = options.items !== false;
  const data: Record<string, any> = { ...entry.data };
  const player = contentFor(entry.id);
  const research = researchFor(entry.id);
  data.playerContent = player;
  data.research = research;
  if (!researchRevCache.has(entry.id)) researchRevCache.set(entry.id, researchRevision(research));
  if (!contentRevCache.has(entry.id)) contentRevCache.set(entry.id, player ? contentRevision(player) : null);
  data.researchRev = researchRevCache.get(entry.id) ?? null;
  data.contentRev = contentRevCache.get(entry.id) ?? null;

  if (withItems) {
    data.items = itemsFor(entry.id, String(entry.body ?? ''));
    const edits = Array.isArray(player?.itemEdits) ? player.itemEdits : [];
    if (edits.length) data.items = mergeItems(data.items, edits).rows;
    const order = Array.isArray(player?.itemOrder) ? player.itemOrder : [];
    if (order.length) {
      const index = new Map(order.map((name: string, position: number) => [String(name).toLowerCase(), position]));
      data.items = [...data.items].sort((left: any, right: any) =>
        (index.get(String(left.name).toLowerCase()) ?? Number.MAX_SAFE_INTEGER) -
        (index.get(String(right.name).toLowerCase()) ?? Number.MAX_SAFE_INTEGER));
    }
  }

  if (typeof player?.title === 'string' && player.title.trim()) data.title = player.title;
  if (player?.heroImage) data.cover = player.heroImage;
  if (player?.infobox && typeof player.infobox === 'object') Object.assign(data, player.infobox);
  if (Array.isArray(player?.tags)) data.tags = [...player.tags];
  if (typeof player?.difficulty === 'string' && player.difficulty) data.difficulty = player.difficulty;
  if (typeof data.aliases === 'string') data.aliases = data.aliases.split(/\n+/).map((item) => item.trim()).filter(Boolean);
  if (data.stages !== undefined && data.stages !== null && String(data.stages).trim() && !Number.isNaN(Number(data.stages))) data.stages = Number(data.stages);
  if (player?.blocks?.length || player?.itemEdits?.length || player?.tags?.length || player?.difficulty) data.stub = false;

  return { ...entry, data } as T;
}

/** 同一标签的大小写变体归到出现最多的写法；Windows 下大小写不敏感，不归并会导致标签页互相覆盖。 */
function canonicalTagMap(entries: Array<{ data: Record<string, any> }>) {
  const variants = new Map<string, Map<string, number>>();
  for (const entry of entries) for (const tag of entry.data.tags ?? []) {
    const key = String(tag).toLowerCase();
    if (!variants.has(key)) variants.set(key, new Map());
    const counts = variants.get(key)!;
    counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  const canonical = new Map<string, string>();
  for (const [key, counts] of variants) {
    canonical.set(key, [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))[0][0]);
  }
  return canonical;
}

function withCanonicalTags<T extends { data: Record<string, any> }>(entry: T, canonical: Map<string, string>): T {
  return {
    ...entry,
    data: {
      ...entry.data,
      tags: [...new Set((entry.data.tags ?? []).map((tag: string) => canonical.get(String(tag).toLowerCase()) || tag))],
    },
  };
}

/** 所有地图（已合并 content 覆盖） */
export async function getMaps() {
  const merged = (await getCollection('maps')).map((m) => mergeEntry(m as any, { items: false }));
  const canonical = canonicalTagMap(merged);
  return merged.map((entry) => withCanonicalTags(entry, canonical));
}

/** 单张地图：详情页与编辑页需要神器表时用这个。 */
export async function getMap(slug: string) {
  const maps = await getCollection('maps');
  const canonical = canonicalTagMap(maps.map((m) => mergeEntry(m as any, { items: false })));
  const entry = maps.find((item) => item.id === slug);
  return entry ? withCanonicalTags(mergeEntry(entry as any, { items: true }), canonical) : null;
}
