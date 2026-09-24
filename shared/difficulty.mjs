/**
 * 难度枚举 —— 全站唯一来源（single source of truth）。
 *
 * 为什么单独抽出来：
 * 2026-09-24 线上构建红叉，根因是贡献者把 difficulty 写成了枚举之外的「普通」。
 * 站点 schema（src/content.config.ts）和投票 Worker（worker/index.ts）必须共用
 * 同一份定义，否则「前端能投的难度」和「构建能收的难度」迟早漂移，
 * 又会在某次构建里以红叉的形式炸出来。
 *
 * 改这个数组 = 同时改站点校验、投票选项、筛选器与配色对应关系。
 *
 * 改名历史：
 *   2026-09-24  新增「入门」；中等→普通、极难→火星、地狱→入土
 *   （旧称保留在 DIFFICULTY_RENAMES 里，只用于读取历史数据兜底）
 */

/** 难度枚举：顺序即展示顺序，从最易到最难，「未知」固定放最后 */
export const DIFFICULTIES = ['入门', '简单', '普通', '困难', '火星', '入土', '未知'];

/** 资料缺失时的默认值 */
export const DIFFICULTY_DEFAULT = '未知';

/**
 * 历史旧称 → 现称。
 *
 * 只用于**读取历史数据**时兜底：D1 里改名之前投的票、旧资料文件等。
 * 写入一律要求当前枚举值 —— `isDifficulty()` 是严格判断，不接受旧称，
 * 否则脏数据会重新流进库里。
 */
export const DIFFICULTY_RENAMES = {
  中等: '普通',
  极难: '火星',
  地狱: '入土',
};

/** 把可能是旧称的难度值归一成当前枚举值；认不出来就原样返回 */
export function normalizeDifficulty(value) {
  if (typeof value !== 'string') return value;
  return DIFFICULTY_RENAMES[value] ?? value;
}

/** 是不是合法的**当前**难度值（严格，不接受旧称） */
export function isDifficulty(value) {
  return typeof value === 'string' && DIFFICULTIES.includes(value);
}

/**
 * 难度 → CSS 类名。
 *
 * 类名刻意**不跟着中文名走**：普通仍用 diff-medium、火星仍用 diff-extreme、
 * 入土仍用 diff-hell。这样以后再改中文叫法时，配色样式一行都不用动。
 */
export const DIFFICULTY_CLASS = {
  入门: 'diff-intro',
  简单: 'diff-easy',
  普通: 'diff-medium',
  困难: 'diff-hard',
  火星: 'diff-extreme',
  入土: 'diff-hell',
  未知: 'diff-unknown',
};
