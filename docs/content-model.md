# 内容模型（当前）

> 状态：P1–P5 与阶段 6 验收已完成。页面、编辑器、审核台和更新流都只使用 `data/content` + `page_revisions`；旧 `data/community` 与旧投稿链路已删除。
> 旧 v2 执行规格在 [`archive/content-model-v2-plan.md`](archive/content-model-v2-plan.md)（历史，不再作为操作说明）。

## 1. 两层内容

| 层 | 位置 | 谁写 | 页面行为 |
|---|---|---|---|
| research | `data/research/<slug>.json`、`data/gfl-parsed/<slug>.json` | 仓库编辑 / 生成器 / CI | 基线正文、结构化资料、神器配置 |
| player | `data/content/<slug>.json` | `/edit/<slug>/` 审核通过后写回 | 只存玩家实际覆盖；未覆盖字段回退 research |

`src/lib/maps.ts` 是唯一合并入口：

- 列表 / 搜索 / 标签 / 推荐用 `getMaps()`，不解析神器表。
- 详情页 / 编辑页用 `getMap(slug)`，带神器表与内容 revision。
- 玩家覆盖最后应用，优先于 research。

## 2. 数据迁移（阶段 2 已全量完成）

阶段 2 已把 146 个 `data/community` 迁成 `data/content`；已有 10 个 content 采用缺失字段合并，另外 136 个新建。`npm run content:verify-content` 通过；旧 community 与迁移命令已从运行路径移除。

当前覆盖统计：tags 65、difficulty 35、封面 90、notes 17、items 134。

一次性迁移脚本已归档到 [`scripts/legacy/migrate-editorial.mjs`](../scripts/legacy/migrate-editorial.mjs)；旧 `data/community` 已删除，不再提供可重复执行的迁移命令。

## 3. 旧下游已删除

`data/community`、旧 `/submit` 字段表单、`/api/submit*`、D1 `submissions`、旧 admin 投稿标签、旧 `my-submissions`、难度投票和旧图片投稿接口全部删除。`/submit` 现在 301 到 `/submit/edit`。

账号页的历史记录改从 `page_revisions` 读取；测试 D1 已 drop `submissions` / `difficulty_votes`。生产 D1 的旧表按部署清单先导出再 drop。

## 4. 编辑与审核

- `/edit/<slug>/`：标题、封面、图片集、正文块、关卡表、神器、攻略、视频、标签、难度、信息框。
- `/submit/edit`：匿名单项编辑，已改走 `page_revisions`（`mode=single`）；整页入口跳 `/edit`。
- `page_revisions` 用 `mode=single | full` 区分单项 / 整页，两者共用同一审核台。
- 长文本 = ProseMirror `doc`；字号 12–32；颜色只允许 12 个 token。
- 视频 `{ url, kind, title }`，`title` 是编辑者自定义小标题（如「触发教程」）。
- 提交只带实际改动；`pending → approved → applied`；写回只允许 `data/content/<slug>.json`。
- 审核台支持正文块旧 / 新对比、关卡 / 视频覆盖数量、神器动作、标签与删除块。
- 当前 `page_revisions` 统一进入 `pending`；旧 submissions 的受信任直通规则已随旧链路删除。

## 5. 回滚

删除对应 `data/content/<slug>.json` 即回到 research 渲染；单个文件回滚不会影响其它地图。

## 6. 验证

```bash
npm run build:site
npm run test:content
npm run content:verify-content
npm run content:verify
npm run content:links
```

`content:links` 会跳过 `/api/*` 与 `/terr/*`：它们由 Worker / R2 在运行时提供，不在 `dist` 静态产物里。标签按大小写归一到同一页，避免 Windows 构建时标签页互相覆盖。

阶段 6 结果：`content:links` 0 死链、`build` 通过、`test:content` 10/10、`content:verify-content` 0 错误。测试环境无 R2，图集写回留到阶段 7 验证。`content:verify` 仍有 8 个既有 research `sections` 缺 `sources` 错误，未改 research。
