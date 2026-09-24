import type { CollectionEntry } from 'astro:content';
import { getMaps } from './maps';
import manifest from '../../data/map-dates.json';

/**
 * 主页三个版块（新增地图 / 最新更新 / 工坊热门）共用的取数逻辑。
 *
 * 两个日期口径完全不同，别混：
 *   新增地图 —— 工坊**发布**日期（frontmatter 的 releaseDate）。回答「最近有什么新图」。
 *   最新更新 —— 本站**资料改动**日期（data/map-dates.json，来自 git 历史）。
 *               回答「最近谁往站里补了东西」。
 * 第三个是排行榜（按工坊订阅数），不涉及时间窗口。
 *
 * 为什么都带 days 和 date：
 *   页面把 date 写到 data-date 上，再有一段很短的脚本按**访问者本地时间**重新算一遍
 *   30 天窗口。站点是静态的，没人推代码就不会重新构建，光靠构建期筛的话，
 *   「30 天后自动消失」要等下一次部署才生效。构建期先筛一遍是给没开 JS 的人兜底。
 */

/** 各版块的时间窗口（天） */
export const WINDOW_DAYS = 30;
const DAY = 86400000;

const dates = (manifest as { maps: Record<string, { added?: string; updated?: string }> }).maps ?? {};

export interface DatedMap {
  map: CollectionEntry<'maps'>;
  /** 排序与过期判定用的日期，格式 YYYY-MM-DD */
  date: string;
  /** 距构建时间多少天（负数=未来日期，会被丢掉） */
  days: number;
}

/** 以 UTC 零点解析，避免不同时区把「今天」算成昨天 */
const dayDiff = (from: string, now: number) =>
  Math.floor((now - new Date(from + 'T00:00:00Z').getTime()) / DAY);

function collect(
  entries: Array<{ map: CollectionEntry<'maps'>; date?: string | null }>,
  windowDays: number
): DatedMap[] {
  const now = Date.now();
  return entries
    .filter((e): e is { map: CollectionEntry<'maps'>; date: string } => Boolean(e.date))
    .map((e) => ({ map: e.map, date: e.date, days: dayDiff(e.date, now) }))
    .filter((e) => e.days >= 0 && e.days <= windowDays)
    .sort((a, b) =>
      a.date === b.date
        ? a.map.data.title.localeCompare(b.map.data.title, 'zh-Hans-CN')
        : a.date < b.date
          ? 1
          : -1
    );
}

/** 新增地图：工坊最近 windowDays 天发布的图 */
export async function getNewMaps(windowDays = WINDOW_DAYS): Promise<DatedMap[]> {
  const maps = await getMaps();
  return collect(
    maps.map((m) => ({ map: m, date: m.data.releaseDate ?? null })),
    windowDays
  );
}

/** 最新更新：本站资料最近 windowDays 天被改过的图（来自 git 历史） */
export async function getUpdatedMaps(windowDays = WINDOW_DAYS): Promise<DatedMap[]> {
  const maps = await getMaps();
  return collect(
    maps.map((m) => ({ map: m, date: dates[m.id]?.updated ?? null })),
    windowDays
  );
}

/** 工坊热门：按订阅数排行，只收有订阅数的图 */
export async function getHotMaps(limit = 100): Promise<CollectionEntry<'maps'>[]> {
  const maps = await getMaps();
  return maps
    .filter((m) => (m.data.workshopSubs ?? 0) > 0)
    .sort(
      (a, b) =>
        (b.data.workshopSubs ?? 0) - (a.data.workshopSubs ?? 0) ||
        a.data.title.localeCompare(b.data.title, 'zh-Hans-CN')
    )
    .slice(0, limit);
}
