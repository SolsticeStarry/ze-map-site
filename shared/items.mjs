/**
 * 神器 / 道具行的归一与合并 —— 站点生成器、投稿表单、审核台共用一份。
 *
 * 为什么是「逐行合并」而不是「整表替换」：
 * 条目里的神器表来自公开的服务器配置（data/gfl-parsed，目前只有 GFL 一份），
 * 玩家在别的服看到的、或者干脆发现本站抄错的地方，都只能一行一行改。
 * 如果允许整表替换，这张表就会变成「既不是 GFL、也不是别服」的第三份数据，
 * 谁也说不清它对不对 —— 所以原值一律保留在备注里，来源逐行标注。
 *
 * 数据流向：
 *   投稿（/submit/，字段 items）→ D1 → 审核 → data/community/<slug>.json 的 items[]
 *   → 生成器用 mergeItems() 合并进条目正文的「神器 / 道具」表
 */

/** 投稿里这三种动作；键会进 JSON、进日志，别随意改名 */
export const ITEM_ACTIONS = { update: '更正', add: '新增', remove: '删除' };

/** 名称比对用的归一：全角空格、大小写、首尾空白都不该造成「新增了一件」 */
export function itemKey(name) {
  return String(name ?? '')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 冷却显示：配置里 0（或没写）就是没有冷却 */
export const cdText = (cd) => (Number.isFinite(cd) && cd > 0 ? `${cd} 秒` : '—');

/** 次数显示：entwatch 里 maxuses=0 表示不限次数 */
export const usesText = (uses) => (Number.isFinite(uses) && uses > 0 ? `${uses} 次` : '不限');

/** 冷却 / 次数这类可选整数：空值 → null（表示投稿人没改这一项） */
export function intOrNull(v) {
  const n = numOrNull(v);
  return n !== null && Number.isInteger(n) ? n : null;
}

/**
 * 可选数字：空值 → null。
 * 冷却**允许小数** —— 服务器配置里真的存在 4.5 / 2.5 秒这种值（ze_dark_souls 一整排都是），
 * 只收整数的后果是把它们显示成「—」，等于把配置里的信息抹掉。
 */
export function numOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 把任意来源（投稿值、仓库里的 JSON、人手改过的文件）规整成一行。
 * 认不出来就返回 null，由调用方丢弃 —— 构建期不该因为一行坏数据整页崩掉。
 */
export function normalizeItemRow(raw, extra = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw;
  const name = String(row.name ?? '')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return null;
  const action =
    typeof row.action === 'string' && Object.prototype.hasOwnProperty.call(ITEM_ACTIONS, row.action)
      ? row.action
      : 'update';
  return {
    action,
    name,
    cd: numOrNull(row.cd),
    uses: intOrNull(row.uses),
    note: String(row.note ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
    by: String(extra.by ?? row.by ?? '').trim(),
    at: extra.at ?? row.at ?? null,
    submission: extra.submission ?? row.submission ?? null,
  };
}

/**
 * 把社区投稿行合并到服务器配置的基表上。
 *
 * @param base 服务器配置：[{ name, cd, maxuses }]
 * @param rows 社区行：[{ action, name, cd, uses, note, by }]
 * @returns {{ rows: Array, changed: number }}
 *   rows[].kind：
 *     server   服务器配置原样
 *     updated  社区更正（original 里留着原值）
 *     added    社区补充（服务器配置里没有）
 *     removed  社区反馈「本图没有这件道具」（原行保留，只是标注）
 */
export function mergeItems(base = [], rows = []) {
  const out = (Array.isArray(base) ? base : []).map((it) => ({
    name: String(it?.name ?? '').trim(),
    cd: numOrNull(it?.cd),
    uses: intOrNull(it?.maxuses),
    kind: 'server',
    note: '',
    by: '',
    original: null,
  })).filter((r) => r.name);

  const index = new Map(out.map((r) => [itemKey(r.name), r]));
  let changed = 0;

  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = normalizeItemRow(raw);
    if (!row) continue;
    const hit = index.get(itemKey(row.name));

    /* 同名就是同一件道具：就算投稿人点了「新增」，也按更正处理，避免表里出现两行同名 */
    if (hit) {
      hit.by = row.by;
      if (row.action === 'remove') {
        hit.kind = 'removed';
        hit.note = row.note;
      } else {
        hit.original = { cd: hit.cd, uses: hit.uses };
        if (row.cd !== null) hit.cd = row.cd;
        if (row.uses !== null) hit.uses = row.uses;
        hit.kind = 'updated';
        hit.note = row.note;
      }
      changed++;
      continue;
    }

    /* 基表里没有：追加一行（基表为空时整张表都由社区提供） */
    out.push({
      name: row.name,
      cd: row.cd,
      uses: row.uses,
      kind: 'added',
      note: row.note,
      by: row.by,
      original: null,
    });
    changed++;
  }

  return { rows: out, changed };
}
