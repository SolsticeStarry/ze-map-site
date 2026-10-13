/**
 * 把「整篇条目草稿」合并进人工原稿（`data/research/<slug>.json`）—— 2026-10-13 加。
 *
 * 为什么单独一份：采纳（审核台点「采纳为原稿」）只该有**一处**实现，而它涉及三条规则：
 *
 *   1. **按小节合并，不是整篇替换。** 草稿里写到的 `## 小节` 替换原稿里的同名小节，
 *      没写到的小节**原样保留**（顺序也不动），草稿里的新小节追加到末尾。
 *      这样「只改关卡流程一节」和「整篇重写」用的是同一条路径，也不会顺手删掉别人写的内容。
 *   2. **导语 → 简介。** 第一个 `##` 之前的那段文字（如果有）作为条目的 `summary`。
 *   3. **台账字段不撒谎。** 采纳后 `confidence` 至少是 `medium`（社区整理 + 站长采纳），
 *      但不动 `verified` —— 那是站长逐条核对过的标记，得他自己再确认。
 *
 * 纯函数，好测；写文件、commit 那些在 worker/submissions.ts 的采纳分支里。
 */
import { parseDoc } from './submission-fields.mjs';

/**
 * @param {object} research 现有原稿（JSON.parse 的结果）
 * @param {string} draftText 草稿正文
 * @returns {{next: object, summary: string, replaced: string[], added: string[], kept: string[]}}
 */
export function mergeDraft(research, draftText) {
  const base = research && typeof research === 'object' ? research : {};
  const { intro, sections } = parseDoc(String(draftText ?? ''));

  const oldSections = (Array.isArray(base.sections) ? base.sections : []).filter(
    (s) => s && typeof s.title === 'string' && s.title.trim(),
  );
  const byTitle = new Map();
  for (const s of sections) byTitle.set(s.title.trim(), s);

  const replaced = [];
  const kept = [];
  const merged = oldSections.map((s) => {
    const title = s.title.trim();
    const hit = byTitle.get(title);
    if (!hit) {
      kept.push(title);
      return s;
    }
    replaced.push(title);
    return { title, body: hit.body };
  });

  const existing = new Set(oldSections.map((s) => s.title.trim()));
  const added = [];
  for (const s of sections) {
    const title = s.title.trim();
    if (existing.has(title)) continue;
    merged.push({ title, body: s.body });
    added.push(title);
  }

  const next = { ...base };
  if (intro) next.summary = intro;
  next.sections = merged;

  /* confidence：low/缺失 → medium；已经是 high 的不动（别把人家核对过的等级拉下来） */
  if (next.confidence !== 'high') next.confidence = 'medium';

  return { next, summary: intro, replaced, added, kept };
}

/**
 * 把对象写回成 JSON 文本，**沿用原文件的行首缩进**。
 * 原稿是人手写的，缩进有 1 空格也有 2 空格；采纳一次就把整份文件重排会制造一屏无意义的 diff
 * （审阅时看不清到底改了什么）。所以探测原文件缩进，只重新序列化，格式跟原来一致。
 */
export function serializeResearch(obj, originalText) {
  const indent = /\r?\n( +)"/.exec(String(originalText ?? ''))?.[1] ?? '  ';
  const eol = String(originalText ?? '').includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(obj, null, indent.length).replace(/\n/g, eol) + eol;
}
