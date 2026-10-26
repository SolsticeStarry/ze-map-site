import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPagePayload, contentRevision, pageRevisionPayload, validateDoc, validatePageContent } from './page-schema.mjs';

const validDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '测试' }] }] };

test('accepts the editor document contract', () => {
  assert.deepEqual(validateDoc(validDoc), []);
  assert.equal(validatePageContent({ slug: 'ze_test', blocks: [{ id: 'story', type: 'story', doc: validDoc }] }, { slug: 'ze_test' }).ok, true);
});

test('accepts Tiptap default null textAlign and style attrs', () => {
  const doc = {
    type: 'doc',
    content: [{
      type: 'paragraph',
      attrs: { textAlign: null },
      content: [{ type: 'text', text: 'x', marks: [{ type: 'textStyle', attrs: { color: null, fontSize: null } }] }],
    }],
  };
  assert.deepEqual(validateDoc(doc), []);
});

test('rejects unsafe document attributes', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] };
  assert.equal(validateDoc(doc).length, 1);
  assert.equal(validatePageContent({ slug: 'ze_test', blocks: [{ id: 'story', type: 'story', doc }] }, { slug: 'ze_test' }).ok, false);
});

test('rejects invalid page revision payloads', () => {
  const result = pageRevisionPayload({ baseRev: 1, blocks: [{ id: 'story', type: 'story', doc: validDoc }] }, 'ze_test');
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((item) => item.path === 'baseRev'), true);
});

test('merges partial payloads without dropping untouched player overrides', () => {
  const story = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'story' }] }] };
  const guide = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'guide' }] }] };
  const base = applyPagePayload({ blocks: [{ id: 'story', type: 'story', doc: story }], itemEdits: [{ action: 'update', name: 'A', note: 'one' }], infobox: { author: 'A' } }, {
    blocks: [{ id: 'guide-1', type: 'guideItem', title: 'G', doc: guide }],
    infobox: { version: '1' },
    itemEdits: [{ action: 'update', name: 'B', note: 'two' }],
    stageRows: [['1', '关']],
  });
  assert.equal(base.blocks.find((block) => block.type === 'story').doc, story, '未提交的固定块保留');
  assert.equal(base.blocks.filter((block) => block.type === 'guideItem').length, 1);
  assert.deepEqual(base.infobox, { author: 'A', version: '1' });
  assert.equal(base.itemEdits.length, 2, '神器修改按名称叠加');
  assert.deepEqual(base.stageRows, [['1', '关']]);
  const cleared = applyPagePayload(base, { guideCleared: true });
  assert.equal(cleared.blocks.filter((block) => block.type === 'guideItem').length, 0, '显式清空整节攻略');
  assert.equal(cleared.guideCleared, true);
});

test('content revision is stable across key order and ignores baseRev', () => {
  const one = { slug: 'x', v: 1, blocks: [], infobox: { author: 'A', version: '1' } };
  const two = { infobox: { version: '1', author: 'A' }, blocks: [], v: 1, slug: 'x', baseRev: 'old' };
  assert.equal(contentRevision(one), contentRevision(two));
  assert.notEqual(contentRevision(one), contentRevision({ ...one, blocks: [{ id: 'story', type: 'story', doc: { type: 'doc', content: [] } }] }));
});

test('validates structured player fields and rejects research-only fields', () => {
  const valid = pageRevisionPayload({
    stageRows: [['1', '入口', '逃跑', '', '', '']],
    itemEdits: [{ action: 'update', name: 'Flashlight', cd: 30, uses: 1, intro: '说明', note: '备注' }],
    itemOrder: ['Flashlight'],
    videos: [{ url: 'https://www.bilibili.com/video/BV1234567890/', kind: 'run' }],
  }, 'ze_test');
  assert.equal(valid.ok, true, JSON.stringify(valid.errors));
  const protectedField = pageRevisionPayload({ entityCount: 123 }, 'ze_test');
  assert.equal(protectedField.ok, false);
  const badVideo = pageRevisionPayload({ videos: [{ url: 'https://example.com/video' }] }, 'ze_test');
  assert.equal(badVideo.ok, false);
});

test('accepts player difficulty, tags, and same-origin covers', () => {
  const result = pageRevisionPayload({
    difficulty: '困难',
    tags: ['BOSS战', 'KZ'],
    heroImage: '/images/covers/custom/ze_test.webp',
  }, 'ze_test');
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('rejects invalid difficulty, duplicate tags, and unsafe tag characters', () => {
  const invalidDifficulty = pageRevisionPayload({ difficulty: '不存在' }, 'ze_test');
  assert.equal(invalidDifficulty.ok, false);
  assert.equal(invalidDifficulty.errors.some((item) => item.path === 'difficulty'), true);

  const duplicateTags = pageRevisionPayload({ tags: ['KZ', 'kz'] }, 'ze_test');
  assert.equal(duplicateTags.ok, false);

  const unsafeTag = pageRevisionPayload({ tags: ['a/b'] }, 'ze_test');
  assert.equal(unsafeTag.ok, false);

  const tooMany = pageRevisionPayload({ tags: Array.from({ length: 16 }, (_, i) => `t${i}`) }, 'ze_test');
  assert.equal(tooMany.ok, false);
});

test('applies difficulty and tags without dropping other overrides', () => {
  const base = { difficulty: '普通', tags: ['旧'], infobox: { author: 'A' } };
  const next = applyPagePayload(base, { difficulty: '困难', tags: ['新', 'KZ'] });
  assert.equal(next.difficulty, '困难');
  assert.deepEqual(next.tags, ['新', 'KZ']);
  assert.deepEqual(next.infobox, { author: 'A' });
});

test('rejects a page revision without any actual change', () => {
  const result = pageRevisionPayload({ mode: 'full', submitter: '匿名', baseRev: 'rev' }, 'ze_test');
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((item) => item.path === 'payload'), true);
});

test('page revision payload accepts single mode metadata', () => {
  const result = pageRevisionPayload({
    mode: 'single',
    submitter: '匿名投稿人',
    difficulty: '困难',
    tags: ['KZ'],
  }, 'ze_test');
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});
