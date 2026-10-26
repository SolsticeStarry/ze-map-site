# migration/

这里只放**一次性迁移归档**，不是运行时代码。

- `legacy/`：迁移前的 D1 / KV / community 导出，含投稿人、联系方式、IP 哈希等个人信息，已 gitignore，**不进入 PR**。
- SQL schema 迁移在上一级的 [`../migrations/`](../migrations/)。
- 当前内容层与审核链见 [`../docs/content-model.md`](../docs/content-model.md)。

一次性 `migrate-editorial` 脚本归档在 [`../scripts/legacy/`](../scripts/legacy/)，不再属于构建 / 运行路径。
