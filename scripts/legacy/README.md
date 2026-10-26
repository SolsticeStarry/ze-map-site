# scripts/legacy

一次性迁移脚本归档，不参与构建 / 部署 / 审核。

- `migrate-editorial.mjs`：把已删除的 `data/community` 迁到 `data/content`（已完成）。
- `community-doc.mjs`：旧 community 文档解析，仅供上面的迁移脚本使用。

当前内容模型见 [`../../docs/content-model.md`](../../docs/content-model.md)。不要在新代码里 import 这里的模块。
