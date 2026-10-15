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

/**
 * 未读数变了（2026-10-15 邮箱加）时广播。
 * 场景：在 /inbox/ 里读了一条信，页头那个铃铛／导航「邮箱」标签上的红点得立刻跟着掉 ——
 * 否则要等下一个 2 分钟的轮询，看着就像「读了没生效」。
 * detail.unread 有值就直接用它（省一次请求）；没值就让页头自己去问一次。
 */
export const NOTIFY_EVENT = 'ze-notify-changed';

export function notifyChanged(): void {
  lite = null;
  full = null;
  document.dispatchEvent(new CustomEvent(ACCOUNT_EVENT));
}

export function notifyInboxChanged(unread?: number): void {
  document.dispatchEvent(new CustomEvent(NOTIFY_EVENT, { detail: { unread } }));
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

/* 收件箱铃铛图标（2026-10-14）：和上面同一个路子，内联 SVG */
export const BELL_ICON =
  '<svg class="am-icon" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M6.4 9.8a5.6 5.6 0 0 1 11.2 0c0 3.6.9 5.2 1.7 6.1.3.4 0 1-.5 1H5.2c-.5 0-.8-.6-.5-1 .8-.9 1.7-2.5 1.7-6.1Z"></path>' +
  '<path d="M9.7 19.2a2.4 2.4 0 0 0 4.6 0"></path>' +
  '</svg>';

/* ===== 收件箱（2026-10-14） ===== */

/** 收件箱里的一条通知。字段与 worker/notifications.ts 的返回一一对应 */
export interface AccountNotification {
  id: number;
  /** review=审核结果 / flush=写回上线 / adopt=草稿被采纳 / account=账号事件 / announce=站长公告 */
  kind: string;
  title: string;
  body: string;
  /** 点开详情后的去处（站内路径或 https 链接），可能没有 */
  link: string | null;
  submissionId: number | null;
  /** 全员公告（user_id 为空）—— 界面上标一下「公告」 */
  broadcast: boolean;
  createdAt: number;
  read: boolean;
}

export interface NotificationPage {
  items: AccountNotification[];
  unread: number;
  total: number;
  limit: number;
  offset: number;
  /** 这一页属于哪个文件夹（服务端原样回，默认 all） */
  folder?: MailFolder;
  /** 左侧几档各自的条数（邮箱用；收件箱面板只看 unread/total） */
  counts?: Record<MailFolder, number>;
}

/**
 * 邮箱的文件夹（2026-10-15 加，与 worker/notifications.ts 的 parseFolder 一一对应）：
 *   all 全部 / unread 未读 / announce 站长公告 / mine 投稿通知 / account 账号事件
 */
export type MailFolder = 'all' | 'unread' | 'announce' | 'mine' | 'account';

/**
 * 取收件箱的一页。**接口不通就抛**（调用方决定是显示红点还是静默）：
 * 页头铃铛只想拿 unread，所以允许 limit=1。
 */
export async function fetchNotifications(offset = 0, limit = 10, folder: MailFolder = 'all'): Promise<NotificationPage> {
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset), folder });
  const res = await fetch(`/api/me/notifications?${qs.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as Partial<NotificationPage>;
  return {
    items: data.items ?? [],
    unread: Number(data.unread ?? 0),
    total: Number(data.total ?? 0),
    limit: Number(data.limit ?? limit),
    offset: Number(data.offset ?? offset),
    folder: data.folder ?? folder,
    counts: data.counts,
  };
}

/** 标记已读：给 ids 就标那几条，all=true 就把看得见的全标了。返回新的未读数。 */
export async function markNotificationsRead(
  payload: { ids?: number[]; all?: boolean }
): Promise<{ marked: number; unread: number }> {
  return postRead(payload);
}

/**
 * 标为未读（2026-10-15 邮箱加）：正常邮箱都有这个键 ——
 * 「这条我看了但还得再处理」，先放回未读，红点会重新亮起来。
 */
export async function markNotificationsUnread(ids: number[]): Promise<{ marked: number; unread: number }> {
  return postRead({ ids, unread: true });
}

async function postRead(payload: {
  ids?: number[];
  all?: boolean;
  unread?: boolean;
}): Promise<{ marked: number; unread: number }> {
  const res = await fetch('/api/me/notifications/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as { marked?: number; unread?: number; error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return { marked: Number(data.marked ?? 0), unread: Number(data.unread ?? 0) };
}
