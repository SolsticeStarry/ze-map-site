# 账号系统（P4）

> 2026-10-11 上线。`/account/` 页、`/api/register|login|logout|me|password|profile`，
> 以及投稿挂账号（署名 / 我的投稿 / 等级 / 免审）。
> 想知道「为什么不那样做」「出问题先看哪里」看这份。

## 一句话原则

**登录始终是可选的。** 不登录照样在 `/submit/` 投稿，走的是完全没动过的匿名通道；
登录只是额外拿到三件事：

| 拿到什么 | 怎么来的 |
|---|---|
| 稳定署名（别人冒不了名） | 投稿时用**账号昵称**覆盖手填昵称，`submissions.user_id` 记下是谁投的 |
| 个人主页的投稿记录 | `/account/` 读 `/api/me` 列出自己最近 50 条（含待审 / 已通过 / 驳回理由 / 提交号） |
| 等级与免审资格 | 按**已写回仓库**的投稿数算（见下），到门槛后投稿直接进「待写回」队列 |

投稿页顶部那条横幅会明说当前状态：没登录 → 「不登录也能投」；登录了 → 「署名固定用账号昵称」。

## 数据在哪

- 账号只在 **D1**（`ze-map-community`）的 `users` 表；仓库里**没有任何用户数据**。
- 口令只存 `pbkdf2$100000$盐$派生值`（PBKDF2-SHA256 / **10 万次**迭代 / 每用户 16 字节随机盐）。
  ⚠️ 10 万是 Cloudflare Workers WebCrypto 的**硬上限**，写 15 万线上会直接
  `NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported`
  —— 本地 Node 没这个限制，所以只有 `worker/auth.test.mjs` 里那条断言能提前拦住它（2026-10-11 踩过）。
  不存明文、不存可逆哈希、不存邮箱 —— 找回口令走 QQ 群找站长（和现有运营方式一致）。
- 投稿与账号的关联是 `submissions.user_id`（匿名投稿是 `NULL`）。
- `migrations/0003_users.sql` 是**给人看的记录**：线上不靠它建表，见下面「懒建表」。

## 会话：无状态签名 Cookie

`zc_sess` = `base64url(payload).base64url(HMAC-SHA256(payload))`，payload 是
`{u: 用户id, v: 口令版本, t: 签发时间}`，有效期 90 天。

- **不建 sessions 表、不查 KV。** KV 免费版每天只让写 1000 次（前面踩过），
  而且每次请求多一次查询纯属白花；签名 Cookie 让「读登录状态」零成本。
- 签名密钥优先 `SESSION_SECRET`，没配就用 `IP_SALT` 派生（两者都只存在于 Worker）。
- `pass_ver` 在改口令时 +1：**改一次口令，其它设备上的旧 Cookie 立刻失效**。
- 本地开发（localhost）下发 Cookie 时不带 `Secure`，否则浏览器直接不收。
- 想强制所有人重新登录：换 `IP_SALT` / 配一个 `SESSION_SECRET` 即可。

## 懒建表（为什么不用 `wrangler d1 migrations apply`）

本机的 Cloudflare API token **只有 R2 权限**（KV 都被拒过 `code: 10000`），跑不了远端 D1 迁移。
所以 `worker/auth.ts` 的 `ensureSchema()` 在第一次用到账号功能时自己补结构（幂等）：

```
CREATE TABLE IF NOT EXISTS users (...)
CREATE INDEX  IF NOT EXISTS idx_users_name_key ...
PRAGMA table_info(submissions)  → 没有 user_id 就 ALTER TABLE submissions ADD COLUMN user_id INTEGER
CREATE INDEX  IF NOT EXISTS idx_sub_user ...
```

- 每个 isolate 只跑一次（模块级 `schemaReady`）；失败只打日志、不抛，`accountForSubmit` 里
  每次投稿前也会先调一遍 —— 这样**新库上第一条投稿就不会因为缺 `user_id` 列而 500**。
- 真踩过的坑见「投稿那条路不能依赖账号结构」。

## 等级与免审（`levelOf`）

| 等级 | 门槛（已写回条数） |
|---|---|
| 路人 | 0 |
| 入门贡献者 | 1 |
| 资料整理者 | 5 |
| 资深编辑 | 10 |
| 荣誉编辑 | 25 |
| 百科元老 | 50 |

- 统计口径在 `recalcUserStats()`：**每张图的每个字段只算一次**（`COUNT(DISTINCT map_slug||'|'||field)`），
  否则把一次改动拆成三条提交就能刷等级。
- **只有 `status='applied'`（已写回仓库）算「通过」**；免审直发那条停在 `approved`（待写回），
  写回后才涨。`rejected` 同理按图+字段去重。
- 免审资格：`approved >= 10 && rejected <= floor(approved / 5)`。到门槛后投稿
  `status='approved'`（直接随下一批写回），响应里 `autoApproved: true`。
- 统计刷新时机：登录、`/api/me`、以及审核台写回那一批结束时顺手刷（`handleAdminFlush`）。

## 投稿那条路不能依赖账号结构（踩过的坑）

`submissions.user_id` 是账号上线后才加的列。老库里没有它，于是「匿名投稿也把 `user_id`
写进 INSERT 列清单」会让**还没人登录过时的第一条投稿**报 `no column named user_id` → 500。
账号系统把投稿拖垮，正好是最不能接受的失败方式。所以：

- 匿名投稿**压根不提 `user_id`**（老库新库都能跑，缺列时默认就是 `NULL`）；
- 登录投稿才带上它；万一那一列还是写不进去，`insertSubmission()` 退回**匿名 + 待审**，
  稿子照收，只是丢署名与免审（`degraded = true`，日志里有一行）。
- 三个入口共用这个函数：`/api/submit`、`/api/submit-cover`、`/api/submit-gallery`。

另一个坑：`crypto.subtle.importKey('raw', key, 'HMAC', ...)` 里的 `'HMAC'` 必须写成
`{ name: 'HMAC', hash: 'SHA-256' }` —— `HmacImportParams.hash` 是必填，写字符串按规范直接抛
`hash is required in 'HmacImportParams'`，整个注册接口 500。

## 接口一览

| 接口 | 说明 |
|---|---|
| `POST /api/register` | 昵称（2~20 字，唯一，忽略大小写）+ 口令（≥8 位）+ 选填联系方式；成功即登录 |
| `POST /api/login` | 昵称 + 口令；昵称不存在与口令错给**同一句** 401（不给撞库的人区分依据） |
| `POST /api/logout` | 下发 `Max-Age=0` 的清 Cookie |
| `GET /api/me` | `{user, submissions, counts}`；未登录 `user: null`，**200 而不是 401**（前端不必分支出错态） |
| `POST /api/password` | 旧口令 + 新口令；旧 Cookie 全部作废，给当前设备续一个新 Cookie |
| `POST /api/profile` | 改昵称 / 联系方式；昵称只影响**以后**的署名，历史投稿不改 |

`counts` 是个人页那四个数字块用的：`{pending, approved, applied, rejected}`，
一条 SQL `GROUP BY status` 数出来。口径与 `user.approved` / `user.rejected` **不同**：
后者是等级口径（按「地图 + 字段」去重），`counts` 是**投稿条数**（同一处改三次就是三条）。
页面上两个都显示，标签分别写「已通过（按图 + 字段去重）」与「待写回 / 待审核 / 被驳回」。

限流：注册 + 登录共用一个桶，同一 IP 每小时 30 次（`allowWrite(env, ipHash, 'auth', 30)`）。
其它接口全部照旧（`/api/submit` 那条 300/小时 + 2000/天的桶没动）。

`worker/index.ts` 的 `fetch` 外面包了一层 try/catch：任何没接住的异常现在回 **JSON 500**
（以前是 Cloudflare 的 HTML 错误页，前端 `.json()` 直接报「请求失败」）。

## 前端在哪

- `src/pages/account.astro`：静态外壳 + 一段脚本打 `/api/me`。**接口挂了只是那几个框不显示**，
  浏览与投稿不受影响（横幅会写「登录状态没读到（接口没通）—— 不影响投稿」）。
  视觉（2026-10-11 重做）：未登录是「中间一张卡（注册 / 登录用滑块切换）+ 下面一排三条价值」；
  登录后是一张个人卡片（渐变头像 + 等级徽章 + 升级进度条 + 四个彩色数字块）、
  带封面缩略图与状态色条的投稿记录、两块设置。
- `src/pages/account/map-titles.json.ts`：给「我的投稿」用的 `slug → [中文名, 封面]` 索引
  （954 张图，80 KB / gzip ~19 KB，**只有登录的人才会请求**）。整站的 `/submit/maps.json`
  有 590 KB，为个人页拉它太浪费；拿不到这份索引就退回显示 slug。
- `src/pages/submit/index.astro`：`#sh-account` 状态条（登录后整条转绿、左边圆点变 ✓；
  未登录把「注册账号 →」做成胶囊按钮）+ 昵称框（登录后 `readOnly`）+ 右侧「不登录也能投」。
- 样式在 `src/styles/global.css` 的「账号」一节（`.acc-*` / `.sh-account`）**不在页面 `<style>` 里**：
  个人页一半节点是脚本动态建的，动态节点拿不到 Astro 的作用域 class，写在页面里会静默失效。
- 导航栏有一项「账号」（`BaseLayout.astro`），页脚没有 —— 页脚那行留给内容入口。
- 亮色主题单独调过：渐变数字、荧光色药丸、等级徽章在浅底上会糊，`.acc-*` 那一节末尾有一组
  `[data-theme="light"]` 覆盖。

## 数据安全边界（想知道「最坏会怎样」）

- 页面是静态的，`run_worker_first` 只覆盖 `/api/*`：**账号接口全挂，站点照常浏览**。
- D1 只存账号与待审投稿；已发布内容在仓库里，库清空也能重建。
- 不存明文 IP（只存加盐哈希），不存邮箱，不回传 `pass_hash`（`publicUser()` 白名单）。
- 枚举 `/api/me` 拿不到别人的东西：只看 Cookie 里的自己。
- CSRF：会话 Cookie 是 `HttpOnly; SameSite=Lax`，且所有 `/api/*` 请求都过 `checkOrigin()`
  —— 别的站点发起的请求带了 `Origin` 就会被 403 挡掉（表单跨站 POST 一定会带）。
- XSS 面：账号页 / 投稿页全部用 `textContent` 赋值（`innerHTML` 只用在拼接本站固定文案 +
  已经过 `checkName()` 白名单过滤的昵称上），所以「昵称里塞标签」这条路走不通。

## 怎么验

```bash
npm run test:worker       # 账号 + 投稿的回归测试（21 项，esbuild 打 Worker + node:sqlite 当真 D1）
npm run build             # 页面构建（/account/ 是静态页）
npm run preview           # 静态预览：没接口时页面必须照常显示、横幅写「接口没通」
wrangler dev              # 起真 Worker（本地 D1）：注册 → 投稿 → 个人页全流程
```

`worker/auth.test.mjs` 的做法值得照搬：esbuild 把 `worker/index.ts` 打成 ESM bundle，
`node:sqlite` 当 **D1 的替身**（**真 SQL**：`CREATE TABLE` / `PRAGMA` / `RETURNING` / UPSERT
都是真跑，不是打桩），然后直接 `worker.fetch(new Request(...))` 打接口，最后用 SQL 检查库里的行。
21 项覆盖：匿名投稿（含账号表还不存在时）、Cookie 伪造与篡改、重名与昵称校验、
署名覆盖、写回后升级、免审直发、统计口径去重、改口令后旧 Cookie 失效、限流、懒建表幂等与降级。

**其中两个 500 级 bug 就是这套东西在上线前抓到的**：匿名投稿依赖 `user_id` 列
（老库没这列 → 第一条投稿就 500）、`importKey` 的 `'HMAC'` 缺 `hash`
（注册接口整个 500）。不然它们会等到线上第一次投稿 / 第一次注册才炸。
