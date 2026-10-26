/** 视频分类统一映射：详情页、编辑页、审核台共用。 */

export const VIDEO_CATEGORIES = Object.freeze({
  run: '通关视频',
  guide: '攻略',
  music: '音乐',
});

const GUIDE_KINDS = new Set(['老司机经验', '触发攻略', '彩蛋触发', '相关视频', '攻略']);

/** 旧 videoKinds（中文标签）→ run / guide / music */
export function videoKindOf(url, kinds = {}) {
  const bv = /BV[0-9A-Za-z]{10}/.exec(String(url ?? ''))?.[0] ?? '';
  const value = kinds?.[bv] ?? '';
  if (value === '音乐') return 'music';
  if (GUIDE_KINDS.has(value)) return 'guide';
  return 'run';
}

export const videoCategoryLabel = (kind) => VIDEO_CATEGORIES[kind] ?? VIDEO_CATEGORIES.run;
