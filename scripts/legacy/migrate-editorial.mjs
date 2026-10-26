#!/usr/bin/env node
/**
 * 把旧 data/community 迁移成新 data/content 覆盖层。
 *
 * 用法：
 *   node scripts/legacy/migrate-editorial.mjs --dry-run
 *   node scripts/legacy/migrate-editorial.mjs
 *   node scripts/legacy/migrate-editorial.mjs --slugs=ze_a,ze_b
 *   node scripts/legacy/migrate-editorial.mjs --slugs=ze_a --force
 *
 * 规则：
 *   - 只读 data/community，不写 data/research。
 *   - 已存在的 content 默认跳过；--force 才覆盖。
 *   - difficulty / tags 现在都是 content 字段。
 *   - sources / drafts / 无法映射的字段只进报告，不写 content。
 *   - 输出 JSON 报告；迁移数据不进运行路径。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDoc } from './community-doc.mjs';
import { emptyPageContent, TAGS_MAX, TAG_MAX_LEN, validatePageContent } from '../../shared/page-schema.mjs';
import { isDifficulty, normalizeDifficulty } from '../../shared/difficulty.mjs';
import { videoKindOf } from '../../shared/videos.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const communityDir = path.join(root, 'data', 'community');
const contentDir = path.join(root, 'data', 'content');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const slugsArg = args.find((arg) => arg.startsWith('--slugs='));
const wantedSlugs = slugsArg
  ? new Set(slugsArg.slice('--slugs='.length).split(',').map((slug) => slug.trim()).filter(Boolean))
  : null;

const SAFE_TAG = /[\\/:*?"<>|#%]/g;
const VIDEO_HOSTS = new Set(['www.bilibili.com', 'b23.tv', 'www.b23.tv']);

const paragraphDoc = (text) => ({ type: 'doc', content: text ? [{ type: 'paragraph', content: [{ type: 'text', text }] }] : [] });
const asText = (value) => (Array.isArray(value) ? value.join('\n') : String(value ?? '')).trim();
const safeTag = (value) => String(value ?? '').replace(SAFE_TAG, '·').replace(/\s+/g, ' ').trim().slice(0, TAG_MAX_LEN);
const isImageRef = (value) => typeof value === 'string' && (value.startsWith('https://') || /^\/(?:images|terr)\//.test(value)) && !value.includes('..');

function migrationFor(slug, raw) {
  const source = normalizeDoc(slug, raw);
  const content = emptyPageContent(slug);
  const report = { unsupported: [], warnings: [] };
  const history = new Map();
  const pushHistory = (entry) => {
    const key = JSON.stringify(entry);
    if (!history.has(key)) history.set(key, entry);
  };
  const fixed = new Map();
  let guideCount = 0;

  const addFixed = (type, text) => {
    if (!text) return;
    if (!fixed.has(type)) fixed.set(type, { id: type, type, doc: paragraphDoc(text) });
    else fixed.get(type).doc.content.push(...paragraphDoc(text).content);
  };

  for (const note of source.notes) {
    const field = note.field ?? '';
    const text = String(note.text ?? '').trim();
    if (!text) continue;
    if (['story', 'summary', 'body', 'intro'].includes(field) || (!field && text)) {
      addFixed(field === 'story' ? 'story' : field === 'summary' ? 'intro' : 'intro', text);
    } else if (field === 'section' || field === 'guide' || field === 'titledtext') {
      guideCount += 1;
      content.blocks.push({
        id: `guide-${guideCount}`,
        type: 'guideItem',
        title: note.title || (field === 'section' ? '社区整理' : '社区攻略'),
        doc: paragraphDoc(text),
      });
    } else {
      report.unsupported.push(`note:${field || 'body'}`);
      continue;
    }
    pushHistory({
      source: 'data/community',
      submission: note.submission ?? null,
      by: note.by ?? '匿名',
      at: note.at ?? null,
      field: field || 'body',
      ...(note.title ? { title: note.title } : {}),
      ...(note.revisedBy ? { revisedBy: note.revisedBy, revisedAt: note.revisedAt ?? null } : {}),
    });
  }
  content.blocks = [...fixed.values(), ...content.blocks];
  content.guideCleared = false;

  for (const item of source.items) {
    const action = ['update', 'add', 'remove'].includes(item.action) ? item.action : 'update';
    const name = String(item.name ?? '').trim();
    if (!name) {
      report.unsupported.push('item:missing-name');
      continue;
    }
    content.itemEdits.push({
      action,
      name,
      cd: item.cd ?? null,
      uses: item.uses ?? null,
      note: String(item.note ?? ''),
      intro: String(item.intro ?? ''),
    });
    pushHistory({
      source: 'data/community',
      submission: item.submission ?? null,
      by: item.by ?? '匿名',
      at: item.at ?? null,
      field: 'items',
      action,
      name,
    });
  }

  const fields = source.fields ?? {};
  const videoKinds = fields.videoKinds?.v && typeof fields.videoKinds.v === 'object' ? fields.videoKinds.v : {};
  const videos = [];
  const seenVideos = new Set();
  const addVideo = (rawUrl, forcedKind) => {
    const url = String(rawUrl ?? '').trim();
    if (!url) return;
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (!VIDEO_HOSTS.has(host)) {
        report.unsupported.push(`video:${host || 'invalid'}`);
        return;
      }
    } catch {
      report.unsupported.push('video:invalid-url');
      return;
    }
    if (seenVideos.has(url)) return;
    seenVideos.add(url);
    videos.push({ url, kind: forcedKind || videoKindOf(url, videoKinds) });
  };

  for (const [field, meta] of Object.entries(fields)) {
    const value = meta?.v;
    const entry = {
      source: 'data/community',
      submission: meta?.submission ?? null,
      by: meta?.by ?? '匿名',
      at: meta?.at ?? null,
      field,
    };
    if (field === 'title') {
      const title = asText(value);
      if (title.length > 80) report.unsupported.push('field:title-too-long');
      else if (title) content.title = title;
    } else if (field === 'cover') {
      if (isImageRef(value)) content.heroImage = String(value);
      else report.unsupported.push('field:cover-invalid');
    } else if (field === 'tags') {
      const list = Array.isArray(value) ? value : [value];
      const seenTags = new Set();
      const tags = [];
      for (const tag of list.map(safeTag).filter(Boolean)) {
        const key = tag.toLowerCase();
        if (seenTags.has(key)) continue;
        seenTags.add(key);
        tags.push(tag);
      }
      if (tags.length > TAGS_MAX) report.warnings.push(`tags:truncated-${tags.length}-to-${TAGS_MAX}`);
      content.tags = tags.slice(0, TAGS_MAX);
    } else if (field === 'difficulty') {
      const difficulty = normalizeDifficulty(value);
      if (isDifficulty(difficulty)) content.difficulty = difficulty;
      else report.unsupported.push('field:difficulty-invalid');
    } else if (field === 'videoUrls' || field === 'videoRun' || field === 'videoVeteran' || field === 'videoTrigger' || field === 'videoEaster' || field === 'videoMusic' || field === 'videoOther') {
      const kind = field === 'videoRun' ? 'run' : field === 'videoMusic' ? 'music' : field === 'videoUrls' ? undefined : 'guide';
      for (const url of Array.isArray(value) ? value : [value]) addVideo(url, kind);
    } else if (['author', 'authorNote', 'version', 'players', 'duration', 'stages', 'aliases'].includes(field)) {
      const text = asText(value).slice(0, 200);
      if (text) content.infobox[field] = text;
    } else if (field === 'sources') {
      report.unsupported.push('field:sources-archived');
    } else if (field === 'draft') {
      report.unsupported.push('field:draft-archived');
    } else {
      report.unsupported.push(`field:${field}`);
    }
    pushHistory(entry);
  }

  if (videos.length) content.videos = videos;
  if (source.draft?.text) report.unsupported.push('draft:requires-manual-review');
  if (source.updatedAt) pushHistory({ source: 'data/community.updatedAt', at: source.updatedAt });

  for (const log of source.log ?? []) {
    pushHistory({ source: 'data/community.log', ...log });
  }
  content.history = [...history.values()];

  return { content, report };
}

function mergeExisting(existing, incoming) {
  const next = { ...existing };
  for (const key of ['title', 'heroImage', 'tags', 'difficulty']) {
    if (next[key] === undefined || next[key] === null || (Array.isArray(next[key]) && next[key].length === 0)) next[key] = incoming[key];
  }
  if (!Array.isArray(next.videos) || next.videos.length === 0) next.videos = incoming.videos;
  else if (Array.isArray(incoming.videos)) {
    const seen = new Set(next.videos.map((item) => item?.url).filter(Boolean));
    for (const item of incoming.videos) if (item?.url && !seen.has(item.url)) { next.videos.push(item); seen.add(item.url); }
  }
  next.infobox = { ...(next.infobox ?? {}) };
  for (const [key, value] of Object.entries(incoming.infobox ?? {})) {
    if (next.infobox[key] === undefined || next.infobox[key] === '') next.infobox[key] = value;
  }
  if (!Array.isArray(next.blocks) || next.blocks.length === 0) next.blocks = incoming.blocks;
  if (!Array.isArray(next.itemEdits) || next.itemEdits.length === 0) next.itemEdits = incoming.itemEdits;
  next.history = Array.isArray(next.history) ? [...next.history] : [];
  const seenHistory = new Set(next.history.map((item) => JSON.stringify(item)));
  for (const item of incoming.history ?? []) {
    const key = JSON.stringify(item);
    if (!seenHistory.has(key)) { next.history.push(item); seenHistory.add(key); }
  }
  if (next.guideCleared === undefined) next.guideCleared = incoming.guideCleared;
  return next;
}

const files = (await fs.readdir(communityDir)).filter((name) => name.endsWith('.json')).sort();
const selected = wantedSlugs ? files.filter((name) => wantedSlugs.has(name.slice(0, -'.json'.length))) : files;
const report = [];
for (const file of selected) {
  const slug = file.slice(0, -'.json'.length);
  const raw = JSON.parse(await fs.readFile(path.join(communityDir, file), 'utf8'));
  const result = migrationFor(slug, raw);
  const target = path.join(contentDir, file);
  const checked = validatePageContent(result.content, { slug });
  if (!checked.ok) {
    report.push({ slug, action: 'invalid-incoming', errors: checked.errors, unsupported: result.report.unsupported, warnings: result.report.warnings });
    continue;
  }
  const exists = await fs.access(target).then(() => true, () => false);
  if (exists && !force) {
    const existing = JSON.parse(await fs.readFile(target, 'utf8'));
    const existingCheck = validatePageContent(existing, { slug });
    if (!existingCheck.ok) {
      report.push({ slug, action: 'invalid-existing', errors: existingCheck.errors, unsupported: result.report.unsupported, warnings: result.report.warnings });
      continue;
    }
    const merged = mergeExisting(existing, result.content);
    const mergedCheck = validatePageContent(merged, { slug });
    if (!mergedCheck.ok) {
      report.push({ slug, action: 'invalid-merged', errors: mergedCheck.errors, unsupported: result.report.unsupported, warnings: result.report.warnings });
      continue;
    }
    const changed = JSON.stringify(merged) !== JSON.stringify(existing);
    const action = changed ? (dryRun ? 'would-merge' : 'merge') : 'skip-existing';
    report.push({
      slug,
      action,
      blocks: merged.blocks.length,
      items: merged.itemEdits.length,
      tags: merged.tags?.length ?? 0,
      difficulty: merged.difficulty,
      unsupported: result.report.unsupported,
      warnings: result.report.warnings,
    });
    if (changed && !dryRun) {
      await fs.mkdir(contentDir, { recursive: true });
      await fs.writeFile(target, `${JSON.stringify(merged, null, 2)}
`);
    }
    continue;
  }
  const action = dryRun ? (exists ? 'would-overwrite' : 'would-write') : (exists ? 'overwrite' : 'write');
  report.push({
    slug,
    action,
    blocks: result.content.blocks.length,
    items: result.content.itemEdits.length,
    tags: result.content.tags?.length ?? 0,
    difficulty: result.content.difficulty,
    unsupported: result.report.unsupported,
    warnings: result.report.warnings,
  });
  if (!dryRun) {
    await fs.mkdir(contentDir, { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(result.content, null, 2)}
`);
  }
}

const summary = {
  dryRun,
  force,
  files: selected.length,
  written: report.filter((item) => ['write', 'overwrite', 'merge'].includes(item.action)).length,
  merged: report.filter((item) => item.action === 'merge').length,
  wouldWrite: report.filter((item) => ['would-write', 'would-overwrite', 'would-merge'].includes(item.action)).length,
  skipped: report.filter((item) => item.action === 'skip-existing').length,
  invalid: report.filter((item) => item.action.startsWith('invalid')).length,
  unsupported: report.filter((item) => item.unsupported?.length).length,
  report,
};
console.log(JSON.stringify(summary, null, 2));
