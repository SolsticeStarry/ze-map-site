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
  2026-10-14 起多了 **GitHub 登录**（可选，见下面的「GitHub 登录」一节）：
  它只存 GitHub 的数字 id 与登录名，**同样不碰邮箱**。
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
CREATE TABLE IF NOT EXISTS bans / rate_limits / submissions   ← 2026-10-14 起也自己建
CREATE TABLE IF NOT EXISTS users (...)
CREATE INDEX  IF NOT EXISTS idx_users_name_key ...
ALTER TABLE users ADD COLUMN fail_count / locked_until / up_name / gh_names / gh_id / gh_login / gh_linked_at / gh_avatar
CREATE UNIQUE INDEX idx_users_gh ON users(gh_id) WHERE gh_id IS NOT NULL
PRAGMA table_info(submissions)  → 没有 user_id / batch 就 ALTER TABLE 补上
CREATE INDEX  IF NOT EXISTS idx_sub_user ...
```

- 每个 isolate 只跑一次（模块级 `schemaReady`）；**每一步各自兜错**（`step()`），
  一处失败不会把后面的步骤一起带走；失败只打日志、不抛，`accountForSubmit` 里
  每次投稿前也会先调一遍 —— 这样**新库上第一条投稿就不会因为缺 `user_id` 列而 500**。
- ⚠️ 2026-10-14 修的一个真坑：以前这里**假定 `submissions` / `bans` / `rate_limits` 已经存在**
  （生产的库是早先建好的，所以一直没暴露）。用全新的本地 D1 跑 GitHub 登录的端到端测试时，
  补列那句 `ALTER TABLE submissions …` 抛 `no such table: submissions`，把同一个 try 里
  后面的建表全跳过 → `isBanned()` 直接 500，表现成「GitHub 登录报服务器内部错误」。
  现在四张表都自己保证存在，并加了一条「全新的空库也能用」的单测。

## GitHub 登录（2026-10-14 加，**可选**的一条路）

站长的要求：**不强制**。GitHub 只是多出来的一条路 —— 口令注册 / 登录一行没动，
「不登录也能投稿」这条底线也没动；**没配密钥时整条路自动关闭**（页面上按钮换成一句说明）。

### 怎么开启（两步）

```bash
# 1) 在 GitHub 建一个 OAuth App（Settings → Developer settings → OAuth Apps）
#    Homepage:    https://ze-map.cn
#    Callback:    https://ze-map.cn/api/auth/github/callback   ← 必须挂在 /api/ 下（见下）
# 2) 把两把钥匙写进 Worker secret
wrangler secret put GITHUB_OAUTH_CLIENT_ID
wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
```

- **回调地址必须在 `/api/` 下**：只有 `/api/*` 与 `/terr/*` 会进 Worker
  （`wrangler.jsonc` 的 `run_worker_first`），挂到 `/auth/...` 会被静态资源层接走成 HTML 404。
- 没配密钥时：`/api/me` 回 `github.enabled = false`，页面不显示按钮、只显示一句
  「本站暂未开启 GitHub 登录」；`GET /api/auth/github/start` 回 503 + 一句人话。

### 三种落点（`handleGithubCallback`）

| 情况 | 结果 |
|---|---|
| 这个 GitHub 号**已经绑过**某个账号 | 直接登录那个账号（认 `gh_id`，登录名改了也认得出） |
| 当前**已登录**（想让已有账号绑上） | 绑定到当前账号（该账号若已绑过别的 GitHub 号 → 拒绝，先解绑） |
| 都没匹配上 | 用 GitHub 登录名建新号；昵称被占/保留名 → 依次试 `login-2`、`login-3`、`gh-login`、`gh-<id>`，全被占就让用户自己注册后绑定（**绝不抢别人的昵称**） |

- 已绑到**另一个**站内账号的 GitHub 号再来 → `gh=taken`，不自动改绑。
- 被封禁的账号 / 来源 → 一律拒（`gh=disabled` / `gh=banned`）。
- 建号占「全站 200 个新账号/24 小时」这道闸，但**不走**「单 IP 3 个/天」——
  那是给匿名注册防刷号用的；GitHub 账号本身有成本，同一个出口后面可能坐着好几位真人
  （改用 20 个/小时的小时桶）。

### 安全设计

| 项 | 做法 |
|---|---|
| CSRF | `state` 32 字节随机值 + **HttpOnly Cookie**（`zc_gh_state`，Path=/api/auth，10 分钟），constant-time 比对；GitHub 不支持 PKCE，这是唯一防线 |
| 令牌 | **access_token 不落库**：只用来读一次 `/user` 就丢（本站不需要以用户身份调 GitHub） |
| 授权范围 | 只要 `read:user`；**不申请 `user:email`**（本站本来就不收邮箱） |
| 用户信息 | 只存 `gh_id` / `gh_login` / `gh_linked_at` / `gh_avatar`（头像仅用于展示，页面暂未使用） |
| 称号 | `gh_names`（「仓库贡献者」）只在登录名**确实出现在仓库贡献者名单**时才自动写入；名单读不到（没配 `GITHUB_TOKEN`）就静默跳过 —— 不凭一句登录发称号 |
| 解绑 | `POST /api/auth/github/unbind`：**没有口令的账号不许解绑**（会把自己锁在外面）；已有口令的账号走正常登录态 |

### 没口令的账号（GitHub 建的号）

- `pass_hash` 写哨兵值 `github$<gh_id>`；`verifyPassword` 对哨兵值恒为 false（口令登录进不来）。
- `POST /api/password` 对**没有口令的账号不校验原口令**（否则他永远设不上口令 → 永远解绑不了）；
  已经有口令的账号照旧必须验原口令（有单测盯着这条底线）。
- 页面据此把「原口令」那一栏收起来，并写明「设一个口令就不用担心哪天 GitHub 登不上」。

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
| `GET /api/me/notifications` | 收件箱 / 邮箱（`?limit=&offset=&folder=`）：`{items, unread, total, folder, counts}`；未登录 401 |
| `POST /api/me/notifications/read` | 标已读：`{ids:[…]}` 或 `{all:true}`；标未读：`{ids:[…], unread:true}`；返回 `{marked, unread}`，幂等 |

`counts` 是个人页那四个数字块用的：`{pending, approved, applied, rejected}`，
一条 SQL `GROUP BY status` 数出来。口径与 `user.approved` / `user.rejected` **不同**：
后者是等级口径（按「地图 + 字段」去重），`counts` 是**投稿条数**（同一处改三次就是三条）。
页面上两个都显示，标签分别写「已通过（按图 + 字段去重）」与「待写回 / 待审核 / 被驳回」。

限流：**注册与登录各用一个桶，注册严得多**（见下节「防滥用」）。
其它接口全部照旧（`/api/submit` 那条 300/小时 + 2000/天的桶没动）。

`worker/index.ts` 的 `fetch` 外面包了一层 try/catch：任何没接住的异常现在回 **JSON 500**
（以前是 Cloudflare 的 HTML 错误页，前端 `.json()` 直接报「请求失败」）。

## 站内收件箱（2026-10-14 加）与邮箱页（2026-10-15 加）

页头账号按钮**左边**多了一个小铃铛（登录后才有）：有未读就亮红点（数字，>9 显示 `9+`），
点开是收件箱面板 —— 逐条点开看细节（正文 + 「去看看」链接），也能「全部已读」。
面板最底下有「**在邮箱里打开 →**」：完整版在 **`/inbox/`**（顶栏导航里也有「邮箱」这一项，
同样是登录后才出现，带同一个未读红点）。

### 邮箱页 `/inbox/`（站长的要求：「单开一个邮箱标签页，跟正常邮箱一样」）

静态页 + 两个接口，三栏：

| 位置 | 内容 |
|---|---|
| 左 | 文件夹：**全部 / 未读 / 站长公告 / 投稿通知 / 账号**，各带条数（未读那档的数字标红）；底下一张个人信息卡（头像 + 昵称 + 等级 + 已通过条数 → 个人主页） |
| 中 | 这一档的列表：未读圆点、标题、类别小标、摘要、相对时间；点一条看正文；底下「加载更多」 |
| 右 | 正文：类别 + 投稿号 + 信 #id、标题、完整时间、全文（保留换行）、「去看看 →」、**标为已读 / 标为未读**、窄屏下的「← 回到列表」 |

- 顶部还有「刷新」「全部标为已读」，`↑`/`↓`（或 `k`/`j`）能在列表里上下走。
- **进页面只是选中第一条、不标已读**（否则一打开红点就没了）；真正点开才算读。
- 在「未读」这一档里读完的信会从列表里走开（和邮箱一样），「标为未读」能把它放回来。
- 读了信立刻广播 `NOTIFY_EVENT`（`src/lib/account-client.ts`），页头铃铛与导航红点跟着掉，
  不用等下一个 2 分钟轮询。

`folder` 的分类口径（`worker/notifications.ts` 的 `parseFolder` / `folderWhere`，SQL 片段共用一份）：
`announce` = `user_id IS NULL`；`mine` = `kind IN ('review','flush','adopt')`；
`account` = 其余私信；`unread` = `read_at IS NULL`（跨分类）。不认识的 `folder` 一律当 `all`（不 400）。
`counts` 是**全局**的（与当前档无关），一条 `GROUP BY` 算出来，左栏一直有数可画。

**谁往里写**（全部是服务端自动的，`worker/notifications.ts` 的 `pushNotification`）：

| 事件 | 通知 | 写在哪 |
|---|---|---|
| 投稿通过（攒批） | 「投稿已通过：《图》」+ 说明还要等写回 | `handleAdminReview` |
| 投稿驳回 | 「投稿被驳回」+ 审核员写的理由 | 同上 |
| 写回仓库上线 | 「投稿已上线」——**按「人 + 图」聚合成一条**（一次攒批十几条不刷屏） | `handleAdminFlush` |
| 整篇草稿被采纳 | 「你整理的《图》草稿已被采纳」+ 替换/新增/保留几节 | `handleAdminAdopt` |
| 账号事件 | 停用 / 恢复 / 重置口令 / 改名 / 挂称号 | `handleAdminAccountAction` 等 |
| 站长公告 | 全员公告（`user_id IS NULL`，**只存一行**） | `POST /api/admin/announce`（审核台「发公告」按钮） |

设计上的几条硬规矩：

1. **写通知绝不能拖垮正事**：审核 / 写回 / 采纳里的插入全部 try/catch，失败只 `console.error` ——
   收件箱坏了不该让「通过一条投稿」变成 500。
2. **公告只有一行**：已读状态在 `notification_reads`（主键 `user_id + notification_id`），
   所以一条公告发给 100 个人也只有一行，各自的已读互不影响；`INSERT OR IGNORE` 保证重复标记幂等。
3. **看不到别人的**：列表与已读的 SQL 都带 `(user_id = ?1 OR user_id IS NULL)`，
   猜 id 也标不了别人的通知（单测「不会串号」盯着这条）。
4. **不写敏感内容**：重置口令那条**不带临时口令**（口令只回给拿 ADMIN_TOKEN 的站长，靠人转告）。
5. **前端不用 innerHTML**：通知正文里有地图名与审核理由（用户可控），全部 `createElement` + `textContent`。
6. 红点靠「进页面问一次 + 页面可见时每 2 分钟问一次 + 切回标签页立刻问」，
   未登录时**一个请求都不发**；面板展开的那条被点开即已读，且**不重建列表**（重建会把展开的收起来）。

两处踩过的坑（都补了回归测试）：`submissions.user_id` 没进采纳那条 SELECT（通知发不出去）；
空库上「先查封禁/限流、后建表」导致第一个请求 500 `no such table: bans`（现在
`isBanned` / `allowWrite` 把「表还没建」当成「没有记录」，只吞这一种错）。

## 授权 UP 主称号（2026-10-13 加）

站上视频署名对应的 UP 主，如果本人也注册了账号，可以给账号挂一个**「授权 UP 主」**徽章
（账号页昵称下方 + 页头账号面板），点徽章去他的 B 站主页。

**⚠️ 这个称号只能由站长在管理台人工发放，代码里没有任何自动推断**（站长 2026-10-13 明确要求）：

- 管理台账号卡片 →「挂授权UP」→ 填 **B 站昵称（要与站上视频署名完全一致）** → 服务端拿 R2 的
  同意名单核对，不在名单上直接拒绝；「摘称号」可撤销。
- 数据落在 `users.up_name`（懒建表自动补列），**同意名单本身只在 R2**（`video-meta/agreed.json`，不进仓库）。
- 为什么不按「账号昵称 === UP 昵称」自动发：那等于**谁先把昵称注册成 UP 的名字谁就白拿**，
  冒名成本只有一个注册；而称号是对外承诺「这位 UP 主同意本站收录」，不能这么给。
  单测 `worker/auth.test.mjs` 有一条专门盯着这件事（「称号只人工发：昵称与 UP 一模一样也不自动给」）。

## CPU 与套餐（2026-10-13 实测记录）

口令哈希是全站**唯一故意烧 CPU** 的路径：PBKDF2-SHA256 / 10 万次迭代，一次注册或登录约
**22~27 ms CPU**（接口本身是墙钟 ~1 秒，其余时间在等 I/O，不计 CPU）。对应的平台限制是：

| 套餐 | 每次请求 CPU 上限 |
|---|---|
| Workers Free | **10 ms** |
| Workers Paid | 30 秒（可调到 5 分钟） |

超限时 Cloudflare 直接返回 **Error 1102**（`Worker exceeded resource limits`，分析里记成
`exceededCpu`）—— 请求会被平台杀掉，Worker 里的 try/catch **拦不到**，所以只能事前防。

**实测结论（2026-10-13）**：本站在当前账号下**没有被这条限制拦住** ——
10-10 ~ 10-13 共 2,058 次调用全部 `success`、0 次 `exceededCpu`；现场实测注册 HTTP 200
（PBKDF2 照跑）、登录 HTTP 200。也就是说：要么账号本身有 Workers 付费订阅
（控制台首页那个 "Free" 指的是**网站套餐**，和 Workers 套餐是两条独立的账），
要么 crypto.subtle 的耗时没有计入这条上限。

⚠️ 这条是**平台侧策略**，不是我们能控制的：如果哪天开始严格执行，最先坏的就是
`/api/register` 与 `/api/login`（返回 1102），而静态页面照常 —— 这种「半坏」最难发现。
真要保底，只有两条路：把迭代数降到 3 万上下（约 8 ms，安全性下降），或者上 Workers 付费（$5/月）。
排查用 `node ../tools/cf-usage.mjs`（含 exceededCpu 计数）。

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

## 昵称审核（2026-10-11 加）

站长问「注册昵称有没有自动审核，别出现违法的东西」。**以前没有** —— 只校验长度与字符。
现在分三层，规则在 `shared/nickname-rules.mjs`：

| 层 | 拦什么 | 在哪 |
|---|---|---|
| 格式 / 防注入 | 长度 2~20、字符白名单（`< > { } [ ] \| * ? / \ " '` 不收） | `worker/auth.ts` 的 `checkName` |
| 防冒充 | 保留昵称：站长 / 管理员 / admin / 官方 / 客服 / 版主 / ze-map … | `RESERVED_NAMES` |
| **内容** | 广告导流（代练/出售/加微信…）、赌博诈骗、色情、违法、**联系方式与链接**（6 位以上连续数字、`@`、`www.`、`vx:`…）、乱码（同字符连 6 个以上 / 纯符号） | `shared/nickname-rules.mjs` |

- **一律归一化之后再查**：全角转半角、去零宽、去分隔符（「管 理·员」）、leet 替身（`4dmin`→`admin`），
  否则这些变体全能绕过去。归一化**只用于匹配**，入库的始终是用户原本输入的样子。
- ⚠️ **联系方式那条要查「轻归一化」**：全归一化会把 `1→l`、`0→o`，于是 `123456789` 变成
  `l2e4s6t8g`、QQ 号就漏过去了（写测试时真踩到，测试里留了这个用例）。
- **提示里绝不回显命中的词** —— 那等于把词库送给想绕过的人做实验。只回类别：
  「不被允许的内容」/「不能放联系方式或网址（可以填到下面的联系方式里，只有站长看得到）」/「看起来像乱码」。
- **政治等敏感词不进仓库**：放 Worker 变量 `NICKNAME_EXTRA`（逗号/顿号/换行分隔，支持 `#` 注释）——
  `wrangler secret put NICKNAME_EXTRA`。理由有两个：线上是 Cloudflare **从仓库构建**的，本地文件根本到不了线上；
  而且没必要公示「我们过滤哪些词」。按 isolate 缓存 5 分钟，改完不用重新部署。
- 前端（账号页 / 页头面板的注册表单）也 import 同一份通用规则做**即时反馈**；
  政治类词表只在服务端，所以最终以服务端为准。
- 审核台的「账号」标签多了 **「改昵称」**：新名字照样过一遍规则，顺手把**还没写回仓库**的投稿署名一起改掉；
  已经进 git 的那些署名改不动（那要另开一次提交改历史内容）。
- 已知挡不住的：谐音、拆字、拼音缩写、外语、以及不在词库里的新花样。**最后一道仍是「写回仓库」那一下**——
  昵称只有在投稿被通过并写回后才作为署名公开，所以最坏情况是「库里躺着个难看的名字」，不是「站上挂着违法内容」。

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
