# ⚠️ 这里不要换封面

这个目录是脚本渲染出来的产物：

```bash
npm run data:covers          # 从实体数据渲染 16:9 缩略图
npm run data:covers --force  # 连已存在的也重新渲染
```

**想给某张图换封面，请把图片放进 [`custom/`](./custom/) 子目录**，文件名用地图英文名（例如 `ze_obj_abyss_v2.jpg`）。
生成器会优先取 `custom/` 里的图，找不到才用这里的渲染图。

为什么不让你直接换掉这里的文件：

- 平时确实能用（渲染脚本默认**跳过已存在的文件**），但有人跑一次 `npm run data:covers --force`，你的图就被冲掉了
- 事后光看文件名，分不清哪张是脚本渲染的、哪张是人换的

完整说明见 [`docs/cover-images.md`](../../../docs/cover-images.md)。
