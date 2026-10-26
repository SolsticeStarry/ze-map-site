# 文档索引

先看 [内容模型](content-model.md) —— 当前站点只有一层玩家内容：`data/content` + D1 `page_revisions`。旧 `data/community`、旧 `/submit` 字段表单和难度投票已删除。

## 当前维护

| 文档 | 用途 |
|---|---|
| [content-model.md](content-model.md) | 玩家内容层、单项 / 整页编辑、审核写回、回滚与验证 |
| [accounts.md](accounts.md) | 可选账号、登录 / 投稿署名 / 账号历史 |
| [admin-guide.md](admin-guide.md) | 审核台判断标准与操作边界 |
| [cover-images.md](cover-images.md) | 封面来源优先级、人工换图 |
| [relic-guides.md](relic-guides.md) | 神器 / 关卡图文教程的写法 |
| [update-feed.md](update-feed.md) | 首页「最近改动」与 `/updates/` |
| [takedowns.md](takedowns.md) | 下架记录与下架范围 |
| [data-sources.md](data-sources.md) | 外部数据来源、刷新与署名 |
| [expanding-map-coverage.md](expanding-map-coverage.md) | 批量扩图流程 |
| [r2-migration.md](r2-migration.md) | 地形分片迁移到 R2 的记录 |
| [deploy-and-builds.md](deploy-and-builds.md) | 推送、Workers Builds 与排障 |
| [deployment-handoff.md](deployment-handoff.md) | 站长生产交接清单 |
| [deployment-handoff-ai.md](deployment-handoff-ai.md) | 站长 + AI agent 的重接引导 |

## 规划

| 文档 | 用途 |
|---|---|
| [planning/refactor-merge-plan.md](planning/refactor-merge-plan.md) | 当前重构 / 合并 / 账户迁移计划（阶段 7 待执行） |

## 历史归档

[archive/](archive/) 只用于追溯，不是当前操作说明：

- [community-editing-plan.md](archive/community-editing-plan.md)：旧 community 投稿 / 审核设计
- [content-model-v2-plan.md](archive/content-model-v2-plan.md)：v2 内容模型执行规格
- [difficulty-backfill-2026-10-08.md](archive/difficulty-backfill-2026-10-08.md)：一次性难度回填记录
- [terrain-3d-plan.md](archive/terrain-3d-plan.md)：早期 3D 地形接入分析
- [accounts-pre-page-revisions.md](archive/accounts-pre-page-revisions.md)：旧账号 / submissions 时代的实现记录
- [update-feed-community.md](archive/update-feed-community.md)：旧 community log 更新流说明

## 不放进仓库

- `migration/legacy/`：迁移导出，含投稿人 / 联系方式 / IP 哈希，已 gitignore。
- `.dev.vars`：本地密钥，已 gitignore；仓库不携带个人测试 Cloudflare / GitHub 配置。
- `bake/`、`dist/`、`.astro/`、`.wrangler/`：构建与本地运行产物。
