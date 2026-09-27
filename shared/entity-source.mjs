/**
 * 实体数据「来源」文案 —— 单一出处（Node 脚本与站点生成器共用）。
 *
 * 站上两套实体数据的来路不同，条目里必须如实分开写：
 *   - BAKED_SOURCE：本站用 Source2Viewer 从创意工坊地图包解出的实体定义；
 *   - LEGACY_SOURCE：建站时入库的第三方服务端实体 dump，只留一句中性描述，
 *     不再指名具体组织。数据本身仍原样保留（坐标、数量都没动），只是不再署名。
 *
 * normalizeEntitySource() 把旧索引里遗留的来源串（含已隐去的组织名）归一成 LEGACY_SOURCE。
 * 为什么需要它：catalog.json 是逐图记录，buildCatalog() 会用旧记录的 source 字段续写新版本，
 * 所以光改默认常量不够，旧串会一直跟着新 catalog 跑下去。
 */

/** 本站烘焙：scripts/terr-bake 用 Source2Viewer 解出的 default_ents.vents_c。 */
export const BAKED_SOURCE = 'Source2Viewer default_ents.vents_c';

/** 历史快照：入库时的那份第三方服务端实体 dump，已隐去组织名。 */
export const LEGACY_SOURCE = '历史服务端实体快照';

/** 旧索引里出现过的来源串（按片段识别，大小写不敏感）。 */
const RETIRED_SOURCE_MARKERS = ['maptracking', 'stardance', 'fyscs'];

/** 归一来源串：空值或已隐去的旧串一律落到 LEGACY_SOURCE，其余原样返回。 */
export function normalizeEntitySource(value) {
  if (typeof value !== 'string' || !value.trim()) return LEGACY_SOURCE;
  if (value === BAKED_SOURCE) return value;
  const lower = value.toLowerCase();
  return RETIRED_SOURCE_MARKERS.some((marker) => lower.includes(marker)) ? LEGACY_SOURCE : value;
}
