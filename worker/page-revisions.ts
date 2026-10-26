import type { Env } from './http';
import { allowWrite, fail, json, readJsonBody } from './http';
import { ensureSchema, getSessionUser } from './auth';
import { commitFiles, listRepoDir, readRepoFile, type CommitFile } from './git';
import { applyPagePayload, contentRevision, pageRevisionPayload, normalizePageContent, validatePageContent } from '../shared/page-schema.mjs';
import { docToText, parseResearchBody } from '../shared/research-body.mjs';
import { docItemDetails, mergeItems } from '../shared/items.mjs';
import { videoKindOf } from '../shared/videos.mjs';
import { textToDoc } from '../shared/doc-render.mjs';
import { COVER_DIR, COVER_EXTS, checkCoverBytes, coverRepoPath, coverUrl, dropPendingImage, readPendingImage } from './covers';
import { checkGalleryBytes, galleryEntryName, galleryEntryUrl, galleryManifestPath, parseManifest, putGalleryImage, serializeManifest, withImages, type GalleryManifest } from './gallery';
import { mediaOf, type RevisionMedia } from './content-media';

const FIXED_BLOCK_LABELS: Record<string, string> = { story: '背景故事', intro: '简介', gameplay: '关卡流程说明' };

const SLUG_RE = /^[a-z0-9][a-z0-9_]{0,63}$/;
const PAGE_PATH = (slug: string) => `data/content/${slug}.json`;

type RevisionRow = {
  id: number;
  map_slug: string;
  user_id: number;
  submitter: string;
  payload: string;
  base_rev: string | null;
  status: string;
  mode: string;
  created_at: number;
  reviewed_at: number | null;
  reviewer: string | null;
  reject_note: string | null;
  commit_sha: string | null;
  error: string | null;
};


/** 匿名投稿的撤回码：只回给提交者，库里存 SHA-256（2026-10-27） */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function newWithdrawToken(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function handlePageRevisionSubmit(request: Request, env: Env, ipHash = ''): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  await ensureSchema(env);
  const body = await readJsonBody(request, 64 * 1024);
  if (!body.ok) return body.response;
  const payload = body.body as Record<string, unknown>;
  const mode = payload.mode === 'single' ? 'single' : 'full';
  const slug = typeof payload.slug === 'string' ? payload.slug.trim() : '';
  if (!SLUG_RE.test(slug)) return fail('地图参数不合法');
  const checked = pageRevisionPayload(payload, slug);
  if (!checked.ok) return fail(`没有通过内容校验：${checked.errors[0]?.path ?? 'payload'} ${checked.errors[0]?.message ?? ''}`);
  const media = mediaOf(payload.media);
  if (!media.ok) return fail(media.error);
  const baseRev = typeof payload.baseRev === 'string' ? payload.baseRev : null;

  if (mode === 'full') {
    const user = await getSessionUser(request, env).catch(() => null);
    if (!user) return fail('整页修订需要先登录', 401);
    const submitter = user.name.replace(/[\r\n]/g, ' ').slice(0, 32);
    const result = await env.DB.prepare(
      `INSERT INTO page_revisions (map_slug, user_id, submitter, payload, base_rev, status, mode, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 'full', ?6)`
    ).bind(slug, user.id, submitter, JSON.stringify(payload), baseRev, Date.now()).run();
    return json({ ok: true, id: Number((result as { meta?: { last_row_id?: number } }).meta?.last_row_id ?? 0), status: 'pending', mode });
  }

  if (ipHash && !(await allowWrite(env, ipHash, 'content-single', 30))) return fail('操作太频繁了，请过一会儿再试', 429);
  const submitter = String(payload.submitter ?? '匿名').replace(/[\r\n]/g, ' ').slice(0, 32) || '匿名';
  const withdrawToken = newWithdrawToken();
  const withdrawHash = await sha256Hex(withdrawToken);
  const result = await env.DB.prepare(
    `INSERT INTO page_revisions (map_slug, user_id, submitter, payload, base_rev, status, mode, created_at, withdraw_hash)
     VALUES (?1, 0, ?2, ?3, ?4, 'pending', 'single', ?5, ?6)`
  ).bind(slug, submitter, JSON.stringify(payload), baseRev, Date.now(), withdrawHash).run();
  return json({
    ok: true,
    id: Number((result as { meta?: { last_row_id?: number } }).meta?.last_row_id ?? 0),
    status: 'pending',
    mode,
    withdrawToken,
  });
}

export async function handleAdminPageRevisionQueue(request: Request, env: Env, url: URL): Promise<Response> {
  await ensureSchema(env);
  const status = url.searchParams.get('status') || 'pending';
  /* 标签角标要的只是计数（审核台每 30 秒刷一次，别为它拉 100 条 payload） */
  const countRows = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM page_revisions GROUP BY status`
  ).all<{ status: string; n: number }>();
  const counts = Object.fromEntries((countRows.results ?? []).map((row) => [row.status, row.n]));
  if (url.searchParams.get('countOnly') === '1') return json({ ok: true, counts });
  const rows = await env.DB.prepare(
    `SELECT id, map_slug, user_id, submitter, payload, base_rev, status, mode, created_at, reviewed_at, reviewer, reject_note, commit_sha, error
       FROM page_revisions WHERE status = ?1 ORDER BY created_at ASC LIMIT 100`
  ).bind(status).all<RevisionRow>();
  return json({ ok: true, items: rows.results ?? [], counts });
}

/** 去掉 MDX frontmatter，只留正文（parseResearchBody 吃正文） */
function mdxBody(text: string | null): string {
  return String(text ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/** frontmatter 里审核台要对比的基本信息（只认标量，够用就行） */
function frontmatterFields(mdx: string | null): Record<string, string> {
  const match = String(mdx ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^(author|version|players|duration|stages|size|aliases):\s*(.+)$/);
    if (!field) continue;
    const value = field[2].trim().replace(/^['"]|['"]$/g, '');
    if (value && !/^\[/.test(value) && !/^-/.test(value)) out[field[1]] = value;
  }
  return out;
}

/**
 * GET /api/admin/page-revisions/current?slug=<slug>
 *
 * 审核台做「现在的值 | 本次提交」两栏对比时，需要当前页面上的内容。
 * 和投稿队列不同，整页修订改的不是社区文档里的一个字段，而是 research 基线
 * + 玩家覆盖合并后的整页内容 —— 所以这里按站点的合并口径现算一份快照：
 *   data/content（玩家覆盖）+ src/content/maps（research 正文）+ gfl（神器基表）
 * 一次最多读 4 个文件；审核台按卡片懒加载，不会在列表接口里逐图读 GitHub。
 */
export async function handleAdminPageRevisionCurrent(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return fail('只支持 GET', 405);
  const slug = String(url.searchParams.get('slug') ?? '').trim();
  if (!SLUG_RE.test(slug)) return fail('地图参数不合法');
  const read = async (path: string): Promise<string | null> => {
    try {
      return (await readRepoFile(env, path)).text;
    } catch {
      return null;
    }
  };
  const [contentText, mdx, gflText, researchText] = await Promise.all([
    read(`data/content/${slug}.json`),
    read(`src/content/maps/${slug}.mdx`),
    read(`data/gfl-parsed/${slug}.json`),
    read(`data/research/${slug}.json`),
  ]);
  let rawContent: unknown = { slug };
  if (contentText) {
    try { rawContent = JSON.parse(contentText); } catch { /* 坏 JSON 就按空玩家层算，审核台仍能看新值 */ }
  }
  const content = normalizePageContent(slug, rawContent);
  const body = mdxBody(mdx);
  const research = parseResearchBody(body);
  let researchJson: Record<string, any> = {};
  if (researchText) {
    try { researchJson = JSON.parse(researchText) as Record<string, any>; } catch { /* 读不到 JSON 不影响正文快照 */ }
  }
  let gfl: Record<string, any> = {};
  if (gflText) {
    try { gfl = JSON.parse(gflText) as Record<string, any>; } catch { /* 没有基表就只显示玩家行 */ }
  }
  const playerBlocks = Array.isArray(content.blocks) ? content.blocks : [];
  const fixed = (['story', 'intro', 'gameplay'] as const).map((type) => {
    const override = playerBlocks.find((block: any) => block?.type === type);
    const fallback = type === 'story' ? research.story : type === 'intro' ? (research.intro || research.summary) : research.gameplay;
    const text = override ? (String(override.text ?? '').trim() || docToText(override.doc)) : String(fallback ?? '');
    return {
      id: type,
      type,
      title: FIXED_BLOCK_LABELS[type],
      text,
      doc: override?.doc ?? textToDoc(text),
    };
  });
  const playerGuides = playerBlocks.filter((block: any) => block?.type === 'guideItem');
  const guides = content.guideCleared
    ? []
    : playerGuides.length
      ? playerGuides.map((block: any) => {
          const text = String(block.text ?? '').trim() || docToText(block.doc);
          return {
            id: String(block.id),
            type: 'guideItem',
            title: String(block.title ?? ''),
            text,
            doc: block.doc ?? textToDoc(text),
          };
        })
      : (research.guides ?? []).map((guide: any, index: number) => ({
          id: `guide-${index + 1}`,
          type: 'guideItem',
          title: String(guide.title ?? ''),
          text: String(guide.text ?? ''),
          doc: textToDoc(String(guide.text ?? '')),
        }));
  /* 当前神器表：gfl 基表 + research 正文手写说明 + content 覆盖。 */
  const itemRows = [
    ...docItemDetails(body),
    ...(Array.isArray(content.itemEdits) ? content.itemEdits : []),
  ];
  let items = mergeItems(gfl.items ?? [], itemRows).rows.filter((row: any) => row.kind !== 'removed');
  const itemOrder = Array.isArray(content.itemOrder) ? content.itemOrder : [];
  if (itemOrder.length) {
    const index = new Map(itemOrder.map((name: string, position: number) => [String(name).toLowerCase(), position]));
    items = [...items].sort(
      (left: any, right: any) =>
        (index.get(String(left?.name ?? '').toLowerCase()) ?? Number.MAX_SAFE_INTEGER) -
        (index.get(String(right?.name ?? '').toLowerCase()) ?? Number.MAX_SAFE_INTEGER)
    );
  }
  const stageRows = content.stageRows ?? research.stageRows ?? [];
  const researchVideoUrls = Array.isArray(researchJson.videoUrls) ? researchJson.videoUrls : [];
  const videos = content.videos
    ?? (researchVideoUrls.length
      ? researchVideoUrls.map((videoUrl: string) => ({ url: videoUrl, kind: videoKindOf(videoUrl, researchJson.videoKinds) }))
      : []);
  /* 审核台富文本预览：当前关卡 doc（有玩家富文本就用，否则从纯文本生成） */
  const contentStageDocs = Array.isArray(content.stageDocs) ? content.stageDocs : [];
  const snapshotStageDocs = stageRows.length > 1
    ? stageRows.map((row: string[], index: number) =>
        index === 0 ? null : (contentStageDocs[index] ?? textToDoc(String(row?.[2] ?? '')))
      )
    : [];
  const snapshot = {
    title:
      typeof content.title === 'string' && content.title.trim()
        ? content.title
        : String(researchJson.title ?? slug),
    heroImage: content.heroImage ?? null,
    difficulty: content.difficulty ?? researchJson.difficulty ?? null,
    tags: content.tags ?? researchJson.tags ?? null,
    infobox: { ...frontmatterFields(mdx), ...(content.infobox ?? {}) },
    blocks: [...fixed, ...guides],
    stageRows,
    stageDocs: snapshotStageDocs,
    videos,
    items,
  };
  return json({ ok: true, slug, current: snapshot });
}

export async function handleAdminPageRevisionReview(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  await ensureSchema(env);
  const body = await readJsonBody(request, 4096);
  if (!body.ok) return body.response;
  const value = body.body as { id?: unknown; action?: unknown; reviewer?: unknown; rejectNote?: unknown };
  const id = Number(value.id);
  const action = value.action === 'approve' || value.action === 'reject' || value.action === 'unstage' ? value.action : '';
  if (!Number.isInteger(id) || !action) return fail('审核参数不合法');
  const reviewer = String(value.reviewer ?? '审核员').replace(/[\r\n]/g, ' ').slice(0, 32);
  if (action === 'reject') {
    await env.DB.prepare(`UPDATE page_revisions SET status='rejected', reviewed_at=?1, reviewer=?2, reject_note=?3 WHERE id=?4 AND status='pending'`)
      .bind(Date.now(), reviewer, String(value.rejectNote ?? '').slice(0, 500), id).run();
  } else if (action === 'unstage') {
    await env.DB.prepare(`UPDATE page_revisions SET status='pending', reviewed_at=NULL, reviewer=NULL, reject_note=NULL WHERE id=?1 AND status='approved'`)
      .bind(id).run();
  } else {
    await env.DB.prepare(`UPDATE page_revisions SET status='approved', reviewed_at=?1, reviewer=?2, reject_note=NULL WHERE id=?3 AND status='pending'`)
      .bind(Date.now(), reviewer, id).run();
  }
  return json({ ok: true, id, status: action === 'approve' ? 'approved' : action === 'unstage' ? 'pending' : 'rejected' });
}

export async function handleAdminPageRevisionFlush(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  await ensureSchema(env);
  const rows = await env.DB.prepare(`SELECT * FROM page_revisions WHERE status='approved' ORDER BY created_at ASC LIMIT 50`).all<RevisionRow>();
  const revisions = rows.results ?? [];
  if (!revisions.length) return json({ ok: true, count: 0, message: '没有待写回的整页修订' });

  const files = new Map<string, { slug: string; content: Record<string, any>; ids: number[]; rows: RevisionRow[]; baseRev: string | null }>();
  const mediaBySlug = new Map<string, { cover?: RevisionMedia['cover']; gallery: Array<{ meta: RevisionMedia['gallery'][number]; revisionId: number }>; rows: RevisionRow[] }>();
  const rememberMedia = (row: RevisionRow, media: RevisionMedia) => {
    if (!media.cover && !media.gallery.length) return;
    const group = mediaBySlug.get(row.map_slug) ?? { gallery: [], rows: [] };
    if (media.cover) group.cover = media.cover;
    for (const meta of media.gallery) group.gallery.push({ meta, revisionId: row.id });
    group.rows.push(row);
    mediaBySlug.set(row.map_slug, group);
  };
  for (const row of revisions) {
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { continue; }
    const checked = pageRevisionPayload(payload, row.map_slug);
    if (!checked.ok) {
      await env.DB.prepare(`UPDATE page_revisions SET status='conflict', error=?1 WHERE id=?2`).bind(`写回前校验失败：${checked.errors[0]?.message ?? '内容不合法'}`, row.id).run();
      continue;
    }
    const rowMedia = mediaOf(payload.media);
    if (!rowMedia.ok) {
      await env.DB.prepare(`UPDATE page_revisions SET status='conflict', error=?1 WHERE id=?2`).bind(rowMedia.error, row.id).run();
      continue;
    }
    const current = files.get(row.map_slug);
    if (current) {
      if (row.base_rev && row.base_rev !== contentRevision(current.content)) {
        await env.DB.prepare(`UPDATE page_revisions SET status='conflict', error=?1 WHERE id=?2`).bind('同一地图的上一笔修订已改动内容，请重新读取后提交', row.id).run();
        continue;
      }
      current.content = applyPagePayload(current.content, payload);
      current.ids.push(row.id);
      current.rows.push(row);
      rememberMedia(row, rowMedia.media);
      continue;
    }
    const repoFile = await readRepoFile(env, PAGE_PATH(row.map_slug));
    let parsed: unknown = { slug: row.map_slug };
    try { parsed = repoFile.text ? JSON.parse(repoFile.text) : parsed;     } catch {
      await env.DB.prepare(`UPDATE page_revisions SET status='conflict', error=?1 WHERE id=?2`).bind('现有 content 文件不是合法 JSON，请先修复', row.id).run();
      continue;
    }
    const checkedCurrent = validatePageContent(parsed, { slug: row.map_slug });
    if (!checkedCurrent.ok) {
      await env.DB.prepare(`UPDATE page_revisions SET status='conflict', error=?1 WHERE id=?2`).bind(`现有 content 文件未通过校验：${checkedCurrent.errors[0]?.message ?? '内容不合法'}`, row.id).run();
      continue;
    }
    const currentContent = normalizePageContent(row.map_slug, parsed);
    if (row.base_rev && row.base_rev !== contentRevision(currentContent)) {
      await env.DB.prepare(`UPDATE page_revisions SET status='conflict', error=?1 WHERE id=?2`).bind('content 文件已发生变化，请重新读取后提交', row.id).run();
      continue;
    }
    files.set(row.map_slug, { slug: row.map_slug, content: applyPagePayload(currentContent, payload), ids: [row.id], rows: [row], baseRev: repoFile.sha });
    rememberMedia(row, rowMedia.media);
  }

  const extraFiles: CommitFile[] = [];
  const pendingMediaKeys: string[] = [];
  const existingCovers = new Set<string>();
  if ([...mediaBySlug.values()].some((group) => group.cover)) {
    try {
      for (const entry of await listRepoDir(env, COVER_DIR)) existingCovers.add(entry.name.toLowerCase());
    } catch { /* 列不到目录就只写新封面，不删旧扩展名 */ }
  }
  for (const [slug, group] of mediaBySlug) {
    const item = files.get(slug);
    if (!item) continue;
    const slugExtra: CommitFile[] = [];
    const slugKeys: string[] = [];
    try {
      if (group.cover) {
        const pending = await readPendingImage(env, group.cover.key);
        if (!pending) throw new Error('封面待审图已过期，请重新上传');
        const check = checkCoverBytes(pending.bytes);
        if (!check.ok || !check.format) throw new Error(`封面校验失败：${check.error ?? '未知'}`);
        let bin = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < pending.bytes.length; i += CHUNK) bin += String.fromCharCode(...pending.bytes.subarray(i, i + CHUNK));
        slugExtra.push({ path: coverRepoPath(slug, check.format), base64: btoa(bin) });
        for (const ext of COVER_EXTS) {
          if (ext === check.format) continue;
          if (existingCovers.has(`${slug}.${ext}`.toLowerCase())) slugExtra.push({ path: coverRepoPath(slug, ext), remove: true });
        }
        item.content.heroImage = coverUrl(slug, check.format);
        slugKeys.push(group.cover.key);
      }
      if (group.gallery.length) {
        const repo = await readRepoFile(env, galleryManifestPath(slug));
        let manifest: GalleryManifest = parseManifest(repo.text, slug);
        let dirty = false;
        for (const [index, entry] of group.gallery.entries()) {
          const pending = await readPendingImage(env, entry.meta.key);
          if (!pending) throw new Error('图片集待审图已过期，请重新上传');
          const check = checkGalleryBytes(pending.bytes);
          if (!check.ok || !check.format) throw new Error(`图片集校验失败：${check.error ?? '未知'}`);
          const base = galleryEntryName(entry.revisionId, check.format);
          const name = index === 0 ? base : base.replace(`.${check.format}`, `-${index + 1}.${check.format}`);
          await putGalleryImage(env, slug, name, pending.bytes, check.format);
          const galleryEntry: { src: string; kind: string; caption: string; by?: string } = {
            src: galleryEntryUrl(slug, name),
            kind: 'user',
            caption: entry.meta.caption || '玩家截图',
          };
          if (group.rows[0]?.submitter) galleryEntry.by = group.rows[0].submitter;
          manifest = withImages(manifest, [galleryEntry]);
          slugKeys.push(entry.meta.key);
          dirty = true;
        }
        if (dirty) slugExtra.push({ path: galleryManifestPath(slug), text: serializeManifest(manifest) });
      }
      extraFiles.push(...slugExtra);
      pendingMediaKeys.push(...slugKeys);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const row of group.rows) {
        await env.DB.prepare(`UPDATE page_revisions SET status='conflict', error=?1 WHERE id=?2`).bind(message, row.id).run();
      }
      files.delete(slug);
    }
  }

  const appliedAt = Date.now();
  const commitFilesInput = [...files.values()].map((item) => {
    item.content.history = [...(Array.isArray(item.content.history) ? item.content.history : []), ...item.rows.map((row) => ({ revision: row.id, submitter: row.submitter, reviewer: row.reviewer, appliedAt }))].slice(-50);
    item.content.baseRev = contentRevision(item.content);
    return { path: PAGE_PATH(item.slug), text: JSON.stringify(item.content, null, 2) + '\n' };
  });
  if (!commitFilesInput.length) return json({ ok: true, count: 0, conflicts: true });
  commitFilesInput.push(...extraFiles);
  const commit = await commitFiles(env, commitFilesInput, `内容修订：${[...files.keys()].join('、')}`);
  const ids = [...files.values()].flatMap((item) => item.ids);
  for (const id of ids) await env.DB.prepare(`UPDATE page_revisions SET status='applied', commit_sha=?, error=NULL WHERE id=?`).bind(commit.sha, id).run();
  if (commitFilesInput.some((file) => file.base64 || file.path.startsWith('data/gallery/'))) {
    for (const key of pendingMediaKeys) await dropPendingImage(env, key);
  }
  return json({ ok: true, count: ids.length, commitSha: commit.sha, maps: files.size });
}

/** GET /api/my-revisions：登录用户自己的修订列表（账号页用） */
export async function handleMyPageRevisions(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return fail('只支持 GET', 405);
  await ensureSchema(env);
  const user = await getSessionUser(request, env).catch(() => null);
  if (!user) return fail('需要先登录', 401);
  const rows = await env.DB.prepare(
    `SELECT id, map_slug, status, mode, payload, created_at, reviewed_at, reviewer, reject_note, commit_sha
       FROM page_revisions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 100`
  ).bind(user.id).all();
  const items = (rows.results ?? []).map((row: Record<string, unknown>) => {
    let slug = String(row.map_slug ?? '');
    try {
      const parsed = JSON.parse(String(row.payload ?? '{}'));
      if (typeof parsed.slug === 'string') slug = parsed.slug;
    } catch {}
    return { ...row, slug };
  });
  return json({ ok: true, items });
}

/** POST /api/page-revision/withdraw：本人（登录）或用撤回码（匿名）撤回待审修订 */
export async function handlePageRevisionWithdraw(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  await ensureSchema(env);
  const body = await readJsonBody(request, 8 * 1024);
  if (!body.ok) return body.response;
  const payload = body.body as Record<string, unknown>;
  const id = Number(payload.id);
  if (!Number.isInteger(id) || id <= 0) return fail('修订编号不合法');
  const token = typeof payload.token === 'string' ? payload.token : '';
  const row = await env.DB.prepare(
    'SELECT id, user_id, status, withdraw_hash FROM page_revisions WHERE id = ?1'
  ).bind(id).first<{ id: number; user_id: number; status: string; withdraw_hash: string | null }>();
  if (!row) return fail('没有这条修订', 404);
  if (row.status !== 'pending') return fail('只有待审的修订可以撤回', 409);
  const user = await getSessionUser(request, env).catch(() => null);
  const owner = user && Number(row.user_id) === Number(user.id);
  const tokenOk = token && row.withdraw_hash && (await sha256Hex(token)) === row.withdraw_hash;
  if (!owner && !tokenOk) return fail('没有权限撤回这条修订', 403);
  await env.DB.prepare(
    "UPDATE page_revisions SET status='withdrawn', reviewed_at=?1, reviewer=?2 WHERE id=?3 AND status='pending'"
  ).bind(Date.now(), owner ? user!.name : '投稿人', id).run();
  return json({ ok: true, id, status: 'withdrawn' });
}
