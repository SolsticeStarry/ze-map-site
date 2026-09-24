/**
 * 投稿字段定义 —— 全站唯一来源。
 *
 * 为什么要单独抽出来：
 * 「什么算一条合法投稿」这件事有三个地方需要知道 ——
 *   1. 投稿表单（src/pages/submit.astro）—— 前端即时校验、渲染对应控件
 *   2. Worker（worker/index.ts）—— 服务端权威校验，绝不相信前端
 *   3. 测试脚本 —— 单独验证规则本身
 * 三处各写一份必然漂移。难度枚举那次线上构建红叉（有人写了「普通」）
 * 就是同一类事故，所以这次一开始就共用一份。
 *
 * 加字段的步骤：在这里加一条规则 → 表单自动出现控件 → Worker 自动开始校验。
 */

import { DIFFICULTIES } from './difficulty.mjs';

/** 单条投稿的字段上限（跨字段） */
export const LIMITS = {
  submitter: 32,
  contact: 80,
  note: 500,
  /** 每个 IP 每小时最多投稿几次 */
  perHour: 5,
};

/**
 * 字段规则。
 * kind 决定表单控件类型与校验方式：
 *   enum     单选（下拉 / 按钮组）
 *   text     单行文本
 *   tags     字符串数组（标签）
 *   int      整数
 *   urlList  链接数组
 *   longtext 多行正文
 */
export const FIELD_RULES = {
  difficulty: { kind: 'enum', label: '难度', hint: '必须从这几个里选', values: DIFFICULTIES },
  tags: { kind: 'tags', label: '标签', hint: '整组替换，不是追加', max: 12, maxLen: 24 },
  author: { kind: 'text', label: '作者', hint: '尽量与工坊署名一致', maxLen: 120 },
  authorNote: { kind: 'text', label: '署名详情', hint: '多作者 / 原作与移植的区分', maxLen: 300 },
  version: { kind: 'text', label: '版本', maxLen: 40 },
  players: { kind: 'text', label: '人数', hint: '如「最多 64 人」', maxLen: 40 },
  duration: { kind: 'text', label: '时长', hint: '如「约 40 分钟」', maxLen: 40 },
  stages: { kind: 'int', label: '关卡数', min: 1, max: 30 },
  videoUrls: {
    kind: 'urlList',
    label: '攻略视频',
    hint: '每行一个，https 开头。B 站和 YouTube 会直接嵌播放器，其它站会显示成链接',
    /* 上限 12：站内已有 10 张图的视频超过 5 个（最多 9 个），
       上限太小会导致「想补全但提交不了」。 */
    max: 12,
    /* 社区补的按「追加 + 去重」合并，不替换 —— 否则补 1 个会把原有的全顶掉 */
    append: true,
  },
  sources: {
    kind: 'urlList',
    label: '资料来源',
    hint: '每行一个，https 开头',
    /* 同理：现有资料里超过 5 条来源的很多 */
    max: 12,
    append: true,
  },
  body: {
    kind: 'longtext',
    label: '补充说明 / 纠错',
    hint: '纯文本，支持简单 Markdown，不支持 HTML 与 MDX',
    maxLen: 4000,
  },
};

export const FIELD_KEYS = Object.keys(FIELD_RULES);

/** 是不是允许投稿的字段 */
export function isField(key) {
  return Object.prototype.hasOwnProperty.call(FIELD_RULES, key);
}

/* ===== 校验 ===== */

function checkUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '不是合法的链接';
  }
  if (url.protocol !== 'https:') return '链接必须以 https:// 开头';
  if (!url.hostname.includes('.')) return '链接域名看起来不对';
  if (/^\d+(\.\d+){3}$/.test(url.hostname)) return '不接受 IP 直链';
  if (raw.length > 300) return '链接过长';
  return null;
}

/**
 * 校验并归一化一个字段值。
 * @returns {{ok: true, value: unknown} | {ok: false, error: string}}
 */
export function validateValue(field, raw) {
  const rule = FIELD_RULES[field];
  if (!rule) return { ok: false, error: '不认识的字段' };

  switch (rule.kind) {
    case 'enum': {
      const v = typeof raw === 'string' ? raw.trim() : '';
      if (!rule.values.includes(v)) return { ok: false, error: `必须是：${rule.values.join(' / ')}` };
      return { ok: true, value: v };
    }

    case 'text': {
      const v = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
      if (!v) return { ok: false, error: '不能为空' };
      if (v.length > rule.maxLen) return { ok: false, error: `最多 ${rule.maxLen} 个字` };
      return { ok: true, value: v };
    }

    case 'longtext': {
      const v = typeof raw === 'string' ? raw.trim() : '';
      if (!v) return { ok: false, error: '不能为空' };
      if (v.length > rule.maxLen) return { ok: false, error: `最多 ${rule.maxLen} 个字` };
      /*
       * 正文只收纯文本。
       * 现有条目里已经踩过「工坊正文含 < 和 { 被当 JSX 解析导致构建失败」的坑，
       * 社区入口必须从格式上堵死：尖括号与花括号直接拒绝。
       */
      if (/[<>{}]/.test(v)) return { ok: false, error: '正文里不能出现 < > { } 这几个字符' };
      return { ok: true, value: v };
    }

    case 'tags': {
      const list = Array.isArray(raw) ? raw : [];
      const out = [];
      for (const item of list) {
        const t = typeof item === 'string' ? item.trim().replace(/\s+/g, ' ') : '';
        if (!t) continue;
        if (t.length > rule.maxLen) return { ok: false, error: `单个标签最多 ${rule.maxLen} 个字` };
        if (/[<>{}[\]|,]/.test(t)) return { ok: false, error: `标签「${t}」含不支持的字符` };
        if (!out.includes(t)) out.push(t);
      }
      if (out.length === 0) return { ok: false, error: '至少要有一个标签' };
      if (out.length > rule.max) return { ok: false, error: `最多 ${rule.max} 个标签` };
      return { ok: true, value: out };
    }

    case 'int': {
      const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
      if (!Number.isInteger(n)) return { ok: false, error: '要是整数' };
      if (n < rule.min || n > rule.max) return { ok: false, error: `要在 ${rule.min}~${rule.max} 之间` };
      return { ok: true, value: n };
    }

    case 'urlList': {
      const list = Array.isArray(raw)
        ? raw
        : String(raw ?? '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
      const out = [];
      for (const item of list) {
        const s = typeof item === 'string' ? item.trim() : '';
        if (!s) continue;
        const bad = checkUrl(s);
        if (bad) return { ok: false, error: `${bad}：${s.slice(0, 60)}` };
        if (!out.includes(s)) out.push(s);
      }
      if (out.length === 0) return { ok: false, error: '至少要有一个链接' };
      if (out.length > rule.max) return { ok: false, error: `最多 ${rule.max} 个链接` };
      return { ok: true, value: out };
    }

    default:
      return { ok: false, error: '字段类型未实现' };
  }
}

/** 表单里的控件类型（前端用） */
export function inputKind(field) {
  const rule = FIELD_RULES[field];
  if (!rule) return null;
  if (rule.kind === 'tags' || rule.kind === 'urlList') return 'lines';
  if (rule.kind === 'longtext') return 'textarea';
  if (rule.kind === 'enum') return 'select';
  return 'text';
}

/** 把字段值转成给人看的字符串（审核台展示、git 提交信息用） */
export function displayValue(field, value) {
  if (Array.isArray(value)) return value.join('、');
  return String(value ?? '');
}
