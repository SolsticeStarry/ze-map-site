# 账号系统（当前）

> 2026-10-25 更新。账号仍然可选：匿名单项修订不登录也能提交；登录后的账号只负责**稳定署名、个人修订记录、等级与通知**。
> 旧 `/submit` 字段表单、D1 `submissions`、难度投票和 `data/community` 已删除。
> 旧账号实现的完整历史在 [`archive/accounts-pre-page-revisions.md`](archive/accounts-pre-page-revisions.md)。

## 1. 登录与投稿的关系

| 入口 | 登录 | 写入 | 署名 |
|---|---|---|---|
| `/submit/edit` 单项补充 | 不需要 | `page_revisions`（`mode=single`, `user_id=0`） | 填写的昵称；登录后可固定为账号昵称 |
| `/edit/<slug>/` 整页编辑 | 需要 | `page_revisions`（`mode=full`, `user_id=账号 id`） | 账号昵称 |
| `/account/` | 账号页 | 只读自己的修订记录 | 账号昵称 |

匿名单项和登录整页进入**同一条** `page_revisions` 审核链；没有 `submissions` 表。

## 2. 数据与会话

- 账号只在 D1：`users`、`page_revisions`、`bans`、`rate_limits`、`notifications`、`notification_reads`。
- 仓库里没有用户数据；不存邮箱。联系方式是选填，只有站长能看到。
- 口令存 `pbkdf2$100000$盐$派生值`（PBKDF2-SHA256，10 万次；Workers 上限）。
- 会话是无状态签名 Cookie `zc_sess`，90 天；`SESSION_SECRET` 优先，未配置时由 `IP_SALT` 派生。
- 改口令时 `pass_ver + 1`，其它设备上的旧 Cookie 立即失效。
- `ensureSchema()` 在第一次用到账号功能时幂等补表 / 补列；每个 isolate 只检查一次，单步失败不拖累其它步骤。
- `page_revisions` 是修订记录，不是 `users` 的附属表；单项匿名行的 `user_id` 是 `0`，不计入账号等级。

## 3. GitHub 登录（可选）

- 口令注册 / 登录仍然可用；没配 `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` 时按钮自动隐藏。
- 回调必须是 `https://ze-map.cn/api/auth/github/callback`（只有 `/api/*` 会进 Worker）。
- 只申请 `read:user`，不申请邮箱；access token 只用一次读 `/user` 后丢弃。
- 已绑定的 GitHub 号按 `gh_id` 认账号；已登录用户可绑定当前账号。
- 没有口令的 GitHub 账号可以设置口令；已有口令解绑 GitHub 前必须验证原口令。
- 相关接口：`GET /api/auth/github/start`、`GET /api/auth/github/callback`、`POST /api/auth/github/unbind`。

## 4. 等级与署名

- 等级按 `recalcUserStats()` 的**已写回（`applied`）**记录计算，按 `map_slug + mode` 去重；不是按提交条数。
- 等级档位：路人 0、入门贡献者 1、资料整理者 5、资深编辑 10、荣誉编辑 25、百科元老 50、资料奠基人 80。
- **当前没有自动免审**：所有 `page_revisions` 都从 `pending` 开始，必须经审核台 `approve → flush`。
  `levelOf()` 里保留的 `trusted` 字段尚未接入修订提交；页面不再承诺免审。
- 登录后署名固定使用账号昵称；匿名单项使用填写昵称。昵称只影响以后的记录，不改历史。

## 5. 接口

| 接口 | 说明 |
|---|---|
| `POST /api/register` | 昵称 + 口令 + 选填联系方式；成功即登录 |
| `POST /api/login` | 昵称 + 口令；失败不区分「昵称不存在」与「口令错」 |
| `POST /api/logout` | 清除会话 Cookie |
| `GET /api/me` | `user` + `submissions`（最近 50 条 `page_revisions`）+ `counts`；未登录也返回 200 |
| `POST /api/password` | 旧口令 + 新口令；GitHub 无口令账号不校验旧口令 |
| `POST /api/profile` | 改昵称 / 联系方式；昵称只影响以后 |
| `GET /api/me/notifications` | 收件箱：全部 / 未读 / 公告 / 投稿通知 / 账号 |
| `POST /api/me/notifications/read` | 标已读 / 未读；幂等 |
| `GET /api/admin/accounts` | 站长账号总览（`ADMIN_TOKEN`） |
| `POST /api/admin/accounts` | 停用 / 恢复 / 解锁 / 重置口令 / 改名 |

`/account/` 是静态页 + `/api/me`；`/inbox/` 复用通知接口。页头账号按钮用 `?lite=1` 只取登录态，避免每个页面都查修订记录。

## 6. 通知

- 收件箱存在 `notifications` + `notification_reads`；公告 `user_id IS NULL`，已读按用户单独记录。
- 当前自动写入的是账号事件（停用 / 恢复 / 重置口令 / 改名 / 挂称号）和站长公告。
- 审核台的 `page_revisions` 通过 / 驳回 / 写回**目前不推送通知**；相关内容变化直接看修订记录和 `/updates/`。
- 通知写入失败只记日志，不影响审核 / 写回主流程。

## 7. 验证

```bash
npm run build
npm run test:content
npm run handoff:check
```

旧的 `worker/auth.test.mjs` 已随旧投稿链路删除；账号接口的回归目前靠测试 Worker 冒烟（`/api/me`、`/account/`、`/inbox/`、`/api/admin/accounts`）。生产启用前按 [`deployment-handoff.md`](deployment-handoff.md) 配置 secrets 与 D1。
