/**
 * 难度枚举 —— 全站唯一来源（single source of truth）。
 *
 * 为什么单独抽出来：
 * 2026-09-24 线上构建红叉，根因是贡献者把 difficulty 写成了枚举之外的「普通」。
 * 站点 schema（src/content.config.ts）和投票 Worker（worker/index.ts）必须共用
 * 同一份定义，否则「前端能投的难度」和「构建能收的难度」迟早漂移，
 * 又会在某次构建里以红叉的形式炸出来。
 *
 * 改这个数组 = 同时改站点校验与投票选项，两边一起生效。
 */

/** 难度枚举（顺序即投票按钮顺序，从易到难） */
export const DIFFICULTIES = ['简单', '中等', '困难', '极难', '地狱', '未知'];

/** 资料缺失时的默认值 */
export const DIFFICULTY_DEFAULT = '未知';

/** 是不是合法难度 */
export function isDifficulty(value) {
  return typeof value === 'string' && DIFFICULTIES.includes(value);
}

/** 难度 → CSS 类名（详情页徽章、地图卡片、投票条共用一套配色） */
export const DIFFICULTY_CLASS = {
  简单: 'diff-easy',
  中等: 'diff-medium',
  困难: 'diff-hard',
  极难: 'diff-extreme',
  地狱: 'diff-hell',
  未知: 'diff-unknown',
};
