/**
 * 登录状态的**唯一请求入口**（页头账号按钮 / 投稿页横幅 / 账号页共用）。
 *
 * 为什么抽出来：页头那个账号按钮要在每个页面都知道「登没登录、叫什么、几级」，
 * 投稿页顶部那条也要。各写各的就会在同一个页面打两三次 /api/me。
 * 这里把结果缓存住，一个页面视图只发一次请求；谁改了登录状态就调 notifyChanged()。
 *
 * 两个档位：
 *   · me()     → `/api/me?lite=1`：只要用户本身（页头/横幅够用，Worker 那边少两次查询）
 *   · meFull() → `/api/me`：连「我的投稿」与各状态条数一起要（账号页用）
 */

export interface AccountLevel {
  level: string;
  hint: string;
  approved: number;
  rejected: number;
  next: { level: string; need: number } | null;
  trusted: boolean;
}

export interface AccountUser extends AccountLevel {
  id: number;
  name: string;
  contact: string;
  createdAt: number;
  /**
   * 「授权 UP 主」称号（2026-10-13 加）：这个账号对应一位已同意本站收录其视频的 UP 主时才有。
   * 名单来自 R2 的 video-meta/agreed.json，站点昵称与 B 站昵称不一致的由管理台人工挂上
   * （worker 的 linkup 动作）。页面据此在昵称旁显示徽章。
   */
  up?: {
    /** B 站昵称（与站上视频署名一致） */
    name: string;
    /** B 站 UID */
    mid: string;
    /** 本站收录了他几条视频 */
    videos: number;
    /** 这些视频分布在几张图的页面上 */
    maps: number;
  };
  /**
   * 「仓库贡献者」称号（2026-10-13 加）：账号被人挂上 GitHub 用户名时才有。
   * 一个人可能有多个号（SiKi = trrrr-ai + MiKU），所以是列表；url 是 GitHub 主页
   * （多个号时指向仓库的贡献者页）。同样**只由管理台人工发放**。
   */
  gh?: {
    logins: string[];
    url: string;
  };
  /**
   * 绑定的 GitHub 身份（2026-10-14 加）：和上面的 gh（称号徽章）**不是一回事** ——
   * gh 只在「仓库贡献者」名单里才有；ghLogin 表示「这个账号绑了哪个 GitHub」。
   * hasPassword=false 表示这是 GitHub 建的号（还没设口令）：页面据此收起「原口令」那一栏、
   * 并告诉用户「想解绑先设口令」。
   */
  ghLogin?: {
    login: string;
    url: string;
    avatar: string;
    hasPassword: boolean;
  };
}

export interface AccountSubmission {
  id: number;
  map_slug: string;
  field: string;
  status: string;
  created_at: number;
  reviewed_at: number | null;
  reject_note: string | null;
  commit_sha: string | null;
}

export interface AccountCounts {
  pending: number;
  approved: number;
  applied: number;
  rejected: number;
}

export interface AccountMe {
  user: AccountUser | null;
  submissions: AccountSubmission[];
  counts: AccountCounts;
  /**
   * 站点开了哪些第三方登录（目前只有 GitHub）。
   * 没配密钥时 enabled=false —— 页面要把按钮换成一句说明，而不是给一个点了没反应的按钮。
   */
  github?: { enabled: boolean };
}

/** 登录状态变了（登录 / 注册 / 退出）时广播，页面上的其它块据此重画 */
export const ACCOUNT_EVENT = 'ze-account-changed';

export function notifyChanged(): void {
  lite = null;
  full = null;
  document.dispatchEvent(new CustomEvent(ACCOUNT_EVENT));
}

const EMPTY: AccountMe = {
  user: null,
  submissions: [],
  counts: { pending: 0, approved: 0, applied: 0, rejected: 0 },
  github: { enabled: false },
};

let lite: Promise<AccountMe> | null = null;
let full: Promise<AccountMe> | null = null;

async function request(url: string): Promise<AccountMe> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as Partial<AccountMe> & { user?: AccountUser | null };
  return {
    user: data.user ?? null,
    submissions: data.submissions ?? [],
    counts: data.counts ?? EMPTY.counts,
    github: data.github ?? { enabled: false },
  };
}

/**
 * 只问「我是谁」。失败时**返回空状态而不是抛**：
 * 页头按钮、投稿页横幅都不该因为接口没通就变成错误提示（那会挡住真正要做的事），
 * 想区分「没登录」和「接口没通」的地方用 meOrThrow()。
 */
export function me(): Promise<AccountMe> {
  lite ??= request('/api/me?lite=1').catch(() => EMPTY);
  return lite;
}

/** 同上，但接口不通时抛错（页头用它来决定按钮显示成「!」还是普通人像） */
export function meOrThrow(): Promise<AccountMe> {
  lite ??= request('/api/me?lite=1');
  return lite;
}

/** 连「我的投稿」一起要（账号页用） */
export function meFull(): Promise<AccountMe> {
  full ??= request('/api/me').catch(() => EMPTY);
  return full;
}

/* 顶部那个账号按钮的图标（人像）：内联 SVG，省一次请求、也能跟着 currentColor 变色 */
export const PERSON_ICON =
  '<svg class="am-icon" viewBox="0 0 24 24" aria-hidden="true">' +
  '<circle cx="12" cy="8.2" r="3.6"></circle>' +
  '<path d="M4.8 20.2c0-3.7 3.2-6.2 7.2-6.2s7.2 2.5 7.2 6.2"></path>' +
  '</svg>';
