/**
 * 昵称审核规则（**通用**部分，前后端共用 —— 纯 JS，不写 TypeScript 语法）。
 *
 * 背景（2026-10-11 站长问的）：注册昵称以前只校验长度与字符，任何违法/广告词都能注册。
 * 昵称虽然**不会自己公开**（只有投稿经站长「写回仓库」后才作为署名出现在条目里），
 * 但库里躺着难看的名字本身就不该发生。于是加了这一层。
 *
 * ⚠️ 三类词表分开放，别混：
 *   1. **通用违禁/广告/联系方式的词** → 就在这个文件里（公开也无所谓）；
 *   2. **政治等敏感词** → **不进仓库**，放在 Worker 变量 `NICKNAME_EXTRA` 里
 *      （`wrangler secret put NICKNAME_EXTRA`，逗号或换行分隔）。原因是线上是 Cloudflare
 *      从仓库构建的，本地文件根本到不了线上；而且把「我们过滤哪些词」公示出去等于给人抄作业。
 *   3. 长度/字符/保留昵称那几条仍在 worker/auth.ts（那是**防注入与防冒充**，性质不同）。
 *
 * 做法上必须**归一化之后再查**：否则「管 理 员」「4dmin」「ＡＤＭＩＮ」这些都能绕过去。
 * 归一化只用于**匹配**，存进库的始终是用户原本输入的样子。
 */

/** 轻归一化：只做全角转半角、去零宽、转小写 —— **保留数字与 . @ : 这些符号** */
export function lightNormalize(input) {
  let s = String(input ?? '');
  s = s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/[\u3000\u200B-\u200D\uFEFF]/g, '');
  return s.toLowerCase();
}

/** 全归一化（用于**词表匹配**）：在轻归一化之上再做 leet 替身、去掉分隔符 */
export function normalizeName(input) {
  let s = lightNormalize(input);
  /* leet 变体：@→a 0→o 1→l 3→e 4→a 5→s 7→t 9→g !→i |→l */
  s = s.replace(/[0134579@$!|]/g, (c) => ({ '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '9': 'g', '@': 'a', '$': 's', '!': 'i', '|': 'l' }[c] ?? c));
  /* 分隔符：空格、点、下划线、破折号、间隔号、常见标点 —— 「管 理·员」要能连起来 */
  s = s.replace(/[\s._\-·~—–。，,、:：;；'"`^*+=[\]()（）<>《》/\\]+/g, '');
  return s;
}

/**
 * 通用词库（**不含政治类**）。
 * 判定的是「归一化之后包含」——所以这里写「加微信」，也能拦住「加 微 信」。
 */
export const BASE_BLOCKLIST = [
  /* 广告 / 导流 */
  '代练', '代打', '代肝', '出售', '售卖', '低价', '打折', '免费送', '白嫖号',
  '加微信', '加qq', '加我', '私聊', '接单', '下单', '包邮', '广告位', '推广位',
  '外挂', '脚本售卖', '刷单', '兼职', '日结', '返利', '引流', '涨粉',
  /* 赌博诈骗 */
  '博彩', '赌博', '赌场', '棋牌室', '开户', '洗钱', '跑分', '套现', '贷款', '办卡',
  '彩票代购', '六合彩', '时时彩', '返水',
  /* 色情 */
  '色情', '裸聊', '约炮', '招嫖', '嫖娼', '迷药', '催情', '黄片', '成人片', '一夜情',
  /* 违法 */
  '毒品', '冰毒', '大麻', '枪支', '弹药', '办证', '发票', '假证', '走私', '洗货',
];

/** 联系方式 / 链接 —— 昵称里出现这些基本就是广告，指路到「联系方式」字段 */
const CONTACT_RES = [
  /https?:\/\//,
  /www\./,
  /[\w.+-]+@[\w-]+\.[a-z]{2,}/,
  /\.(com|cn|net|org|top|xyz|vip)\b/,
  /\d{6,}/,                                  /* QQ / 手机号 6 位以上连续数字 */
  /(vx|wx|qq|v信|威信|扣扣|微信|企鹅)\s*[:：]?\s*[\w-]{4,}/,
  /(加|扣|联|找)\s*\d{4,}/,
];

/**
 * 检查一个昵称。
 * @param {string} raw 用户输入
 * @param {string[]} extra 额外词表（来自 Worker 变量 NICKNAME_EXTRA，不入库）
 * @returns {{ok: true} | {ok: false, reason: 'word' | 'contact' | 'noise'}}
 *
 * ⚠️ 只回**类别**，不回命中哪个词 —— 否则等于把词库送给想绕过的人做实验。
 */
export function checkNicknameContent(raw, extra = []) {
  const light = lightNormalize(raw);
  const norm = normalizeName(raw);
  if (!norm) return { ok: false, reason: 'noise' };

  for (const w of [...BASE_BLOCKLIST, ...extra]) {
    const key = normalizeName(w);
    if (key && norm.includes(key)) return { ok: false, reason: 'word' };
  }

  /*
   * 联系方式 / 链接查的是**轻归一化**（保留数字与 . @ :）——
   * 全归一化会把 1→l、0→o，`123456789` 会变成 `l2e4s6t8g`，QQ 号就漏过去了（写测试时真踩到）。
   */
  for (const re of CONTACT_RES) {
    if (re.test(light) || re.test(norm)) return { ok: false, reason: 'contact' };
  }

  /* 乱码：同一个字符连 6 个以上，或者完全没有文字/数字（纯符号） */
  if (/(.)\1{5,}/.test(norm)) return { ok: false, reason: 'noise' };
  if (!/[\p{Script=Han}a-z0-9]/u.test(norm)) return { ok: false, reason: 'noise' };

  return { ok: true };
}

/** 解析 Worker 变量 NICKNAME_EXTRA（逗号 / 顿号 / 换行分隔，支持 # 注释） */
export function parseExtraBlocklist(raw) {
  return String(raw ?? '')
    .split(/[,，、\n\r]+/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
}

/** 给用户看的拒绝理由 */
export function nicknameRejectMessage(reason) {
  if (reason === 'contact') {
    return '昵称里不能放联系方式或网址（QQ / 微信 / 手机号 / 链接都不行）—— 想留联系方式请填下面的「联系方式」，只有站长看得到';
  }
  if (reason === 'noise') return '这个昵称看起来像乱码或纯符号，换一个正常点的吧';
  return '这个昵称里有不被允许的内容（广告或违法信息之类的词），换一个吧';
}
