# 站长重接指南（AI 协作版）

> 用途：PR 合并到 `hhjjdsj/ze-map-site` 后，站长在自己的 Cloudflare 账户里把生产站接到新下游。
> 当前规划见 [`planning/refactor-merge-plan.md`](planning/refactor-merge-plan.md)。
> 本文件是给**站长 + AI agent** 的操作引导，不是给投稿人的说明。

---

## 0. 什么时候用

只在以下条件全部满足后使用：

- PR 已完成阶段 4–6（新单项 / 整页编辑、唯一 `page_revisions` 审核链、旧流程删除、验收通过）。
- PR 已合并到源仓库 `main`，或站长准备在合并前做 Preview。
- `data/content` 的 146 个迁移文件已经在 PR 里。
- 默认 `wrangler.jsonc` 已改成站长生产配置，个人测试配置不在 PR 里。

**不满足就停**，不要用 AI 硬接。

---

## 1. 给 AI 的启动提示词

把下面这段发给站长的 AI agent：

```text
你是接手 ZE 地图站的运维 agent。先只读，不要执行任何写操作或破坏性命令。

请先阅读：
- docs/planning/refactor-merge-plan.md
- docs/deployment-handoff-ai.md
- wrangler.jsonc
- package.json
- migrations/

然后输出：
1) 当前配置是否指向站长生产（Worker / D1 / KV / R2 / GITHUB_REPO / GITHUB_BRANCH）；
2) 还缺哪些 secrets；
3) D1 迁移顺序和必须先导出的旧表；
4) Preview 验收清单；
5) 任何看起来像个人测试账户 / 个人 token / 个人 ID 的残留。

不要猜 secret 的值，不要让我把 secret 粘贴到聊天里。需要我操作 Cloudflare 面板或 wrangler secret 时，明确标成“需要站长手动执行”。
```

---

## 2. 硬性约束

- **不要使用 PR 作者的个人 Cloudflare 账户 / Worker / D1 / KV。**
- **不要提交** `.dev.vars`、`migration/legacy/`、任何 token、任何个人 Cloudflare ID。
- **不要从测试 D1 导入生产。** 测试 D1 只用于验证；生产内容迁移已经在 PR 的 `data/content` 里。
- **任何 drop 前必须先导出。** 旧 `submissions` / `difficulty_votes` 先导出到站长本地私有目录，再执行删除迁移。
- **不要先切生产再验 Preview。** 先 Preview / 测试 Worker，验收通过后再生产。
- **不要改写历史。** 不建备份 tag / 分支是当前项目约定；但生产 D1 的导出必须保留。
- AI 不能读到的值（`ADMIN_TOKEN`、`IP_SALT`、`GITHUB_TOKEN`、OAuth secret、Turnstile secret）由站长在 Cloudflare 面板 / `wrangler secret put` 里输入，AI 只检查“是否存在/是否缺失”。

---

## 3. 站长需要认识的资源

| 资源 | 生产值 |
|---|---|
| Worker | `ze-map-site` |
| D1 | `ze-map-community` |
| KV | `UPLOADS` |
| R2 | `ze-map-terr`（绑定 `TERR`） |
| 域名 | `ze-map.cn`、`terr.ze-map.cn` |
| 构建 | Cloudflare Workers Builds，连接源仓库 `main` |

生产 D1 / KV / R2 的绑定在默认 `wrangler.jsonc` 顶层；仓库不携带个人测试 Cloudflare / GitHub 配置。

---

## 4. 第一步：只读核对

AI 先跑 / 检查：

```bash
npx wrangler whoami
npx wrangler d1 list
npx wrangler kv namespace list
```

检查 `wrangler.jsonc`：

- 顶层 `name` 是 `ze-map-site`，不是 `ze-map-site-test`。
- `GITHUB_REPO=hhjjdsj/ze-map-site`。
- `GITHUB_BRANCH=main`。
- D1 / KV / R2 是站长生产绑定。
- 没有任何 `SolsticeStarry/...`、`refactor/...`、个人测试 ID。

如果不对：**停**，让 PR 作者先改默认配置，不要继续部署。

---

## 5. 第二步：导出旧生产数据

在站长本地私有目录（不要放进仓库）执行：

```bash
npx wrangler d1 export ze-map-community --remote --output ./migration-owner/d1-before-cutover.sql
```

确认文件非空、包含旧表。重点确认：

- `submissions`：旧字段投稿队列
- `difficulty_votes`：旧投票（如果存在）
- `page_revisions`：新整页修订队列（保留）

旧 `data/community` 的已发布内容已经在 PR 的 `data/content` 里；**不需要**从 D1 再导内容。旧 pending / approved / rejected / draft 只归档，不导入新队列。

KV 旧待审图：

```bash
npx wrangler kv key list --namespace-id <生产 KV ID> --remote
```

如果有 pending 图，先导出/记录，再清理；没有就继续。

---

## 6. 第三步：D1 迁移

先看 `migrations/` 的 SQL，确认顺序：

- 新 `page_revisions` / `mode` 字段
- 删除 `submissions`
- 删除 `difficulty_votes`
- 不再使用旧投票表

执行：

```bash
npx wrangler d1 migrations apply ze-map-community --remote
```

**破坏性迁移（drop 旧表）必须在第 5 步导出确认后执行。** 不要先 drop 再导出。

迁移后检查：

```bash
npx wrangler d1 execute ze-map-community --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
npx wrangler d1 execute ze-map-community --remote --command "PRAGMA table_info(page_revisions)"
```

期望：存在 `page_revisions`，不存在 `submissions` / `difficulty_votes`；`page_revisions` 有 `mode`（如果阶段 4 已合入）。

---

## 7. 第四步：secrets

在站长账户设置 / 确认：

```text
ADMIN_TOKEN
IP_SALT
GITHUB_TOKEN
GITHUB_OAUTH_CLIENT_ID
GITHUB_OAUTH_CLIENT_SECRET
SESSION_SECRET
TURNSTILE_SECRET（如果启用）
```

- `GITHUB_TOKEN`：fine-grained PAT，只授权 `hhjjdsj/ze-map-site`，Contents 读写。
- GitHub OAuth App 必须在站长账户下；callback：
  `https://ze-map.cn/api/auth/github/callback`
- 不要使用 PR 作者的个人 token / OAuth App。
- secret 值只输入到 Cloudflare，不要写进仓库或聊天。

---

## 8. 第五步：Preview 验收

用 Preview / 测试 Worker 或本地构建验证：

```bash
npm ci
npm run build
```

Cloudflare Preview 连接源仓库 `main`，不要用 `--env test` 部署生产。

验收 URL / 行为：

- `/maps/ze_cyberspace_v2/`：难度「困难」，来源「玩家修订」；不出现社区补充。
- `/maps/ze_depths/`：难度「火星」。
- `/edit/<slug>/`：未登录不能提交整页；登录后可编辑。
- `/submit/edit`：匿名可提交单项。
- `/submit`：301 到新单项编辑。
- `/api/submit`：404。
- `/admin/`：只处理 `page_revisions`；旧 submissions 标签不存在。
- 审核通过 → 待写回 → 写回只提交 `data/content`。
- 封面 / 图片集上传 → KV 待审 → 审核 → 封面写仓库 / 图集写 R2。
- `/api/vote`、`/api/stats`：404（投票已删除）。
- 旧 `data/community` 已删除；`/updates` 使用 `data/content` 的 history。

本地/构建检查：

```bash
npm run content:verify-content
npm run test:content
```

期望：audit 0；content 0 错误；测试通过。

---

## 9. 第六步：切生产

Preview 通过后：

1. 确认 Workers Builds 连接源仓库 `main`。
2. 构建命令：`npm run build`。
3. 部署命令：`npx wrangler deploy`。
4. 触发生产构建 / 部署。
5. 检查 `ze-map.cn` 与 `terr.ze-map.cn`。
6. 抽查上面 5 个 URL。
7. 缓存必要时清一次；不要只看构建成功。

---

## 10. 第七步：清理个人测试

站长切换成功后，PR 作者这边：

- 断开个人测试 Worker 的 Workers Builds。
- 删除个人测试 Worker / D1 / KV。
- 撤销个人 `GITHUB_TOKEN`、GitHub OAuth secret。
- 确认个人 fork / 分支不再参与生产构建。

站长这边：

- 不需要保留 PR 作者的测试 D1。
- 只在站长账户保留生产 Worker / D1 / KV / R2。

---

## 11. 失败时

- **构建失败**：先看 Cloudflare Builds 日志；不要先改 D1。
- **页面仍显示旧内容**：检查默认 `wrangler.jsonc` 是否指向生产、构建分支是否是 `main`、是否部署了旧版本。
- **D1 迁移失败**：停止 drop；用第 5 步导出恢复；检查迁移顺序。
- **写回失败**：检查 `GITHUB_TOKEN` 是否对源仓库有 Contents 写权限、`GITHUB_REPO` / `GITHUB_BRANCH` 是否指向 `main`。
- **OAuth 失败**：核对 callback 与站长账户下的 OAuth App。
- **旧内容疑丢失**：旧 `data/community` 在 git 历史中；`data/content` 在 PR 中；D1 只存未发布队列。先查 git / 导出，不要猜。

---

## 12. 一句话版本

**站长：合并 PR → 确认默认配置是生产 → 导出旧 D1 → 跑迁移 → 配 secrets → Preview 验收 → 切生产 → 清理个人测试。**
