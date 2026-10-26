#!/usr/bin/env node
/** 校验 data/content/*.json 是否全部通过共享 schema，并输出覆盖统计。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePageContent } from '../../shared/page-schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'data/content');
const files = fs.readdirSync(DIR).filter((name) => name.endsWith('.json')).sort();
const summary = { files: files.length, tags: 0, difficulty: 0, hero: 0, blocks: 0, items: 0, history: 0 };
const invalid = [];
for (const file of files) {
  const slug = file.slice(0, -'.json'.length);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); }
  catch (error) { invalid.push({ slug, errors: [{ path: 'json', message: error.message }] }); continue; }
  const result = validatePageContent(raw, { slug });
  if (!result.ok) invalid.push({ slug, errors: result.errors.slice(0, 5) });
  if (Array.isArray(raw.tags) && raw.tags.length) summary.tags += 1;
  if (raw.difficulty) summary.difficulty += 1;
  if (raw.heroImage) summary.hero += 1;
  if (Array.isArray(raw.blocks)) summary.blocks += raw.blocks.length;
  if (Array.isArray(raw.itemEdits)) summary.items += raw.itemEdits.length;
  if (Array.isArray(raw.history)) summary.history += raw.history.length;
}
console.log(JSON.stringify({ summary, invalid }, null, 2));
if (invalid.length) process.exitCode = 1;
