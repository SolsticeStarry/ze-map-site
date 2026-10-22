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
 *   "items": [
 *     { "action": "update", "name": "Survivor", "cd": 60, "uses": 1, "note": "第四关才有",
 *       "by": "某人", "at": "...", "submission": 14 }
 *   ],
 *   "log": [ { "field": "difficulty", "from": "未知", "to": "普通", "by": "...", "at": "..." } ]
 * }
 *
 * 渲染优先级：社区（本文件） > 人工资料 data/research > 自动生成 src/content/maps
 *
 * 正文类字段（kind=longtext，例如「补充说明 / 纠错」body、「背景故事」story）
 * **不进 fields**，而是作为一条 note 追加到 notes 里（note 上带 field，标明投的是哪个字段），
 * 地图页再按字段分块显示：story → 「背景故事（社区投稿）」，body → 「社区补充」。
 * 判断走 isNoteField()，从字段表派生 —— 别再写死字段名。
 * 已通过的 note 可以被**修订**（投稿带 reviseOf = note 的 id）：正文替换、署名保留
 * 原作者、另记 revisedBy/revisedAt。见下面 notePublicId / findNoteIndex 的说明。
 *
 * 神器 / 道具（kind=itemlist）**也不进 fields**：它是一行行的增量（更正 / 新增 / 删除），
 * 整表替换说不清来源，所以单独放 items[]，由生成器用 mergeItems() 合并进正文的表格。
 * 判断走 isItemField()，同样从字段表派生。
 */

import { FIELD_RULES } from './submission-fields.mjs';
import { itemKey, normalizeItemRow } from './items.mjs';

export const DOC_VERSION = 1;

/**
 * 这个字段是「正文类」吗（进 notes 而不是覆盖条目字段）。
 * 从 shared/submission-fields.mjs 的 kind 派生：加一个 longtext 字段就自动跟上。
 * `titledtext`（社区整理：自己起标题的小节）也进 notes，它只多带一个 title。
 */
export const isNoteField = (field) => ['longtext', 'titledtext'].includes(FIELD_RULES?.[field]?.kind);

/**
 * 「自己起标题的社区小节」吗（kind=titledtext）。
 * 这类投稿的值是 `{ title, text }`，落到 notes 里多存一个 title；渲染时标题由投稿人定。
 */
export const isTitledField = (field) => FIELD_RULES?.[field]?.kind === 'titledtext';

/** 这个字段是「神器 / 道具行」吗（进 items，由生成器逐行合并） */
export const isItemField = (field) => FIELD_RULES?.[field]?.kind === 'itemlist';

/**
 * 这个字段是「整篇草稿」吗（kind=doc，进 doc.draft，页面以「社区整理版（未采纳）」整块渲染，
 * 站长点「采纳为原稿」后按小节合并进 data/research）。
 * 和 notes 的区别：notes 是一条条**另起的补充块**，永远压不过本站正文；草稿是**改写整篇**的候选稿。
 */
export const isDocField = (field) => FIELD_RULES?.[field]?.kind === 'doc';

/** 新建一个空文档 */
export function emptyDoc(slug) {
  return { v: DOC_VERSION, slug, updatedAt: null, fields: {}, notes: [], draft: null, items: [], log: [] };
}

/* ===== 修订（改一条已经通过的社区投稿） =====
 *
 * 背景：notes 原本是**只能追加**的 —— 投稿人发现错别字或想补一句，只能再投一条，
 * 页面上就出现两条几乎一样的段落（2026-10-10 的反馈）。现在允许「修订某一条」：
 * 投稿时带上 reviseOf（那条 note 的 id），审核通过后**替换它的正文**，
 * 原作者保留，另记 revisedBy / revisedAt —— 署名不能因为别人改了字就换人。
 *
 * id 从哪来：note 上的 submission（= 投稿编号，老数据可能没有），
 * 没有编号的老 note 用它在数组里的位置 `i<下标>` 兜底。
 * 两边都靠 notePublicId() 算，别各写一份。
 *
 * 2026-10-15 补：一次投的**多节**社区整理会拆成 N 条 note，它们的 submission 是同一个编号 ——
 * 光用编号当 id 就重了，「修订这条」会改错节（永远命中第一条）。所以多节投稿的每节再带一个
 * `part`（1 起），id 长成 `123p2`；单节投稿不带 part，id 还是老样子 `123`（不动线上已有数据）。
 */

/** 这条 note 对外暴露的 id（投稿页「修订这条」传的就是它） */
export function notePublicId(note, index) {
  const s = note && note.submission !== undefined && note.submission !== null ? note.submission : null;
  if (s === null) return `i${index}`;
  const part = Number(note?.part);
  return Number.isInteger(part) && part > 0 ? `${s}p${part}` : String(s);
}

/** 修订目标 id 是否合法（投稿编号的数字、多节投稿的 `123p2`，或老 note 的 `i<下标>`） */
export function isReviseId(raw) {
  return typeof raw === 'string' && /^(?:\d{1,12}(?:p\d{1,3})?|i\d{1,5})$/.test(raw.trim());
}

/**
 * 修订目标 id → `{ submission, part }`。
 * `part` 为 0 表示「不带节号」（老写法：整条投稿只有一节）。
 * 解析不出来（`i3` 这种按位置兜底的老 note）返回 null。
 */
export function revisionTarget(raw) {
  const m = /^(\d{1,12})(?:p(\d{1,3}))?$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  return { submission: Number(m[1]), part: m[2] ? Number(m[2]) : 0 };
}

/**
 * 在 notes 里找 reviseOf 指向的那一条。
 * @returns {number} 下标，找不到返回 -1
 */
export function findNoteIndex(notes, reviseId) {
  const list = Array.isArray(notes) ? notes : [];
  const id = String(reviseId ?? '').trim();
  if (!isReviseId(id)) return -1;
  for (let i = 0; i < list.length; i++) {
    if (notePublicId(list[i], i) === id) return i;
  }
  return -1;
}

/**
 * 投稿的 value 在 note 字段上的几种形态：
 *   普通投稿 → 直接是字符串；修订 → { text, reviseOf }；
 *   社区整理（titledtext）→ { sections: [{title, text}, …] }（老数据是单节的 { title, text }）。
 * 这里统一拆成 { title, text, reviseOf }，调用方不必关心是哪种。
 * ⚠️ 多节的社区整理要用 titledSections() 拆成 N 节，那个在下面。
 */
export function notePayload(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.text === 'string') {
    return {
      title: typeof value.title === 'string' ? value.title.trim() : '',
      text: value.text,
      reviseOf: isReviseId(value.reviseOf) ? String(value.reviseOf).trim() : '',
    };
  }
  return { title: '', text: typeof value === 'string' ? value : String(value ?? ''), reviseOf: '' };
}

/**
 * 社区整理的投稿值 → 节列表（2026-10-15 支持一次多节）。
 * 兼容老的单节形状 `{ title, text }` —— 线上可能已经有这种投稿在队列里。
 * @returns {Array<{title: string, text: string}>}
 */
export function titledSections(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!v) return [];
  if (Array.isArray(v.sections)) {
    return v.sections
      .map((s) => ({
        title: String(s && typeof s === 'object' ? (s.title ?? '') : '').trim(),
        text: String(s && typeof s === 'object' ? (s.text ?? '') : '').trim(),
      }))
      .filter((s) => s.title || s.text);
  }
  if (typeof v.text === 'string') {
    return [{ title: typeof v.title === 'string' ? v.title.trim() : '', text: v.text.trim() }];
  }
  return [];
}

/** 社区整理投稿里的修订目标 id（没有就返回空串） */
export function titledReviseOf(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const raw = v && typeof v.reviseOf === 'string' ? v.reviseOf.trim() : '';
  return isReviseId(raw) ? raw : '';
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
        /* 投的是哪个字段（story / body / 以后新增的长文本字段）。
           老文件没有这一项 → null，页面按「社区补充」显示。 */
        field: typeof n.field === 'string' && n.field ? n.field : null,
        /* 「社区整理」（titledtext）才有：投稿人自己起的小节标题。
           ⚠️ 这一项必须在这里显式带上 —— normalizeDoc 是白名单式重建，
           漏掉就等于每次读文件都把标题丢掉（页面上的小节名会变成默认名）。 */
        title: typeof n.title === 'string' && n.title.trim() ? n.title.trim().slice(0, 40) : null,
        /* 一次多节投稿里的第几节（1 起；单节投稿没有这一项）。
           和 submission 一起决定 note 的对外 id（见 notePublicId）——
           同样是白名单重建，漏掉就会让多节的 id 又重到一起，修订会改错节。 */
        part: Number.isInteger(n.part) && n.part > 0 ? n.part : 0,
        /* 被修订过才有：最后改这条的人与时间。署名（by）保持原作者不动，
           页面显示成「由 A 投稿（B 于 … 修订）」—— 谁写的、谁改的要分得清。 */
        revisedBy: typeof n.revisedBy === 'string' && n.revisedBy ? n.revisedBy : null,
        revisedAt: typeof n.revisedAt === 'string' && n.revisedAt ? n.revisedAt : null,
        revision: Number.isInteger(n.revision) && n.revision > 0 ? n.revision : 0,
      })),
    log: Array.isArray(d.log) ? d.log : [],
    /*
     * 整篇草稿（2026-10-13 加）：{ text, by, at, submission } 或 null。
     * 只保留最新一篇；被改坏 / 空文本就当没有，页面照旧只显示本站内容。
     */
    draft:
      d.draft && typeof d.draft === 'object' && typeof d.draft.text === 'string' && d.draft.text.trim()
        ? {
            text: d.draft.text,
            by: d.draft.by ?? '匿名',
            at: d.draft.at ?? null,
            submission: d.draft.submission ?? null,
          }
        : null,
    items: (Array.isArray(d.items) ? d.items : [])
      .map((row) => normalizeItemRow(row))
      .filter(Boolean),
  };
}

/**
 * 应用一条审核通过的投稿（就地修改 doc）。
 * `sub.part`（可选，1 起）= 一次多节投稿里的第几节：写进 note 当 id 的一部分，
 * 这样「修订这条」改的是这一节，而不是同一次投稿里的第一节。
 * @returns {{field: string, from: unknown, to: unknown}} 改动摘要，用于 git 提交信息
 */
export function applySubmission(doc, sub) {
  const at = new Date(sub.reviewedAt ?? Date.now()).toISOString();
  const by = sub.submitter || '匿名';

  /*
   * 作者申请删除（2026-10-19 站长要求）：作者对**自己已上线**的内容点「申请删除」，
   * 审核通过后走到这里 —— 把那条内容从社区文件里移除。
   *   · note 字段：按 reviseOf（note 的公开 id 就是原投稿 id）定位并删掉那一条；
   *   · 神器 / 道具：按行名删掉作者投的那些行；
   *   · 整篇草稿：删掉草稿本身；
   *   · 其它字段（标签 / 难度 / 人数 / 别名 / 视频…）：移除社区覆盖，回到资料原值。
   * 找不到目标时不静默：log 记一笔，审核台能看出为什么没变化。
   */
  if (sub.remove) {
    if (isNoteField(sub.field)) {
      const reviseId = isReviseId(sub.reviseOf) ? String(sub.reviseOf).trim() : '';
      const i = reviseId ? findNoteIndex(doc.notes, reviseId) : -1;
      if (i >= 0) {
        const [gone] = doc.notes.splice(i, 1);
        doc.log.push({
          field: sub.field,
          from: gone?.text ?? null,
          to: null,
          by,
          at,
          submission: sub.id ?? null,
          removed: true,
        });
        return { field: sub.field, from: gone?.text ?? null, to: null, removed: true };
      }
      doc.log.push({
        field: sub.field,
        from: null,
        to: null,
        by,
        at,
        submission: sub.id ?? null,
        note: `删除目标 ${reviseId || '(空)'} 已不在，未改动`,
      });
      return { field: sub.field, removed: false };
    }
    if (isItemField(sub.field)) {
      const names = new Set(
        (Array.isArray(sub.value) ? sub.value : [])
          .map((row) => itemKey(row?.name))
          .filter(Boolean)
      );
      const before = Array.isArray(doc.items) ? doc.items.length : 0;
      doc.items = (Array.isArray(doc.items) ? doc.items : []).filter((row) => !names.has(itemKey(row?.name)));
      doc.log.push({ field: sub.field, from: before, to: doc.items.length, by, at, submission: sub.id ?? null, removed: true });
      return { field: sub.field, from: before, to: doc.items.length, removed: true };
    }
    if (isDocField(sub.field)) {
      const prev = doc.draft ?? null;
      doc.draft = null;
      doc.log.push({ field: sub.field, from: prev?.by ?? null, to: null, by, at, submission: sub.id ?? null, removed: true });
      return { field: sub.field, from: prev?.text ?? null, to: null, removed: true };
    }
    const prev = doc.fields?.[sub.field]?.v ?? null;
    if (doc.fields) delete doc.fields[sub.field];
    doc.log.push({ field: sub.field, from: prev, to: null, by, at, submission: sub.id ?? null, removed: true });
    return { field: sub.field, from: prev, to: null, removed: true };
  }

  if (isNoteField(sub.field)) {
    /* 修订：把目标那条的正文换掉（署名仍然是原作者，另记是谁在什么时候改的）。
       找不到目标（投稿人提交后这一条被别人删了 / 文件被手改过）就**降级为追加**：
       内容不能丢，log 里写明原因，审核台看到的是「新增」而不是静默失败。 */
    const reviseId = isReviseId(sub.reviseOf) ? String(sub.reviseOf).trim() : '';
    if (reviseId) {
      const i = findNoteIndex(doc.notes, reviseId);
      if (i >= 0) {
        const prev = doc.notes[i];
        doc.notes[i] = {
          ...prev,
          text: sub.value,
          /* 社区整理（titledtext）连标题一起改；普通长文本没有 title，保持原样 */
          ...(sub.title ? { title: sub.title } : {}),
          revisedBy: by,
          revisedAt: at,
          revision: (Number.isInteger(prev.revision) ? prev.revision : 0) + 1,
        };
        doc.log.push({
          field: sub.field,
          from: prev.text,
          to: sub.value,
          by,
          at,
          submission: sub.id ?? null,
          reviseOf: reviseId,
        });
        return { field: sub.field, from: prev.text, to: sub.value, revised: true };
      }
      doc.log.push({
        field: sub.field,
        from: null,
        to: null,
        by,
        at,
        submission: sub.id ?? null,
        note: `修订目标 ${reviseId} 已不在，按新增处理`,
      });
    }
    /* note 里记下**它原本投的是哪个字段**（story / body / section…）：
       页面据此分块显示 —— 投「背景故事」的内容如果出现在「社区补充」里，
       投稿人会以为稿子丢了（2026-09-28 的反馈）。log 里本来也有这个信息，
       但渲染只读 notes，所以得在 note 上存一份。
       「社区整理」（titledtext）另外带上投稿人自己起的小节标题。 */
    /* 2026-10-22：story / summary / guide / body 这类「一段话」改成最新覆盖旧的，
       不再一层层追加（同一张图出现两条一模一样的背景故事，读者会以为是两版内容）。
       社区整理（section）仍然按节追加，不动。 */
    const REPLACE_NOTE_FIELDS = new Set(['story', 'summary', 'guide', 'body']);
    if (REPLACE_NOTE_FIELDS.has(sub.field)) {
      const oldNotes = doc.notes.filter((n) => n.field === sub.field);
      if (oldNotes.length) {
        doc.notes = doc.notes.filter((n) => n.field !== sub.field);
        doc.log.push({
          field: sub.field,
          from: oldNotes.map((n) => n.text).join('\n\n'),
          to: sub.value,
          by,
          at,
          submission: sub.id ?? null,
          note: `覆盖 ${oldNotes.length} 条旧社区投稿`,
        });
      }
    }
    doc.notes.push({
      text: sub.value,
      by,
      at,
      submission: sub.id ?? null,
      field: sub.field,
      ...(sub.title ? { title: sub.title } : {}),
      /* 多节投稿里的节号（见 notePublicId）：同一编号的多条 note 靠它区分 */
      ...(Number.isInteger(sub.part) && sub.part > 0 ? { part: sub.part } : {}),
    });
    doc.log.push({ field: sub.field, from: null, to: null, by, at, submission: sub.id ?? null });
    return { field: sub.field, from: null, to: sub.value };
  }

  /* 神器 / 道具：逐行合并。同名行以最后一次审核通过为准（投稿人会先看到旧值再改） */
  if (isItemField(sub.field)) {
    const incoming = (Array.isArray(sub.value) ? sub.value : [])
      .map((row) => normalizeItemRow(row, { by, at, submission: sub.id ?? null }))
      .filter(Boolean);
    if (!Array.isArray(doc.items)) doc.items = [];
    const applied = [];
    for (const row of incoming) {
      const key = itemKey(row.name);
      const i = doc.items.findIndex((x) => itemKey(x.name) === key);
      if (i >= 0) doc.items[i] = row;
      else doc.items.push(row);
      applied.push(row);
    }
    doc.log.push({ field: sub.field, from: null, to: applied.length, by, at, submission: sub.id ?? null });
    return { field: sub.field, from: null, to: applied };
  }

  /*
   * 整篇草稿（kind=doc）：进 doc.draft，**一张图只保留最新一篇**（旧的在 log 里留痕）。
   * 为什么只留一篇：页面上同时挂两三个「社区整理版」没人看得下去，站长也无从比较；
   * 谁想改，就在最新那篇上继续（投稿页会把现有草稿带进框里，和「修订这条」一个思路）。
   */
  if (isDocField(sub.field)) {
    const prev = doc.draft ?? null;
    doc.draft = { text: String(sub.value ?? ''), by, at, submission: sub.id ?? null };
    doc.log.push({
      field: sub.field,
      from: prev ? `${String(prev.text ?? '').length} 字（${prev.by ?? '匿名'}）` : null,
      to: `${String(sub.value ?? '').length} 字`,
      by,
      at,
      submission: sub.id ?? null,
    });
    return { field: sub.field, from: prev?.text ?? null, to: sub.value, draft: true };
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
  for (const row of doc?.items ?? []) {
    if (row?.by && !seen.includes(row.by)) seen.push(row.by);
  }
  /* 整篇草稿的作者也是贡献者（2026-10-13 加） */
  if (doc?.draft?.by && !seen.includes(doc.draft.by)) seen.push(doc.draft.by);
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
  return Boolean(
    doc &&
      (Object.keys(doc.fields ?? {}).length > 0 ||
        (doc.notes ?? []).length > 0 ||
        (doc.items ?? []).length > 0 ||
        /* 整篇草稿也算内容：一张只投了草稿的图，社区那一块（含「社区整理版」）要能渲染出来 */
        doc.draft?.text)
  );
}
