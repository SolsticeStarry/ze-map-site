# 重构合并计划（简化版）

> 状态：实施中（阶段 0–6 已完成；阶段 7 配置分层已完成，PR / 站长账户迁移待执行）  
> 开发位置：fork / test  
> 目标：上游不变，旧下游全删，旧数据全量迁移，只保留一条新审核链路；最后以 PR 形式交给站长，并迁到站长的 Cloudflare 账户。  
> 分支策略：当前是分支，不建备份 tag / 分支；失败就丢弃重来。

## 0. 阶段进度

| 阶段 | 状态 |
|---|---|
| 0 基线 / 导出 | 完成：旧 community 审计、本地 D1、远程 D1、KV key list 均已导出。远程测试 D1：1 条 rejected submission、9 条 page_revisions（2 applied / 1 pending / 6 rejected）；difficulty_votes 表不存在；KV 为空。旧写入已随阶段 5 删除。 |
| 1 契约 / 迁移引擎 | 完成：schema 支持 tags / difficulty；迁移脚本支持 dry-run / slugs / force / 合并已有 content。 |
| 2 数据迁移 | 完成：146 个 content；tags 65、difficulty 35、封面 90、notes 17、items 134 全部有去向；146 个 content 全部通过；`content:verify-content` 0 错误。 |
| 3 切换读取 / 渲染 | 完成：`getMaps/getMap`、`NewMapDetail`、MDX 生成器、整页修订 current 快照已改为 research + content；content 的 tags / difficulty 已生效；`maps:generate` + `build:site` 通过。旧编辑器、更新流、旧审核台仍在阶段 4–5。 |
| 4 唯一审核链与编辑器 | 完成：`page_revisions` 增加 `mode`；单项匿名 API；`/submit/edit` 单项走 `page-revision`；整页编辑器支持 difficulty / tags；新媒体上传（封面 / 图片集 → KV → 审核 → 仓库 / R2）；审核台只处理内容修订。 |
| 5 删除旧下游 | 完成：旧 `/submit` 301；`submissions` / `my-submissions` / `votes` / `data/community` / 旧 admin / 旧媒体接口删除；测试 D1 drop `submissions` / `difficulty_votes`；`page_revisions` 成为唯一队列。 |
| 6 验收 | 完成：`content:verify-content` 0 错误；`content:links` 0 死链（补 `/api`、`/terr` 运行时跳过；标签大小写归一到同一页）；`build` 2194 页；`test:content` 10/10；详情 / 单项 / 审核台 / 媒体上传冒烟通过。测试环境无 R2，图集写回留到阶段 7 站长环境验证；`content:verify` 仍有 8 个既有 research sections 缺 sources 错误，未改 research。 |
| 7 PR / 站长账户迁移 | 准备中：默认 `wrangler.jsonc` 已指向站长生产；仓库不携带个人测试 Cloudflare / GitHub 配置；`handoff:check` / 交接文档 / `docx/站长重配清单.md` 已就位。实际 PR、生产导出 / D1 迁移 / secrets / Preview / 切域名仍待站长执行。 |

---

## 1. 边界

### 上游（不改）

Steam 工坊、GFL、工坊版本记录、`data/research`、`data/gfl-parsed`、实体 / 地形烘焙、`public/entity`、catalog、MDX 生成。  
**`data/research` 一个字段都不改。**

### 旧下游（删除）

`data/community` 读 / 写、旧 `/submit` 字段投稿、D1 `submissions`、旧审核台投稿标签、旧 `my-submissions`、旧图片上传接口、`LEGACY_COMMUNITY_FIELDS`、难度投票。

### 新下游（唯一）

`data/content` 玩家覆盖层 + D1 `page_revisions` + 新详情页 + 单项 / 整页编辑 + 新审核台。  
**只有 `page_revisions` 一条审核链，只写 `data/content`。**

---

## 2. 已定决策

| # | 决策 |
|---|---|
| Q1 | 在 fork / test 完成；合并 upstream 另开 PR。 |
| Q2 | research 不动；difficulty 改为 `data/content` 可编辑字段；旧 35 个社区难度全部迁入 content（8 个不同值保留）；旧 4 个 `sources` 只归档。 |
| Q3 | 旧下游全删；`/submit` 301 到新 `/submit/edit`；旧 `/api/submit`、旧上传接口、旧审核台标签删除。 |
| Q4 | tags 进入 content；编辑页支持添加 / 删除；允许新标签，审核后生效。 |
| Q5 | 采用 A：只把已发布 / `applied` 内容迁入 content；旧 pending / approved / rejected / draft 全量导出归档，不进入新队列、不自动发布。 |
| Q6 | 旧单项编辑删除后重做；单项匿名，整页登录；两者共用 `page_revisions`（`mode` 区分）。 |
| Q7 | 不建备份分支 / tag；旧流程直接丢弃。 |
| Q8 | 恢复封面 / 图片集上传，走新审核链内的媒体通道；旧上传接口不恢复。 |
| Q9 | 放弃难度投票；投票 UI / API / D1 表删除，旧票数导出归档。 |

### 已知取舍

- 旧 4 个 `sources` 不生效，只归档。
- 旧 pending / approved / rejected / draft 不进入新审核台，只能查归档。
- 旧「受信任账号直接 approved」只存在于旧 `submissions`；新 `page_revisions` 目前统一 `pending`。要保留免审需另加规则。
- 旧投票删除；难度改由 content 编辑 + 人工审核。
- `data/community` 活动文件删除，原文只在 git 历史；不建备份 tag。

---

## 3. 目标管线

```text
外部源（Steam / GFL / 版本记录 / s2ze / B站）
        │
        ▼
抓取 / 解析 / 烘焙 ──> research / gfl-parsed / entity / catalog
        │
        ├──> 生成 MDX ──┐
        │                │
        │                ├──> getMap() / getMaps() ──> 详情页 / 列表 / 搜索 / 标签
        │                │
社区 ──> 单项 / 整页编辑 ──> page_revisions ──> /admin ──> data/content + 媒体
        （匿名 / 登录）          （唯一队列）            │
                                                       └──> commit ──> 构建 ──> dist ──> 边缘
```

- `data/content` 字段：正文块、关卡、神器、视频、标题、封面、tags、difficulty、信息框、history。
- 合并顺序：`content > research > 自动生成`；`sources` 仍是 research 专属。
- 媒体：新上传接口 → KV 待审 → `page_revisions` 审核 → 封面写仓库 / 图集写 R2 + `data/gallery`。
- 构建、Pagefind、静态优先、R2 地形回退、实体预览保持不变。

---

## 4. 分阶段

### 阶段 0：基线、导出、冻结

- 盘点旧数据：146 个 `data/community`、10 个 `data/content`、D1 `submissions`、`difficulty_votes`、KV 待审图、drafts、logs。
- 导出 D1 全状态、投票、KV metadata、迁移报告；保存迁移前页面快照。
- 只冻结旧写入，不删除；不建分支备份。
- **出口**：旧数据可追溯，迁移清单完整。

### 阶段 1：契约与迁移引擎

- 扩展 `shared/page-schema.mjs`：`tags`、`difficulty` 白名单 / 校验 / 归一化 / 合并。
- 扩展 `migrate-editorial.mjs`：146 个 community → content 映射；旧 35 个 difficulty 进 content；tags 进 content；`sources` / drafts / unsupported 进报告。
- 修正现有 10 个 content 样本；作为金样本。
- 跑 `--dry-run`，不写 research、不删旧数据。
- **出口**：146 个 dry-run 报告；10 个样本通过 schema。

### 阶段 2：数据迁移

- 只把 `applied` / 已发布内容写入 `data/content`；旧 pending / approved / rejected / draft 只归档。
- 旧 35 个 difficulty、65 个 tags、items、notes、videos、covers、history/log 全部有去向。
- 生成 `migration/legacy/community-report.json` 和 D1 / KV 导出。
- **出口**：146 个 content 通过校验；迁移前后快照差异可解释（迁移审计脚本已在阶段 5 删除）。

### 阶段 3：切换读取与渲染

- `getMaps` / `getMap` 只合并 research + content；删除 community 合并。
- `NewMapDetail` 删除社区补充 / 草稿；difficulty / tags 从 content 读取。
- `page_revisions` 审核台的 current 快照改为 research + content，不再读 community。
- `generate-map-entries.mjs` 删除 community 输入。
- 标签页、搜索、同类推荐跟随新合并结果。
- **出口**：页面只依赖 research + content；构建通过；无 community 读取。

### 阶段 4：唯一审核链与编辑器

- `page_revisions` 增加 `mode = single | full`；单项匿名，整页登录。
- 新单项 / 整页支持 difficulty、tags 添加 / 删除、封面 / 图片集上传。
- 新审核台只处理 `page_revisions`，diff 覆盖 difficulty / tags / 媒体 / 正文。
- 新上传接口走 KV 待审；审核后封面写仓库、图集写 R2 / `data/gallery`。
- **出口**：单项 / 整页都能走同一条链；审核 → 写回 content；旧 `submissions` 不再接收写入。

### 阶段 5：删除旧下游

- 删除旧 `/submit` 字段表单、`/api/submit`、`/api/submit-cover`、`/api/submit-gallery`、`worker/submissions.ts`、`my-submissions.ts`、旧 admin 投稿标签。
- 删除 `data/community` 活动文件、`LEGACY_COMMUNITY_FIELDS`、`shared/community-doc.mjs` 运行引用。
- 删除投票 UI / API / `worker/votes.ts` / 投票样式；D1 `difficulty_votes` 导出后 drop。
- 旧 D1 `submissions` 导出后 drop；清理 KV 待审图。
- `/submit` 301 到新 `/submit/edit`。
- **出口**：没有运行路径引用旧 community / submissions / votes；旧 API 404。

### 阶段 6：验收

- `content:verify-content`、`content:links`、`build`、`test:content` 通过。
- 详情页 / 编辑页 / 单项 / 整页 / 审核台 / 媒体上传冒烟。
- `data/research` 无 diff；上游脚本无 diff。
- 旧数据报告可追溯；旧 URL 重定向；封面 / 图集无死链。
- **出口**：可以进入 PR / 账号迁移。

### 阶段 7：PR 与站长账户迁移（最后执行）

见第 6 节。**在代码与数据验收通过前，不碰生产。**

---

## 5. 数据迁移口径

| 旧数据 | 去向 |
|---|---|
| 146 个 `data/community` 的 title / cover / tags / difficulty / 信息框 / videos / notes / items | `data/content`（只迁 applied / 已发布内容） |
| 35 个 difficulty（27 同值、8 不同） | content；不写 research |
| 65 个 tags | content；编辑页可增删 |
| 17 条 notes、134 个 items、146 个 log | content blocks / itemEdits / history + 迁移报告 |
| 15 个 `fields.draft` | `migration/legacy/drafts/`，不发布 |
| 4 个 `sources` | `migration/legacy/`，不写 research |
| 旧 D1 `submissions` 全状态 | `migration/legacy/submissions.ndjson`，不进入新队列 |
| 旧 D1 `difficulty_votes` | `migration/legacy/votes.ndjson`，drop |
| KV 待审图 | 导出 metadata / 必要时对象，清理 |
| 旧 `data/community` 文件 | 从活动树删除；原文在 git 历史，不建备份 |

**全量迁移 = 全量保存 / 归档，不等于全量发布。**

> `migration/legacy/` 是本地 / 私有迁移归档，含投稿人、联系方式、IP 哈希等，**不提交到 PR / 公开仓库**；PR 只放脱敏的迁移报告。

---

## 6. PR 与 GitHub / Cloudflare 迁移

### 6.1 GitHub：PR 到源仓库

- 目标：`hhjjdsj/ze-map-site`，默认分支 `main`。
- PR 前清理个人配置：
  - 默认 `wrangler.jsonc` 不再指向 `SolsticeStarry/ze-map-site` 或重构分支。
  - `GITHUB_REPO=hhjjdsj/ze-map-site`、`GITHUB_BRANCH=main` 作为默认值。
  - 个人测试用的 repo / branch / 资源 ID 只放在本地测试 overlay，不进入 PR。
- PR 内容：数据迁移（`data/content`）+ schema + 新下游 + 删除旧流程；不包含 `.dev.vars`、个人 token、个人 Cloudflare ID、`migration/legacy` 原始导出（含个人信息）。
- PR 合并后：Cloudflare GitHub App、Workers Builds、OAuth App 都归站长仓库 / 账户；个人 fork 不再参与构建。
- 个人清理：撤销个人 `GITHUB_TOKEN`、GitHub OAuth secret、个人测试分支的构建连接。

### 6.2 Cloudflare：迁到站长账户

不要复用个人测试 Worker，直接在站长账户创建 / 绑定：

| 资源 | 目标 |
|---|---|
| Worker | `ze-map-site` |
| D1 | `ze-map-community` |
| KV | `UPLOADS` |
| R2 | `ze-map-terr`（`TERR`） |
| 域名 | `ze-map.cn`、`terr.ze-map.cn` |
| Builds | 连接 `hhjjdsj/ze-map-site` 的 `main`，构建 `npm run build`，部署 `npx wrangler deploy` |

站长账户需要设置：

- `ADMIN_TOKEN`、`IP_SALT`、`GITHUB_TOKEN`
- `GITHUB_OAUTH_CLIENT_ID`、`GITHUB_OAUTH_CLIENT_SECRET`
- `SESSION_SECRET`（建议）、`TURNSTILE_SECRET`（如启用）
- GitHub OAuth App callback：`https://ze-map.cn/api/auth/github/callback`

数据与表：

- 新 D1 执行 `page_revisions`（含 `mode`）迁移；旧 `submissions` / `difficulty_votes` 先导出再 drop。
- 旧生产 D1 的 pending / approved / rejected / draft 只归档；不自动迁入新队列。
- 旧 KV 待审图清理；R2 现有地形 / 图集保留。
- `GITHUB_REPO` / `GITHUB_BRANCH` 指向站长仓库 `main`。

切换顺序：

1. 导出旧生产 D1 / KV 数据到本地私有归档；断开个人测试 Worker 的 Workers Builds（避免切换默认配置后个人构建失败或指错资源）。
2. 在站长账户创建资源、设置 secrets、执行迁移。
3. 部署 Preview / 测试 Worker，跑验收。
4. 合并 PR 到 upstream `main`，Workers Builds 构建生产。
5. 绑定域名，观察构建与页面。
6. 删除个人测试 Worker / D1 / KV；撤销个人 token / OAuth；断开个人构建。

> 不建分支备份；旧数据导出是迁移要求，不是回滚备份。

### 6.3 方便迁移的“口子”

代码里只保留一套生产默认配置，个人测试通过 overlay 注入，不把个人账户写进 PR：

1. **配置分层**
   - 开发期继续使用现有测试配置；**Phase 7 切默认生产前先断开个人 Workers Builds**。
   - `wrangler.jsonc`：默认 = 站长生产（Worker / D1 / KV / R2 / GitHub 上游 `main`）。
   - 仓库只保留生产配置；个人测试 Worker / D1 / KV / fork 分支不写入仓库。
   - `npm run deploy:prod` = `npx wrangler deploy`。
2. **Secrets 分层**
   - `.dev.vars` 本地；`.dev.vars.example` 只列变量名，不含值。
   - 生产 secrets 全在站长 Cloudflare 账户；个人测试 secrets 只在本地 / 个人账户。
3. **一键检查**
   - 新增 `npm run handoff:check`（`scripts/ops/handoff-check.mjs`）：
     - 检查默认配置是否仍含个人 repo / 测试 ID；
     - 列出缺失的 D1 / KV / R2 绑定和 secrets；
     - 打印站长需要执行的 `wrangler d1 migrations apply` / `wrangler secret put` 清单。
4. **交接文档**
   - `docs/deployment-handoff.md`：资源清单、secrets 清单、D1 迁移、Workers Builds 连接、OAuth callback、域名、切换与回滚边界。
   - `docs/deployment-handoff-ai.md`：给站长 + AI agent 的重接引导、启动提示词和验收清单。
   - PR 描述里链接该文档，站长按清单操作即可。

**最终效果**：PR 里只有上游默认配置；个人测试配置被隔离在 gitignored overlay；站长只需创建资源、填 secrets、执行迁移，不需要改业务代码。

---

## 7. 完成定义

- 上游代码与 `data/research` 无 diff。
- 旧下游运行路径为零：无 `data/community` 读取、无 `submissions`、无 votes、无旧 `/api/submit`、无旧 admin、无 `LEGACY_COMMUNITY_FIELDS`。
- `data/content` 是唯一玩家层；difficulty / tags / media 都可编辑并审核。
- `page_revisions` 是唯一审核链；单项匿名、整页登录；写回只碰 content。
- 146 个旧 community 的已发布内容全部有去向；未发布 / 草稿 / sources / votes 全部归档。
- 旧 `/submit` 301；旧 API 404；构建、搜索、预览、R2 回退正常。
- PR 不含个人账户信息、个人 Cloudflare ID、`migration/legacy` 原始导出；站长账户可独立完成部署。
