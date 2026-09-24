#!/usr/bin/env node
/**
 * 校验 data/research/*.json（线上检索资料）的质量与格式，避免把可疑内容带上线。
 *   node scripts/content/verify-research.mjs
 *   node scripts/content/verify-research.mjs --fix-tags   # 顺带把非法标签字符替换掉
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIFFICULTIES } from '../../shared/difficulty.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'data/research');
const FIX = process.argv.includes('--fix-tags');

// 难度枚举与站点/Worker 共用一份定义（shared/difficulty.mjs），别再这里硬编码
const DIFFS = DIFFICULTIES.filter((d) => d !== '未知');
const BAD_PHRASES = ['根据搜索结果', '我查到', '作为AI', '作为 AI', '以下是', '综上所述，我们', '无法访问'];
const SAFE_TAG = (t) => String(t || '').replace(/[\\/:*?"<>|#%]/g, '·').replace(/\s+/g, ' ').trim().slice(0, 24);
const isUrl = (u) => /^https?:\/\/\S+$/i.test(String(u || ''));

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'priority.json');
const errors = [];
const warns = [];
let ok = 0, empty = 0, fixed = 0;

for (const file of files) {
  const p = path.join(DIR, file);
  let j;
  try {
    j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    errors.push(`${file}: JSON 解析失败 ${e.message}`);
    continue;
  }
  const slug = file.replace(/\.json$/, '');
  if (j.slug) {
    // 两种写法都接受：地图内部名，或数据分片名（含该地图名即可）
    const okSlug = j.slug === slug || (j.slug.includes(slug) && /^\d+-[a-zA-Z0-9_]+-\d+$/.test(j.slug));
    if (!okSlug) errors.push(`${file}: slug(${j.slug}) 与文件名(${slug}) 对不上`);
  }

  const hasSummary = typeof j.summary === 'string' && j.summary.trim().length > 0;
  if (!hasSummary) {
    empty++;
    if (j.summary === undefined) errors.push(`${file}: 缺少 summary 字段（无资料请写 null）`);
    if (Array.isArray(j.sources) && j.sources.length && !hasSummary) {
      warns.push(`${file}: 没有摘要却带了 ${j.sources.length} 条来源`);
    }
    continue;
  }

  const len = j.summary.trim().length;
  if (len < 80) warns.push(`${file}: 摘要偏短（${len} 字）`);
  if (len > 5000) warns.push(`${file}: 摘要偏长（${len} 字），建议拆分`);

  for (const ph of BAD_PHRASES) {
    if (j.summary.includes(ph)) errors.push(`${file}: 摘要里出现不该有的措辞「${ph}」`);
  }

  if (!Array.isArray(j.sources) || j.sources.length === 0) {
    errors.push(`${file}: 有摘要但没有任何来源链接`);
  } else {
    for (const s of j.sources) if (!isUrl(s)) errors.push(`${file}: 来源不是 http(s) 链接：${String(s).slice(0, 60)}`);
  }
  for (const v of j.videoUrls || []) if (!isUrl(v)) errors.push(`${file}: videoUrls 不是链接：${String(v).slice(0, 60)}`);

  if (j.difficulty && !DIFFS.includes(j.difficulty)) {
    errors.push(`${file}: difficulty「${j.difficulty}」不在允许值内`);
  }
  if (!j.confidence) warns.push(`${file}: 缺少 confidence`);
  else if (!['high', 'medium', 'low'].includes(j.confidence)) errors.push(`${file}: confidence「${j.confidence}」非法`);

  if (Array.isArray(j.tags)) {
    const cleaned = [...new Set(j.tags.map(SAFE_TAG).filter(Boolean))];
    const changed = JSON.stringify(cleaned) !== JSON.stringify(j.tags);
    if (changed) {
      if (FIX) {
        j.tags = cleaned;
        fs.writeFileSync(p, JSON.stringify(j, null, 1));
        fixed++;
      } else {
        errors.push(`${file}: 标签含非法字符或重复（用 --fix-tags 自动修正）：${JSON.stringify(j.tags)}`);
      }
    }
    if (cleaned.length > 8) warns.push(`${file}: 标签偏多（${cleaned.length} 个）`);
  }

  // 摘要里混入 < 或 { 会被 MDX 当 JSX 解析（生成脚本已转义，这里只提醒）
  if (/[<{][^\s]/.test(j.summary)) warns.push(`${file}: 摘要含 < 或 {，生成时会转义（确认不是想写 HTML）`);

  ok++;
}

console.log(`资料文件 ${files.length} 个：有内容 ${ok} · 空条目 ${empty}${FIX ? ` · 已修正标签 ${fixed}` : ''}`);
if (warns.length) {
  console.log(`\n⚠️  提醒 ${warns.length} 条：`);
  for (const w of warns.slice(0, 20)) console.log('   - ' + w);
  if (warns.length > 20) console.log(`   … 另有 ${warns.length - 20} 条`);
}
if (errors.length) {
  console.log(`\n❌ 错误 ${errors.length} 条：`);
  for (const e of errors.slice(0, 30)) console.log('   - ' + e);
  process.exit(1);
}
console.log('\n✅ 资料校验通过');
