/**
 * research 正文（生成器写出的 MDX 正文）→ 页面 / 编辑器共用的小节模型。
 *
 * 为什么集中在这里：
 * 详情页与编辑页必须看到同一份基线。以前详情页自己切一遍、编辑页又切一遍，
 * 结果编辑页把整篇正文（含 `{/* generated *\/}`、工坊自述、神器表）塞进第一个
 * 攻略条目里，玩家以为攻略正文就是整页内容。
 *
 * 生成器只负责 frontmatter、自动数据与折叠附录；正文里的标题决定块归属：
 *   背景 / 剧情 / 故事            → story
 *   简介 / 摘要 / 概览            → intro（没有时用开头摘要）
 *   关卡 / 玩法 / 流程            → gameplay（表格另抽成 stageRows）
 *   攻略 / 策略 / 常见问题 / 教程 → guide
 *   神器 / 道具                   → items（结构化字段，不进正文）
 *   工坊自述 / 数据 / 实体 / 来源 → 附录（不在详情正文与编辑器基线出现）
 */

const MDX_COMMENT_RE = /\{\/\*[\s\S]*?\*\/\}/g;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const IMPORT_EXPORT_RE = /^\s*(?:import|export)\b[^\n]*$/gm;

const STORY_RE = /背景|剧情|故事|地图.{0,8}绘制/;
const INTRO_RE = /简介|摘要|概览|介绍/;
const ITEMS_RE = /神器\s*\/\s*道具|神器表|道具表|^神器$|^道具$/;
const GAMEPLAY_RE = /关卡|玩法|流程|版本历史|更新日志/;
const GUIDE_RE = /攻略|策略|常见问题|神器讲解|教程|技巧|注意事项/;
const APPENDIX_RE = /工坊|自述|音乐|BOSS|来源|数据说明|数据概况|实体|社区评价|社区补充|社区整理|素材|致谢|版权/;

/** 去掉 MDX / JSX 噪音；正文里不能出现可编辑的生成器注释。 */
export function stripMdxNoise(input) {
  return String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(MDX_COMMENT_RE, '')
    .replace(HTML_COMMENT_RE, '')
    .replace(IMPORT_EXPORT_RE, '')
    .replace(/<[^>]*>/g, '')
    .trim();
}

const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** 行内 Markdown / HTML → 纯文本（保留换行交给调用方） */
export function cleanInline(input) {
  return String(input ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+[.)]\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (entity) => ENTITIES[entity])
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function rowsOf(raw) {
  const rows = [];
  for (const line of String(raw ?? '').split('\n')) {
    if (/^\s*\|/.test(line) && !/^\s*\|\s*:?-{2,}/.test(line)) {
      const cells = line
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((cell) => cleanInline(cell));
      if (cells.some(Boolean)) rows.push(cells);
    }
    const row = line.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/i);
    if (row) {
      const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => cleanInline(cell[1]));
      if (cells.some(Boolean)) rows.push(cells);
    }
  }
  return rows;
}

const STAGE_HEADER = ['关卡', '名称', '关卡内容'];
const STAGE_FLOW_TITLE_RE = /(关卡|玩法|流程)/;
const NOT_STAGE_TITLE_RE = /(版本|更新|历史|日志)/;

/**
 * `<StageAccordion>` 里的一节：整段内容保持自由文本，不再拆成「目标 / 路线 / 神器 / 团灭点」。
 * 编辑页因此只需要一个 textarea；详情页也按原文换行展示。
 */
function htmlToPlainText(input) {
  return String(input ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]*>/g, '')
    .replace(/\r\n?/g, '\n');
}

function stageRowFromDetails(block) {
  const num = cleanInline(/<span[^>]*class="stage-num"[^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1] ?? '');
  const name = cleanInline(/<span[^>]*class="stage-name"[^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1] ?? '');
  const body = /<div[^>]*class="stage-body"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ?? '';
  const text = htmlToPlainText(body)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return [num || '关卡', name, text];
}

/** 从一段 `## 关卡流程` 正文里抽 `<StageAccordion>` 的 details；没有就返回 [] */
function stageRowsFromAccordion(raw) {
  const body = /<StageAccordion>([\s\S]*?)<\/StageAccordion>/i.exec(String(raw ?? ''))?.[1] ?? '';
  if (!body) return [];
  const details = [...body.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/gi)].map((match) => match[1]);
  if (!details.length) return [];
  return [STAGE_HEADER, ...details.map(stageRowFromDetails)];
}

/** 普通图的双列表 / 六列表头（关卡 / 名称 / 目标 / 路线 / 神器 / 团灭点）→ 自由文本 */
function stageRowsFromTable(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const header = rows[0];
  const bodyRows = rows.slice(1).map((row) => {
    const parts = [];
    for (let column = 2; column < Math.max(3, row.length); column++) {
      const value = String(row[column] ?? '').trim();
      if (!value) continue;
      const label = String(header?.[column] ?? '').trim() || ['', '', '目标', '关键路线', '神器 / 道具', '团灭点 / 备注'][column] || '内容';
      parts.push(`${label}：${value}`);
    }
    return [row[0] ?? '', row[1] ?? '', parts.join('\n\n')];
  }).filter((row) => row[0] || row[1] || row[2]);
  return bodyRows.length ? [STAGE_HEADER, ...bodyRows] : [];
}

function paragraphsOf(raw) {
  const withoutTables = String(raw ?? '').replace(/<table[\s\S]*?<\/table>/gi, '');
  const withoutRows = withoutTables
    .split('\n')
    .filter((line) => !/^\s*\|/.test(line))
    .join('\n');
  return withoutRows
    .split(/\n\s*\n/)
    .map((part) => cleanInline(part))
    .filter(Boolean);
}

/** 标题 → 归属；顺序有讲究（“神器讲解”归攻略，“神器 / 道具”才归神器表）。 */
export function classifyResearchSection(title) {
  const value = cleanInline(title);
  if (!value) return 'appendix';
  if (STORY_RE.test(value)) return 'story';
  if (INTRO_RE.test(value)) return 'intro';
  if (ITEMS_RE.test(value)) return 'items';
  if (GAMEPLAY_RE.test(value)) return 'gameplay';
  if (GUIDE_RE.test(value)) return 'guide';
  if (APPENDIX_RE.test(value)) return 'appendix';
  /* 认不出来的手写小节先当附录，避免把元数据塞进攻略正文。 */
  return 'appendix';
}

/**
 * @returns {{
 *   summary: string,
 *   story: string,
 *   intro: string,
 *   gameplay: string,
 *   stageRows: string[][],
 *   guides: Array<{ title: string, text: string }>,
 *   appendix: Array<{ title: string, text: string }>,
 * }}
 */
export function parseResearchBody(input) {
  /*
   * `<StageAccordion>` 的结构必须在 stripMdxNoise 之前抓下来 —— 那一步会把所有 HTML
   * 标签（包括 details / summary）一起删掉，之后再想按关卡拆就晚了。
   * 抓完把整块从正文里拿掉，避免它被压成一大段平铺文字塞进 gameplay。
   */
  const source = String(input ?? '');
  const accordionBlocks = [...source.matchAll(/<StageAccordion>[\s\S]*?<\/StageAccordion>/gi)].map((match) => match[0]);
  const text = stripMdxNoise(source.replace(/<StageAccordion>[\s\S]*?<\/StageAccordion>/gi, ''));
  if (!text) return { summary: '', story: '', intro: '', gameplay: '', stageRows: [], guides: [], appendix: [] };

  /* 前面补一个换行：正文如果直接从 `## 标题` 开始，也要把它当小节而不是摘要。 */
  const chunks = `\n${text}`.split(/\n(?=#{1,3}\s+)/);
  const summary = paragraphsOf(chunks[0] ?? '').join('\n\n');

  const story = [];
  const intro = [];
  const gameplay = [];
  const accordionRows = [];
  for (const block of accordionBlocks) {
    const parsed = stageRowsFromAccordion(block);
    if (parsed.length > 1) accordionRows.push(...parsed.slice(1));
  }
  const stageRows = accordionRows.length ? [STAGE_HEADER, ...accordionRows] : [];
  const guides = [];
  const appendix = [];

  for (const chunk of chunks.slice(1)) {
    const heading = chunk.match(/^#{1,3}\s+([^\n]+)\n?/);
    if (!heading) continue;
    const title = cleanInline(heading[1]);
    const raw = chunk.slice(heading[0].length);
    const kind = classifyResearchSection(title);
    const paragraphs = paragraphsOf(raw);
    if (kind === 'story') story.push(...paragraphs);
    else if (kind === 'intro') intro.push(...paragraphs);
    else if (kind === 'gameplay') {
      gameplay.push(...paragraphs);
      /*
       * 有 StageAccordion 时，关卡已经按 details 拆好了，不要再把这一节里的表
       * （尤其是「版本历史」「难度分级」）当成关卡表；没有 accordion 的普通图才抽表。
       */
      if (!accordionRows.length && STAGE_FLOW_TITLE_RE.test(title) && !NOT_STAGE_TITLE_RE.test(title)) {
        stageRows.push(...stageRowsFromTable(rowsOf(raw)));
      }
    } else if (kind === 'guide') {
      guides.push({ title, text: paragraphs.join('\n\n') });
    } else if (kind === 'appendix') {
      appendix.push({ title, text: paragraphs.join('\n\n') });
    }
    /* items 由统一读取层用 gfl + 神器表结构化字段提供，不进正文。 */
  }

  return {
    summary,
    story: story.join('\n\n'),
    intro: intro.join('\n\n'),
    gameplay: gameplay.join('\n\n'),
    stageRows,
    guides: guides.filter((guide) => guide.text),
    appendix: appendix.filter((section) => section.text),
  };
}

/** ProseMirror doc → 纯文本（编辑页从玩家覆盖恢复基线时用） */
export function docToText(doc) {
  const walk = (node) => {
    if (!node) return '';
    if (node.type === 'text') return String(node.text ?? '');
    if (node.type === 'hardBreak') return '\n';
    const body = (node.content ?? []).map(walk).join('');
    if (node.type === 'paragraph' || node.type === 'heading') return `${body}\n\n`;
    if (node.type === 'listItem') return `${body}\n`;
    return body;
  };
  return String(walk(doc).replace(/\n{3,}/g, '\n\n')).trim();
}
