# 最近改动（`/updates/` 与首页底部）

> 当前实现：`src/lib/update-feed.ts`、`src/components/UpdateFeed.astro`、`src/pages/updates/feed.json.ts`。
> 旧 community log 的完整说明在 [`archive/update-feed-community.md`](archive/update-feed-community.md)。

## 1. 两层数据

| 层 | 来源 | 颗粒度 | 什么时候出现 |
|---|---|---|---|
| 玩家修订 | `data/content/<slug>.json` 的 `history[]` | 迁移前的 community 字段记录 + 新写回的 `{revision, appliedAt}` | 构建期直接读文件，写回后重建即可看到 |
| 本站整理 | `data/research-changes.json` | research 顶层字段 / 图片集 | 本地构建由 git 历史生成并提交；浅克隆沿用现有文件 |

**不再读取 `data/community`。** 迁移后的旧记录仍以 `source: "data/community.log"` 保留在 content history 里；新写回由 `page_revisions` 追加 `revision` / `submitter` / `reviewer` / `appliedAt`。

## 2. 合并规则

- `getUpdateFeed()` 合并两层，按时间倒序，最多 400 条；slug 找不到页面标题的条目直接丢弃。
- 每张图最新的改动日期还会由 `latestChangeByMap()` 提供给「最新更新」，避免「最近改动」和「最新更新」两套日期打架。
- 封面改动按天聚合成一条「N 张图更新了封面」，明细在可展开区；否则批量导封面会刷屏。
- 新写回的单条修订显示为「内容修订 #编号 已上线」；旧 community 记录继续按字段显示难度 / 标签 / 视频 / 神器等。
- 「本站整理」只显示前 3 个字段 + 「等 N 项」，避免一次大迁移占满首页。

## 3. 生成脚本

```bash
npm run changes:build   # 只重算 data/research-changes.json
npm run build           # 完整体验（含 feed 数据）
```

`scripts/content/build-research-changes.mjs` 的口径：

- 只看 `data/research` 与 `data/gallery`；`src/content/maps/*.mdx` 是生成产物，不记。
- 一次提交动超过 20 个相关文件视为批量导入，整条丢弃。
- 本地拿不到 git / 浅克隆时保留现有 `data/research-changes.json`，不清空。
- 新增值得记录的字段时在 `KEY_LABELS` 补一行。

## 4. 页面与验证

- 首页与 `/updates/` 共用 `UpdateFeed.astro`；首屏静态 HTML，点「加载更多」再取 `/updates/feed.json`。
- 相对时间由浏览器按访问者本机时间计算。
- 验证：`npm run build` 后打开 `/updates/`，检查封面聚合、标题、加载更多；`/updates/feed.json` 可直接查看数据。
