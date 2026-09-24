/**
 * 社区贡献文档 data/community/<slug>.json 的形状与读写辅助。
 *
 * Worker（写入）与站点构建（读取）共用这一份，避免两边对格式的理解漂移。
 *
 * 文件长这样：
 * {
 *   "v": 1,
 *   "slug": "ze_flowering",
 *   "updatedAt": "2026-09-24T07:00:00.000Z",
 *   "fields": {
 *     "difficulty": { "v": "普通", "by": "老王", "at": "...", "submission": 12 }
 *   },
 *   "notes": [
 *     { "text": "第二关的传送门……", "by": "某人", "at": "...", "submission": 13 }
 *   ],
 *   "log": [ { "field": "difficulty", "from": "未知", "to": "普通", "by": "...", "at": "..." } ]
 * }
 *
 * 渲染优先级：社区（本文件） > 人工资料 data/research > 自动生成 src/content/maps
 */

export const DOC_VERSION = 1;

/** 新建一个空文档 */
export function emptyDoc(slug) {
  return { v: DOC_VERSION, slug, updatedAt: null, fields: {}, notes: [], log: [] };
}

/**
 * 把任意（可能残缺、可能被人手改坏的）JSON 规整成合法文档。
 * 构建期也会走这里 —— 仓库里的文件万一被改坏，页面不该整个崩掉。
 */
export function normalizeDoc(slug, raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const fields = {};
  if (d.fields && typeof d.fields === 'object') {
    for (const [k, v] of Object.entries(d.fields)) {
      if (v && typeof v === 'object' && 'v' in v) {
        fields[k] = { v: v.v, by: v.by ?? '匿名', at: v.at ?? null, submission: v.submission ?? null };
      } else if (v !== undefined && v !== null) {
        /* 容忍手写的简写形式：difficulty: "普通" */
        fields[k] = { v, by: '匿名', at: null, submission: null };
      }
    }
  }
  return {
    v: DOC_VERSION,
    slug,
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : null,
    fields,
    notes: (Array.isArray(d.notes) ? d.notes : [])
      .filter((n) => n && typeof n.text === 'string' && n.text.trim())
      .map((n) => ({
        text: n.text,
        by: n.by ?? '匿名',
        at: n.at ?? null,
        submission: n.submission ?? null,
      })),
    log: Array.isArray(d.log) ? d.log : [],
  };
}

/**
 * 应用一条审核通过的投稿（就地修改 doc）。
 * @returns {{field: string, from: unknown, to: unknown}} 改动摘要，用于 git 提交信息
 */
export function applySubmission(doc, sub) {
  const at = new Date(sub.reviewedAt ?? Date.now()).toISOString();
  const by = sub.submitter || '匿名';

  if (sub.field === 'body') {
    doc.notes.push({ text: sub.value, by, at, submission: sub.id ?? null });
    doc.log.push({ field: 'body', from: null, to: null, by, at, submission: sub.id ?? null });
    return { field: 'body', from: null, to: sub.value };
  }

  const prev = doc.fields[sub.field]?.v ?? null;
  doc.fields[sub.field] = { v: sub.value, by, at, submission: sub.id ?? null };
  doc.log.push({ field: sub.field, from: prev, to: sub.value, by, at, submission: sub.id ?? null });
  return { field: sub.field, from: prev, to: sub.value };
}

/** 更新时间戳 */
export function touch(doc, at = new Date().toISOString()) {
  doc.updatedAt = at;
}

/** 所有贡献过的昵称（去重，按首次出现顺序） */
export function contributors(doc) {
  const seen = [];
  for (const f of Object.values(doc?.fields ?? {})) {
    if (f?.by && !seen.includes(f.by)) seen.push(f.by);
  }
  for (const n of doc?.notes ?? []) {
    if (n?.by && !seen.includes(n.by)) seen.push(n.by);
  }
  return seen;
}

/** 取社区覆盖的字段值（没有就返回 undefined，调用方回退到人工/自动数据） */
export function fieldValue(doc, field) {
  return doc?.fields?.[field]?.v;
}

/** 取字段的归属信息（谁补的、什么时候） */
export function fieldMeta(doc, field) {
  return doc?.fields?.[field] ?? null;
}

/** 是否是一份「有内容」的文档（空文档不渲染任何东西） */
export function hasContent(doc) {
  return Boolean(doc && (Object.keys(doc.fields ?? {}).length > 0 || (doc.notes ?? []).length > 0));
}
