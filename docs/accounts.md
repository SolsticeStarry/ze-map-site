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
| **资料奠基人** | **80**（2026-10-11 站长加的：SiKi 一个人铺了 82 处资料，原来的顶档 50 对他来说太容易 —— 加一档让「把整站资料从零铺起来」有个够得着但极难到的位置） |

加档位只需往 `worker/auth.ts` 的 `LEVELS` 里插一行（**必须按 `min` 从大到小**，
`levelOf` 是按顺序 `find` 的），再在 `account.astro` / `AccountMenu.astro` 的 `LV` 映射里
补一个配色档位、在 `global.css` 的 `.acc-level-name[data-lv="n"]` 加一条颜色。

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

限流：**注册与登录各用一个桶，注册严得多**（见下节「防滥用」）。
其它接口全部照旧（`/api/submit` 那条 300/小时 + 2000/天的桶没动）。

`worker/index.ts` 的 `fetch` 外面包了一层 try/catch：任何没接住的异常现在回 **JSON 500**
（以前是 Cloudflare 的 HTML 错误页，前端 `.json()` 直接报「请求失败」）。

## 防滥用（2026-10-11 加的一层）

站长问「这种简单的注册方式会不会被人恶意刷」。真正会被打的**不是登录**（口令是 PBKDF2 派生的、
会话是签名的、SQL 全绑定参数），而是**额度**：D1 免费版每天只有 10 万行写，一次注册写 2~3 行，
分布式刷号能把额度吃光 —— 那会**连累投票和投稿一起写不进去**，是唯一会让正常用户受影响的路径。
所以按四道闸递减，而且**全部放在算哈希之前**（被拦的请求不花 CPU、不写库）：

| 闸 | 值 | 拦什么 |
|---|---|---|
| 封禁来源 | `bans` 表 | 已经确认的滥用者（以前注册/登录漏了这道检查，2026-10-11 补上） |
| 单 IP 每小时 | `REGISTER_PER_HOUR = 3` | 脚本刷号（正常人一小时也注册不了 3 个） |
| 单 IP 每天 | `REGISTER_PER_DAY = 3` | 站长定的硬线：**一个网络出口一天最多贡献 3 个账号** |
| **全站 24 小时** | `NEW_ACCOUNTS_PER_DAY = 200` | 兜底 + 限制「机器人一天能占掉多少昵称」 |

- 第 4 条是**数 `users` 里最近 24 小时的条数**（配 `idx_users_created` 索引），不额外写库、不会漂移。
  200 × 3 行 ≈ 600 行写入，只占 D1 每日 10 万行额度的 0.6% —— 所以这条已经不是"省额度"，
  而是别让机器人一天扫掉几百个昵称。到顶时的文案必须写清「不影响投稿 —— 不登录也能投」。
- **副作用**（站长知情并接受）：同一个网络出口（宿舍 / 公司 / 学校）一天只能注册 3 个，
  第 4 个人会看到「同一个网络出口今天已经注册过 3 个账号了……急用可以在 QQ 群里找站长」。
  这也是保留昵称名单里**不能**放已知贡献者名字的原因 —— 别把他们自己挡在门外。
- **代价**：站点真火起来时，「今天名额用完了」会提前出现 → 那天把常量调大，
  同时该去 Cloudflare 给注册接 Turnstile（`TURNSTILE_SECRET` 的基础设施投稿那边已经在用）。
- **登录**另有账号级锁定：连续 `MAX_LOGIN_FAILS = 5` 次口令错 → 锁 `LOCK_MINUTES = 15` 分钟
  （`users.fail_count` / `users.locked_until`，懒建表补列）。只有 IP 限流的话，攻击者换 IP
  就能接着猜**同一个账号**。
- 不存在的昵称也要走一次假哈希（`timingDecoy()`）：以前「昵称不存在」1ms 就返回、口令错要算 10 万次
  （实测线上 ~27ms），这点时间差能用来枚举哪些昵称已被注册。
- 保留昵称（`RESERVED_NAMES`：站长 / 管理员 / admin / 官方 …）不许注册，防冒充站方。
  **已知贡献者的昵称故意不在里面** —— 占了他们的名字由人工处理（回填历史功劳之前会先确认人是谁）。
- 审核台多了「**账号**」标签（`/api/admin/accounts`）：账号总数、最近 24 小时新增、锁定数，
  以及每个账号的**停用 / 恢复 / 解除锁定 / 重置口令**。以前 `users.banned` 这一列和检查都在，
  但没有任何入口能改它，想停用一个刷号账号只能手改数据库。
- **重置口令**是本站唯一的「忘记口令」找回入口（不收邮箱，只能人工）：点一下会给账号换一个
  10 位临时口令（字母表去掉了 0/O/1/l/I 这些容易看错的字符），明文只显示给拿着 ADMIN_TOKEN 的站长，
  由他转告本人；同时 `pass_ver + 1` —— **旧设备上的登录立刻失效**，请本人登录后自己去账号页改掉。
  2026-10-11 加这个功能的直接原因：有位贡献者注册完就登不进去了（口令对不上，只失败 1 次、没被锁），
  而没有邮箱就只能靠手改数据库。

## 人机验证（Turnstile，2026-10-11 接入）

- Site Key 是公开的，写在 `shared/turnstile.mjs`；**Secret 只在 Worker**（`wrangler secret put TURNSTILE_SECRET`）。
- **范围（站长拍的）：注册 / 登录必须过验证，投稿宽松** —— 投稿带了 token 就验、没带也放行。
  理由：投稿是这站存在的意义，而开了严格隐私设置的浏览器（Edge 默认跟踪防护、拦第三方脚本的插件）
  可能根本加载不出 widget。2026-10-11 在 headless Edge 上实测过：日志一直刷
  `Tracking Prevention blocked access to storage for challenges.cloudflare.com`，token 永远出不来
  （真实浏览器没这个问题——站长自己开页面看到的是「成功!」）。代价：刷投稿只能靠原有的
  IP 限流（300/小时、2000/天）+ 人工审核 + 封禁。
- **上线顺序不能反**：投稿那三个接口一直写着「配了 secret 就强制校验」，所以必须
  **先上带 widget 的前端、最后配 secret**；反了的话投稿会当场全部失败。
- `worker/turnstile.ts` 把「token 不对」与「Cloudflare 校验服务不可达」分开返回，
  提示分两句：前者让用户去点方框/刷新，后者说「服务暂时不可用，不是你的问题」——
  混成一句会让人以为站点坏了。
- 前端在 `src/lib/turnstile.ts`：`execution` 用 Managed（正常访客无感），`size: flexible`
  （页头面板只有 336px，固定 300px 会溢出），本地开发自动切到 Cloudflare 官方**测试 key**
  （`1x00000000000000000000AA`，永远通过）。token **一次性**，提交失败必须 `reset()` 换新的。
- 校验服务不可达时是 **fail-closed**（拒绝），但删掉 secret 就能一键回退到「只靠限流」。

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
