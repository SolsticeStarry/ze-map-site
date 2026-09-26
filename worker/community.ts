/**
 * 把审核通过的投稿写回 GitHub 仓库（data/community/<slug>.json）。
 *
 * 为什么绕一圈写 git，而不是直接读 D1：
 *   1. 构建必须「可离线重跑」—— 之前两次线上构建失败，教训就是不要让构建依赖运行时环境；
 *      内容在仓库里，构建就是纯本地的。
 *   2. git 自带版本历史：谁改的、什么时候、改前是什么，`git log` 就是内容变更史。
 *   3. 出问题 `git revert` 一下就回去了，不需要自己实现回滚。
 *
 * 需要的 secret：GITHUB_TOKEN（细粒度 PAT，只授权本仓库、只给 Contents: Read and write）
 */

import { normalizeDoc } from '../shared/community-doc.mjs';
import type { Env } from './http';

const DEFAULT_REPO = 'hhjjdsj/ze-map-site';
const DEFAULT_BRANCH = 'main';
const DEFAULT_API = 'https://api.github.com';

export class GitError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

const repo = (env: Env) => env.GITHUB_REPO || DEFAULT_REPO;
const branch = (env: Env) => env.GITHUB_BRANCH || DEFAULT_BRANCH;
const apiBase = (env: Env) => (env.GITHUB_API_BASE || DEFAULT_API).replace(/\/+$/, '');

export const communityPath = (slug: string) => `data/community/${slug}.json`;

/* ===== base64（Workers 的 btoa 只吃 latin1，中文必须自己转） ===== */

function toBase64Utf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function fromBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ===== GitHub REST ===== */

async function gh(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  if (!env.GITHUB_TOKEN) {
    throw new GitError('缺少 GITHUB_TOKEN，无法读写仓库（见 docs/community-editing-plan.md 第 9 节）', 503);
  }
  return fetch(apiBase(env) + path, {
    ...init,
    headers: {
      'user-agent': 'ze-map-site-worker',
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'x-github-api-version': '2022-11-28',
      ...((init.headers as Record<string, string>) || {}),
    },
  });
}

export interface CommunityFile {
  doc: ReturnType<typeof normalizeDoc>;
  /** 文件当前的 blob sha；文件不存在时为 null（新建） */
  sha: string | null;
}

/** 读社区文档；文件不存在返回空文档（不是错误） */
export async function readCommunityDoc(env: Env, slug: string): Promise<CommunityFile> {
  const res = await gh(
    env,
    `/repos/${repo(env)}/contents/${communityPath(slug)}?ref=${encodeURIComponent(branch(env))}`
  );
  if (res.status === 404) return { doc: normalizeDoc(slug, null), sha: null };
  if (!res.ok) throw new GitError(`读取仓库文件失败（HTTP ${res.status}）`, 502);

  const data = (await res.json()) as { content?: string; sha?: string };
  let parsed: unknown = null;
  if (data.content) {
    try {
      parsed = JSON.parse(fromBase64Utf8(data.content));
    } catch {
      // 文件被改坏了也别让整条链路炸：当成空文档，本次审核会把它重写成合法结构
      parsed = null;
    }
  }
  return { doc: normalizeDoc(slug, parsed), sha: data.sha ?? null };
}

/**
 * 写入社区文档并提交。
 * 用 contents API 的 sha 做乐观并发：拿到的 sha 过期时 GitHub 会拒绝，
 * 我们上抛 409 让审核员重试 —— D1 里的投稿还在，不会丢数据。
 */
export async function writeCommunityDoc(
  env: Env,
  slug: string,
  doc: unknown,
  message: string,
  /**
   * 调用方读文件时拿到的 blob sha。
   * 不传会自己再读一次（方便单独调用），但**审核流程必须传**：
   * 否则「读 → 改 → 写」之间多出一次读，期间别人改了文件就会被静默覆盖。
   */
  knownSha?: string | null
): Promise<{ sha: string; created: boolean }> {
  const currentSha = knownSha === undefined ? (await readCommunityDoc(env, slug)).sha : knownSha;
  const body = JSON.stringify(doc, null, 2) + '\n';

  const res = await gh(env, `/repos/${repo(env)}/contents/${communityPath(slug)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message,
      content: toBase64Utf8(body),
      branch: branch(env),
      ...(currentSha ? { sha: currentSha } : {}),
    }),
  });

  if (res.status === 409 || res.status === 422) {
    throw new GitError('仓库里的这个文件刚刚被改动过，请刷新后重试', 409);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GitError(
      `写回仓库失败（HTTP ${res.status}）${detail ? '：' + detail.slice(0, 200) : ''}`,
      502
    );
  }

  const data = (await res.json()) as { commit?: { sha?: string } };
  return { sha: data.commit?.sha ?? '', created: !currentSha };
}

/* ===== 二进制文件（投稿封面图）=====
 *
 * 为什么用 contents API 而不是 Git Data API：
 *   封面上限 700 KB（见 worker/covers.ts 的说明），base64 后约 960 KB，
 *   在 contents API 的承受范围内；换成 blob/tree/commit/ref 四步反而更长、
 *   还丢掉「按 sha 做乐观并发」这个现成的保护。
 */

export interface RepoFileEntry {
  name: string;
  path: string;
  sha: string;
}

/** 列目录（contents API 返回数组）。目录不存在返回空数组，不算错误。 */
export async function listRepoDir(env: Env, dir: string): Promise<RepoFileEntry[]> {
  const res = await gh(env, `/repos/${repo(env)}/contents/${dir}?ref=${encodeURIComponent(branch(env))}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new GitError(`读取仓库目录失败（HTTP ${res.status}）`, 502);
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) return [];
  return data
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object' && e.type === 'file')
    .map((e) => ({ name: String(e.name), path: String(e.path), sha: String(e.sha) }));
}

/** 取单个文件的 blob sha；不存在返回 null */
export async function repoFileSha(env: Env, path: string): Promise<string | null> {
  const res = await gh(env, `/repos/${repo(env)}/contents/${path}?ref=${encodeURIComponent(branch(env))}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new GitError(`读取仓库文件失败（HTTP ${res.status}）`, 502);
  const data = (await res.json()) as { sha?: string };
  return data.sha ?? null;
}

/** 写一个二进制文件（新建或覆盖） */
export async function writeRepoBinary(
  env: Env,
  path: string,
  bytes: Uint8Array,
  message: string
): Promise<{ sha: string; created: boolean }> {
  const currentSha = await repoFileSha(env, path);
  let bin = '';
  const CHUNK = 0x8000; // 一次展开太多会爆栈
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const content = btoa(bin);

  const res = await gh(env, `/repos/${repo(env)}/contents/${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message,
      content,
      branch: branch(env),
      ...(currentSha ? { sha: currentSha } : {}),
    }),
  });

  if (res.status === 409 || res.status === 422) {
    throw new GitError('仓库里的这个文件刚刚被改动过，请刷新后重试', 409);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GitError(
      `写回仓库失败（HTTP ${res.status}）${detail ? '：' + detail.slice(0, 200) : ''}`,
      502
    );
  }
  const data = (await res.json()) as { commit?: { sha?: string } };
  return { sha: data.commit?.sha ?? '', created: !currentSha };
}

/** 删一个文件（换封面时清掉同名的其它扩展名）。文件不存在视为成功。 */
export async function deleteRepoFile(env: Env, path: string, message: string): Promise<boolean> {
  const sha = await repoFileSha(env, path);
  if (!sha) return false;
  const res = await gh(env, `/repos/${repo(env)}/contents/${path}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, sha, branch: branch(env) }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GitError(
      `删除仓库文件失败（HTTP ${res.status}）${detail ? '：' + detail.slice(0, 200) : ''}`,
      502
    );
  }
  return true;
}
