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
 *   单项补充（/submit/edit，字段 items）或整页编辑 → page_revisions → 审核
 *   → data/content/<slug>.json 的 itemEdits[] → 生成器用 mergeItems() 合并进「神器 / 道具」表
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
    /* 神器表「说明」列的一句话介绍（社区投稿可改，站长也能直接写进原稿的 relicIntros） */
    intro: String(row.intro ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
    by: String(extra.by ?? row.by ?? '').trim(),
    at: extra.at ?? row.at ?? null,
    submission: extra.submission ?? row.submission ?? null,
  };
}

/**
 * 从手写资料（data/research/<slug>.json 的 document）里抽出「神器 / 道具」表里的条目。
 *
 * 为什么需要它：有三张图（魔晄炉、米纳斯、黑珍珠号）的神器表是人工整理后写进正文的
 * （HTML `<table class="item-table">`），本站没有对应的服务器配置。投稿表单如果只认
 * `data/gfl-parsed`，就会对着这些图说「本站还没有这张图的神器表」——
 * 而页面上明明摆着一张表，投稿人当场就懵了（2026-09-28 的反馈）。
 *
 * 认出手写表的名称、说明、备注和分数；分数并进备注，避免丢信息。
 * 名字取哪一列：中文列 + 英文名/ID 列并存时（火焰 | Fire）取英文列，否则取第一列。
 */
/**
 * 从 research 正文的「神器 / 道具」表里抽出完整行（名称 / 冷却 / 次数 / 说明 / 备注）。
 * 详情页和编辑页都需要这份“人写的说明”；只认名字的 docItemRows() 不够。
 */
export function docItemDetails(text) {
  /* 手写表常把 <tr> / <th> 拆成多行；先压成单行，否则表头认不出来，只剩名字。 */
  const src = String(text ?? '').replace(/<tr\b[\s\S]*?<\/tr>/gi, (row) => row.replace(/\r?\n/g, ' '));
  if (!src) return [];
  const rows = [];
  let active = false;
  let level = 0;
  let header = null;

  const parsePipe = (line) =>
    line
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((cell) => String(cell ?? '').trim());

  const headerOf = (cells) => {
    const keys = cells.map((cell) => itemKey(cell));
    const find = (...names) => keys.findIndex((key) => names.includes(key));
    /* 人工表有三种写法：GFL 导出的「道具 / 冷却 / 使用次数 / 说明 / 备注」，
       以及米纳斯这类手写表「神器 / 分数 / 效果 / 备注」。都要认。 */
    const name = find('道具', '名称', '英文名', 'item', 'name', '神器');
    const cd = find('冷却', 'cd', 'cooldown');
    const uses = find('使用次数', '次数', 'uses', 'maxuses');
    const intro = find('说明', '介绍', 'intro', 'description', '效果', '作用');
    const note = find('备注', 'note', '持有建议', '建议');
    const score = find('分数', 'score');
    return name >= 0 || cd >= 0 || intro >= 0 ? { name, cd, uses, intro, note, score } : null;
  };

  const rowOf = (cells) => {
    const value = (index) => (index >= 0 ? String(cells[index] ?? '').trim() : '');
    const nameCell = value(header?.name ?? 0);
    if (!nameCell || /^(神器|道具|名称|英文名|item|name)$/i.test(nameCell)) return null;
    if (/^-+$/.test(nameCell) || cells.every((cell) => !cell || /^:?-+:?$/.test(cell))) return null;
    const cdText = value(header?.cd ?? -1);
    const usesText = value(header?.uses ?? -1);
    const cd = cdText ? Number((/(\d+(?:\.\d+)?)/.exec(cdText) ?? [])[1]) : null;
    const uses = /不限/.test(usesText) ? 0 : usesText ? Number((/(\d+)/.exec(usesText) ?? [])[1]) : null;
    const score = value(header?.score ?? -1);
    const note = [score ? `分数 ${score}` : '', value(header?.note ?? -1)].filter(Boolean).join(' · ');
    return {
      action: 'update',
      name: nameCell,
      cd: Number.isFinite(cd) ? cd : null,
      uses: Number.isFinite(uses) ? uses : null,
      intro: value(header?.intro ?? -1) === '待补充' ? '' : value(header?.intro ?? -1),
      note,
    };
  };

  for (const line of src.split(/\r?\n/)) {
    const heading = line.match(/^(#{2,4})\s+(.*)$/);
    if (heading) {
      if (/(神器|道具)/.test(heading[2])) {
        active = true;
        level = heading[1].length;
      } else if (active && heading[1].length <= level) {
        active = false;
      }
      continue;
    }
    if (!active) continue;

    let cells = null;
    const html = line.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/i);
    if (html) cells = cellsOfHtml(html[1]);
    else if (/^\s*\|/.test(line)) cells = parsePipe(line);
    if (!cells) continue;

    if (!header) {
      const found = headerOf(cells);
      if (found) {
        header = found;
        continue;
      }
    }
    const row = rowOf(cells);
    if (row) rows.push(row);
  }

  const seen = new Set();
  return rows.filter((row) => {
    const key = itemKey(row.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function docItemRows(text) {
  const src = String(text ?? '');
  if (!src) return [];

  const rows = [];
  let active = false;
  let level = 0;

  for (const line of src.split(/\r?\n/)) {
    const heading = line.match(/^(#{2,4})\s+(.*)$/);
    if (heading) {
      if (/(神器|道具)/.test(heading[2])) {
        active = true;
        level = heading[1].length;
      } else if (active && heading[1].length <= level) {
        active = false; /* 同级或更高级标题 = 这一节结束 */
      }
      continue;
    }
    if (!active) continue;

    const html = line.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/i);
    if (html) {
      rows.push(cellsOfHtml(html[1]));
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const cells = line
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((s) => stripInline(s));
      /* 表头分隔行 |---|---| 与表头本身都会被过滤掉（认不出名字） */
      rows.push(cells);
    }
  }

  const out = [];
  const seen = new Set();
  for (const cells of rows) {
    const row = pickDocRow(cells);
    if (!row) continue;
    const key = itemKey(row.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** HTML 表格的 <td> 组合 → 纯文本单元格 */
function cellsOfHtml(inner) {
  const cells = [];
  for (const m of inner.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) cells.push(stripInline(m[1]));
  return cells;
}

/** 去掉行内标签与常见实体，压掉多余空白 */
function stripInline(s) {
  return String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const CJK_RE = /[\u3400-\u9fff]/;
const CD_RE = /^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds|秒)$/i;

/** 一行单元格 → { name, label, cd }；认不出来返回 null */
function pickDocRow(cells) {
  const clean = (Array.isArray(cells) ? cells : []).map((c) => String(c ?? '').trim());
  const [first = '', second = ''] = clean;
  if (!first) return null;
  /* 表头行 / 分隔行：第一格就是「神器」「道具」这类标题，或者整行都是横线 */
  if (/^(神器|道具|名称|英文名|item|name)$/i.test(first)) return null;
  if (/^-+$/.test(first) || clean.every((c) => !c || /^:?-+:?$/.test(c))) return null;

  const secondIsId = Boolean(second) && !CJK_RE.test(second) && /[A-Za-z]/.test(second);
  const name = CJK_RE.test(first) && secondIsId ? second : first;
  const label = name === first ? '' : first;

  const cdCell = clean.slice(1).find((c) => CD_RE.test(c));
  const cd = cdCell ? Number(cdCell.match(CD_RE)[1]) : null;
  return { name, label, cd };
}

/**
 * 把社区投稿行合并到服务器配置的基表上。
 *
 * @param base 服务器配置：[{ name, cd, maxuses }]
 * @param rows 社区行：[{ action, name, cd, uses, note, by }]
 * @returns {{ rows: Array, changed: number, removed: string[], unmatched: string[] }}
 *   rows[].kind：
 *     server   服务器配置原样
 *     updated  社区更正（original 里留着原值）
 *     added    社区补充（服务器配置里没有）
 *     removed  社区反馈「本图没有这件」→ **渲染时整行不出现**（见下面的说明）
 *   unmatched：删除了一份表里根本没有的名字（打错字、或原表已经改过）——
 *     既不能删、更不能当成「新增一件」，交给调用方去提示。
 */
export function mergeItems(base = [], rows = []) {
  const out = (Array.isArray(base) ? base : []).map((it) => ({
    name: String(it?.name ?? '').trim(),
    cd: numOrNull(it?.cd),
    uses: intOrNull(it?.maxuses),
    kind: 'server',
    note: '',
    /* 服务器配置里没有「说明」—— 那一列只有人写（原稿 relicIntros 或社区投稿的 intro） */
    intro: '',
    by: '',
    original: null,
  })).filter((r) => r.name);

  const index = new Map(out.map((r) => [itemKey(r.name), r]));
  let changed = 0;
  const unmatched = [];

  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = normalizeItemRow(raw);
    if (!row) continue;
    const hit = index.get(itemKey(row.name));

    /* 同名就是同一件道具：就算投稿人点了「新增」，也按更正处理，避免表里出现两行同名 */
    if (hit) {
      hit.by = row.by;
      if (row.action === 'remove') {
        /*
         * 删除（2026-10-14 改口径）：以前只是把这一行标成「社区反馈：本图没有这件道具」，
         * 行还留在表里 —— 于是「20 件」的表里躺着 10 行英文名 + 10 行中文名（它们是同一批神器），
         * 站长问「为什么删不掉」。现在 kind 仍记 removed（留痕、可回滚），
         * 但**渲染层整行不出现**，只在表下留一句「社区反馈本图没有这 N 件」。
         * 原值不会丢：社区文档里有这条投稿、git 历史里有原表，改主意把这条驳回/撤掉即可。
         */
        hit.kind = 'removed';
        hit.note = row.note;
      } else {
        hit.original = { cd: hit.cd, uses: hit.uses };
        if (row.cd !== null) hit.cd = row.cd;
        if (row.uses !== null) hit.uses = row.uses;
        /* 说明是「逐行盖上」：社区写了就以社区的为准（审核已过），没写就保持原样 */
        if (row.intro) hit.intro = row.intro;
        hit.kind = 'updated';
        hit.note = row.note;
      }
      changed++;
      continue;
    }

    /*
     * 基表里没有这一行。删除要单独处理（2026-10-14 修）：
     * 以前不管什么动作都往表里追加，于是「删除一个表里没有的名字」会**凭空多出一件道具**
     * （cd/次数都是空）—— 打错一个字就变成这种鬼数据。现在记进 unmatched，交给调用方提示。
     */
    if (row.action === 'remove') {
      unmatched.push(row.name);
      continue;
    }
    /* 追加一行（基表为空时整张表都由社区提供），并登记进索引 ——
       这样**同一批里后来的行**还能命中它（例如先补一件、再把它删掉）。 */
    const added = {
      name: row.name,
      cd: row.cd,
      uses: row.uses,
      kind: 'added',
      note: row.note,
      intro: row.intro,
      by: row.by,
      original: null,
    };
    out.push(added);
    index.set(itemKey(added.name), added);
    changed++;
  }

  return {
    rows: out,
    changed,
    removed: out.filter((r) => r.kind === 'removed').map((r) => r.name),
    unmatched,
  };
}

/** 渲染时要显示的行（removed 的整行不出现；见 mergeItems 的说明） */
export const visibleItemRows = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r?.kind !== 'removed');
