# 给地图换封面（用自己找的图，取代 3D 渲染图）

地图封面现在有两个来源，脚本会自动挑：

| 优先级 | 文件 | 谁生成的 |
| --- | --- | --- |
| 1 | `public/images/covers/custom/<地图英文名>.webp` | **人工**（本文要说的事） |
| 2 | `public/images/covers/<Steam 分片名>.webp` | `npm run data:covers` 从实体数据渲染的 16:9 缩略图 |

生成器在写 `src/content/maps/*.mdx` 的 `cover:` 时按这个顺序找，找到哪个用哪个。

## 怎么做

```bash
npm run cover:set -- ze_obj_abyss_v2 "D:\图片\封面.png"
```

- `<地图英文名>` 就是详情页副标题那串，也是 `src/content/maps/` 下的文件名（**不是** Steam 分片名 `2001-ze_xxx-123456`）。不确定就打开那张图的页面看。
- 图片随便什么格式（jpg / png / webp / avif…），脚本会裁成 16:9 并压成 webp。
- 默认输出 `1280×720`，一般 100 KB 上下。

然后提交这两个文件：

```
public/images/covers/custom/<地图英文名>.webp
src/content/maps/<地图英文名>.mdx          ← cover: 指过去了
```

> 只跑 `npm run build` 也行，构建的第一步就是生成器。

## 常用选项

| 选项 | 说明 |
| --- | --- |
| `--position top` | 裁切时贴哪一边：`centre`（默认）/ `top` / `bottom` / `left` / `right` / `attention` |
| `--mode contain` | **不裁切**，完整放下，四周填站点深色底。适合竖版海报、带文字的图 |
| `--width 1920` | 输出更宽（高度按 16:9 自动算） |
| `--quality 90` | webp 质量，默认 82 |

脚本会先告诉你原图比例、以及会不会被裁掉多少，觉得不合适就换 `--position` 或 `--mode contain` 再跑一次（重复执行会直接覆盖上一张）。

## 换回渲染图

```bash
npm run cover:set -- ze_obj_abyss_v2 --remove
```

删掉人工封面，再跑一次构建，这张图就回到实体数据渲染的封面。**不需要改任何配置。**

## 别人（贡献者）提 PR 换封面

**可以，而且不需要会用命令行。** 整个流程在 GitHub 网页上：

1. 打开 `public/images/covers/custom/` 目录
2. **Add file → Upload files**，把图片拖进去
3. 文件名 = **地图英文名**（`ze_obj_abyss_v2.jpg`），格式 `.jpg` / `.png` / `.webp` 都行
4. **Propose changes** → **Create pull request**

生成器在构建时会自动认这个文件，**不需要贡献者同时改 MDX**（合并后线上构建自己会重新生成）。所以 PR 里只有一个图片文件。

### 为了保证这条路走得通，做了这几件事

| | 为什么 |
| --- | --- |
| 生成器认 `.webp` / `.png` / `.jpg` / `.jpeg` 四种格式 | 普通人不会转 webp（要装工具），但人人都会存 jpg / png。只认 webp 等于把这条路堵死 |
| `npm run cover:verify` 校验文件名 | **最要命的一种错**：名字写成 Steam 分片名或拼错一个字符，这张图永远不会显示 —— 而构建、CI、页面全都正常。所以按错误处理，并直接给出正确写法 |
| 同一个校验查格式 / 体积 / 比例 | 体积硬上限 800 KB（防止有人往仓库里塞几 MB 的原图）、比例偏离 16:9 超过 15% 给提醒 |
| 校验步骤挂在 CI 的 PR 检查里 | 贡献者提完 PR 立刻在 PR 页面上看到红叉和原因，不用等站长人工看 |
| 图片缺失有兜底 | `npm run content:links` 会核 `dist` 里所有静态资源引用，封面文件没提交就是死链 → CI 红，不会静默 404 |

`cover:verify` 的尺寸读取是自己解析文件头（png / jpeg / webp），**不依赖 sharp** —— sharp 只是 astro 的传递依赖，校验脚本不该依赖它，否则哪天 astro 换了实现，CI 会莫名其妙挂掉。

## 几个容易踩的点

- **别直接覆盖 `public/images/covers/<分片名>.webp`**。那个目录是 `npm run data:covers` 的产物，批量重渲染一次就全被冲掉。人工封面单独放 `custom/` 子目录就是为了这个 —— 重渲染不会动它。
- **图片要提交进仓库**。封面走的是 `public/` 静态资源，不进仓库线上就是 404，`npm run content:links` 也会报死链。
- **比例**：卡片封面是 16:9 画幅，详情页顶部还会拿它当满宽背景大图（带遮罩）。所以选图尽量挑**横向、主体居中**的：竖图裁完往往只剩中间一条。
- 封面是**编辑行为**，不在社区投稿表单里 —— 投稿表单只收资料字段（难度、标签、来源、视频等），避免有人往页面塞任意外链图片。
