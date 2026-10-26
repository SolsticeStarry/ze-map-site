/**
 * 新下游的媒体上传：只把待审图放进 KV，等 page_revisions 审核通过后
 * 由写回流程把封面写进仓库、图片集写进 R2。
 *
 * 这里不创建 submissions，也不决定审核状态；媒体引用跟 payload 一起存进 page_revisions。
 */
import { allowWrite, fail, json, type Env } from './http';
import {
  checkCoverBytes,
  coverMetaOf,
  pendingCoverKey,
  pendingImageKey,
  putPendingImage,
  type CoverMeta,
} from './covers';
import {
  GALLERY_PENDING_PREFIX,
  checkGalleryBytes,
  galleryMetaOf,
  type GalleryMeta,
} from './gallery';

const SLUG_RE = /^[a-z0-9][a-z0-9_]{0,63}$/;
const GALLERY_MEDIA_MAX = 8;

export interface RevisionMedia {
  cover?: CoverMeta;
  gallery: GalleryMeta[];
}

export function mediaOf(value: unknown): { ok: true; media: RevisionMedia } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, media: { gallery: [] } };
  if (!value || typeof value !== 'object') return { ok: false, error: '媒体信息格式不对' };
  const raw = value as Record<string, unknown>;
  let cover: CoverMeta | undefined;
  if (raw.cover !== undefined && raw.cover !== null) {
    const meta = coverMetaOf(raw.cover);
    if (!meta || !meta.key.startsWith('pending/')) return { ok: false, error: '封面媒体信息不合法' };
    cover = meta;
  }
  const list = Array.isArray(raw.gallery) ? raw.gallery : [];
  if (list.length > GALLERY_MEDIA_MAX) return { ok: false, error: `一次最多带 ${GALLERY_MEDIA_MAX} 张图片集图片` };
  const gallery: GalleryMeta[] = [];
  for (const item of list) {
    const meta = galleryMetaOf(item);
    if (!meta || !meta.key.startsWith(GALLERY_PENDING_PREFIX)) return { ok: false, error: '图片集媒体信息不合法' };
    gallery.push(meta);
  }
  return { ok: true, media: { ...(cover ? { cover } : {}), gallery } };
}

export function mediaKeys(media: RevisionMedia | null | undefined): string[] {
  if (!media) return [];
  return [
    ...(media.cover?.key ? [media.cover.key] : []),
    ...media.gallery.map((item) => item.key).filter(Boolean),
  ];
}

/**
 * POST /api/content-cover 或 /api/content-gallery
 * multipart/form-data: map + cover|image + caption（图片集）
 */
export async function handleContentMediaUpload(
  request: Request,
  env: Env,
  ipHash: string,
  kind: 'cover' | 'gallery'
): Promise<Response> {
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared && declared > 2 * 1024 * 1024) return fail('上传内容过大', 413);
  if (ipHash && !(await allowWrite(env, ipHash, 'content-media', 60))) return fail('操作太频繁了，请过一会儿再试', 429);

  let form: FormData;
  try { form = await request.formData(); }
  catch { return fail('上传格式不对（应为 multipart/form-data）'); }
  const slug = typeof form.get('map') === 'string' ? String(form.get('map')).trim() : '';
  if (!SLUG_RE.test(slug)) return fail('地图参数不合法');

  const raw = form.get(kind === 'cover' ? 'cover' : 'image');
  if (!(raw instanceof File) && !(raw instanceof Blob)) return fail('没有收到图片文件');
  const bytes = new Uint8Array(await (raw as Blob).arrayBuffer());
  const check = kind === 'cover' ? checkCoverBytes(bytes) : checkGalleryBytes(bytes);
  if (!check.ok || !check.format) return fail(check.error ?? '图片不合法');

  const key = kind === 'cover' ? pendingCoverKey(check.format) : pendingImageKey(GALLERY_PENDING_PREFIX, check.format);
  try { await putPendingImage(env, key, bytes, check.format); }
  catch (error) {
    const status = (error as { status?: number }).status;
    return fail(error instanceof Error ? error.message : '图片暂存失败', typeof status === 'number' ? status : 500);
  }

  const media = kind === 'cover'
    ? { key, ext: check.format, bytes: bytes.length, width: check.width ?? 0, height: check.height ?? 0 }
    : {
        key,
        ext: check.format,
        bytes: bytes.length,
        width: check.width ?? 0,
        height: check.height ?? 0,
        caption: String(form.get('caption') ?? '').slice(0, 60),
      };
  return json({ ok: true, media, message: '已暂存，提交修订后进入审核。' });
}
