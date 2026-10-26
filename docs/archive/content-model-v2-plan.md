> **历史规格**：v2 内容模型已实现，本文保留执行过程。当前系统见 [内容模型](../content-model.md)。

# 地图详情页内容模型 v2 — 重构计划

> 状态：分支 `refactor/content-model-v2`，基线 `8905529d`。
> 本文是执行规格，不是完成记录。

---

## 1. 目标与边界

### 目标

把详情页从「自动数据 + 社区附加块」改成读者可读、编辑者可整页编辑的百科式页面。

### 已锁定决策

- 保留 Astro 静态输出与现有 URL，不引入 MediaWiki / VEForAll。
- 玩家内容统一为 **JSON + TipTap / ProseMirror**；不再有玩家 Markdown 正文。
- 正文块统一存 ProseMirror `doc`。
- 字号允许 **12–32px 任意整数**。
- 颜色只允许 **12 个主题色 token**，不允许自定义 HEX。
- 长文本块允许字号 / 颜色 / 对齐；结构化字段不允许。
- 关卡表、神器表、基本信息、标题、视频、标签、封面都按结构化字段处理。
- **research 与玩家内容分开存储**：`research` 只能通过仓库编辑和内容管线维护；玩家后续投稿只写入玩家内容层。页面按字段合并，玩家已审核发布的覆盖优先，否则回退 research；research 专属字段只读。
- **神器 / 道具允许玩家编辑**：行级增改删、说明 / 备注、排序；不允许富文本样式。
- 先用约 130 张有真实内容的图验证新渲染；不批量复制 research。
- 保留「审核后发布」；整页修订需登录，单字段小修仍可匿名。沿用现有投稿的人机验证语义：配置 secret 时，带 token 就校验，未带 token 仍允许投稿，依靠限流和人工审核兜底。
- 编辑器只在 `/edit/**` 动态加载，不进入静态页 bundle。

---

## 2. 页面结构

```
[全宽] 标题区：主标题 / 英文名 / 别名 / 难度·游戏·标签 / 速览
       ↓
[主栏] 1. 大封面（选自图片集，无文字遮罩）
       2. 图片集（缩略图，排除封面图）
       3. 背景故事
       4. 地图概览（简介 + 关卡 + 关卡表）
       5. 神器 / 道具
       6. 攻略技巧（核心编辑区，自由小条目）
       7. 视频
       8. 同类地图
          （折叠附录：工坊自述 / 音乐 / BOSS / 资料来源 / 数据说明）

[侧栏] 目录 / 信息框（含难度投票、下载、标签）/ 实体预览 / 编辑本页
```

规则：

- 主标题在封面上面；标题区不再有背景图。
- 封面在主栏第一块，侧栏信息框与其并排。
- 封面从下方网格移除；剩余 0 张时整块与目录项都不渲染。
- 831 张纯数据图：信息框 + 封面（如有）+ 预览入口 + 待补充提示 + 折叠附录。
- 视频分类收为三类：通关视频 / 攻略 / 音乐。
- 附录在视频之后、同类地图之前，默认折叠。
- 页面展示可以简化社区区块，但必须保留已发布内容的作者、修订者、时间和投稿编号等追溯信息；可通过简洁署名或编辑历史入口展示。

### 2.1 固定骨架与局部可调

一级区块顺序固定为：

```
cover → gallery → story → overview → items → guide → videos → related
```

| 范围 | 可调 | 存储 | 说明 |
|---|---|---|---|
| 攻略技巧小条目 | 是 | `blocks[]` 中 `guideItem` 的顺序 | 添加 / 删除 / 上下移动 |
| 关卡表行 | 是 | `stageRows` 数组顺序 | 结构化管理，不允许富文本 |
| 神器 / 道具行 | 是 | `itemOrder`（`itemKey` 数组） | 未列出的行按基表顺序追加 |
| 视频条目 | 是 | `videos` 数组顺序 | 分类顺序固定 |
| 编辑器字段显示顺序 | 是 | 浏览器 `localStorage` | 只影响表单排列 |
| 封面 / 图片集 / 同类地图 | 否 | 固定 | 封面单独选图 |
| 一级区块顺序 | 否 | 固定骨架 | 不开放排序 |

`overview` 内部固定：简介 → 关卡摘要 → 关卡表。

### 2.2 字段策略：谁允许富文本

| 字段 | 格式 | 字号 / 颜色 / 对齐 |
|---|---|---|
| 背景故事 / 简介 / 玩法与关卡 | `doc` | ✅ |
| 攻略技巧小条目正文 | `doc` | ✅ |
| 攻略小条目标题 | 纯文本 | ❌ |
| 地图标题 | 纯文本 | ❌ |
| 基本信息（作者 / 版本 / 人数 / 时长 / 关卡 / 体积 / 别名） | 纯字符串 | ❌ |
| 关卡表全部单元格 | 纯字符串 | ❌ |
| 神器表（名称 / 冷却 / 次数 / 说明 / 备注） | 纯字符串 / 数字 | ❌ |
| 视频 / 标签 / 封面 | 结构化字段 | ❌ |

### 2.3 页面配色（GTNH 参考）

- 亮色：底 `#fff`、次底 `#f6f8fa`、正文 `#333`、弱化 `#777`、主色 `#4a72a4`、链接 `#428bca`、边框 `#d5dfe8` / `#c4ced7`、表头 `#eaecf0`、表底 `#f8f9fa`、表边框 `#a2a9b1`。
- 状态色：成功 `#5cb85c`、信息 `#5bc0de`、警告 `#f0ad4e`、危险 `#d9534f`。
- 暗色：同色相推导；正文对比度 ≥ 7:1，弱化文字 / 按钮 ≥ 4.5:1。
- 顶栏 `#333`；默认暗色，亮色主题采用 GTNH。
- 替换现有硬编码红 / 青 / 紫（`#ff4d4d`、`#22d3ee`、`#a855f7` 等）为页面 token；保留处注明用途。
- 页面主题色与富文本 12 色分开：页面色管 UI；`doc-color-*` 只用于正文强调，亮暗各一套。

---

## 3. 数据模型

### 3.0 数据分层与覆盖原则

`data/research` 是站点整理层，`data/content` 是玩家层，两者**分开存储**。两层的写入权限和页面合并语义必须分开：

| 层 | 位置 | 谁写 | 作用 |
|---|---|---|---|
| R 站点整理 | `data/research/<slug>.json`、`data/gfl-parsed/<slug>.json` | 站长 / 资料整理，通过仓库提交与内容管线维护 | 基线正文、结构化资料、神器配置 |
| P 玩家内容 | `data/content/<slug>.json` | 编辑页（审核后写回） | **只存玩家实际修改过的内容** |
| G 自动生成 | `scripts/content/generate-map-entries.mjs`、实体 / 工坊抓取 | 构建管线 | 实体统计、工坊统计等 |

合并规则（逐字段 / 逐节 / 逐块）：

1. 玩家层有已审核发布的覆盖值 → 用玩家
2. 否则 research 有值 → 用 research
3. 否则自动生成
4. 都没有 → 不渲染

约束：

- `data/content` 是**覆盖层**，不是 research 的副本；未修改内容不写入。
- `data/research`、`data/gfl-parsed` 和自动生成数据不接受网页编辑接口；research 的修改仍走仓库编辑、生成器和 CI。
- 现有 `data/community` 是旧玩家层：P2 把其中可编辑内容迁移为 content 覆盖，之后玩家投稿不再新增或修改 community 字段覆盖；迁移前的作者、修订、时间、投稿编号和 log 必须保留到 content 的历史字段或等价审计记录中。
- 玩家内容**不写** `data/research`；网页审核写回只允许写 `data/content/<slug>.json`，图片清单和媒体对象按现有媒体流程写入对应存储。
- 未提交字段 = 保留当前玩家层状态；明确执行“重置为 research”才移除该字段覆盖；明确执行“清空”才写入允许为空的覆盖值。不能因为一次小修没有携带某字段就删除该字段的既有玩家覆盖。
- 文本块缺失且没有显式清空 / 重置操作 = 回退 research；玩家不能通过普通缺省字段间接删除 research 的固定块。
- 攻略技巧是例外：只要存在 `guideItem`，整节 guide 使用玩家版本；research 只作为编辑时的基线。
- 仅 research 字段（玩家不可编辑）：
  - 实体数 / 实体构成 / 实体预览
  - 工坊订阅 / 浏览 / 下架状态 / 发布与更新日期
  - 地图 slug / 英文名 / 游戏平台
  - research 基线难度；编辑页不直接改难度基线，但保留现有难度字段投稿、投票和审核合并流程
  - 数据来源 / 数据说明
- 冲突与版本：
  - 内容文件记录 `researchRev`（research 的哈希 / updatedAt）。
  - 未覆盖字段永远读最新 research；覆盖内容保持玩家值。
   - research 更新后，审核台提示「research 已更新」，但不自动丢弃玩家覆盖。

### 3.0.1 统一读取入口与来源历史

- 所有地图消费方必须从统一读取入口取得合并后的地图数据：详情页、地图库、首页、搜索、标签页、同类推荐、投稿预填和编辑器预览不得各自读取或合并 `data/research`、`data/content`。
- 统一读取入口负责逐字段合并、标签归一化、视频分类兼容和媒体清单关联；详情页只负责页面布局与展示。
- 编辑器预览必须调用与详情页相同的合并函数，确保“编辑器看到的结果”和“提交后详情页看到的结果”使用同一套回退规则。
- 玩家覆盖必须保留作者、首次投稿时间、最近修订者、最近修订时间、投稿编号和必要的操作日志。展示可以简化，但审核 diff、个人投稿记录、最近改动和作者修订 / 删除申请必须能追溯到这些信息。
- research 的作者、来源和整理信息仍属于 research 层；玩家署名不能覆盖或冒充站点整理者和原地图作者。

### 3.1 玩家内容文件

`data/content/<slug>.json`：

```json
{
  "v": 1,
  "researchRev": "sha256:…",
  "heroImage": "https://terr.ze-map.cn/gallery/<slug>/u12.webp",
  "blocks": [
    { "id": "story",    "type": "story",    "doc": { "type": "doc", "content": [] } },
    { "id": "intro",    "type": "intro",    "doc": { "type": "doc", "content": [] } },
    { "id": "gameplay", "type": "gameplay", "doc": { "type": "doc", "content": [] } },
    { "id": "guide-1",  "type": "guideItem", "title": "理智值是第二条血条", "doc": { "type": "doc", "content": [] } },
    { "id": "guide-2",  "type": "guideItem", "title": "开局先看本局关卡", "doc": { "type": "doc", "content": [] } }
  ],
  "infobox": { "authorNote": "社区补充：本服使用 64 人配置" },
  "stageRows": [],
  "itemEdits": [],
  "itemOrder": [],
  "videos": []
}
```

规则：

- `blocks` 是玩家正文覆盖的唯一来源；`doc` 是 ProseMirror JSON。research 正文仍由 research 的结构化字段或兼容读取器提供，不能为了填充 `blocks` 而批量复制到玩家层。
- `story / intro / gameplay` 各最多一个；`guideItem` 0–30 个。
- 固定块缺失 = 回退 research；`guideItem` 存在 = 整节 guide 覆盖 research。
- `infobox` 只存玩家改过的键；`stageRows` / `videos` 只在玩家改过时出现。字段缺失表示“保留当前覆盖并继续回退”，不表示在一次局部提交中删除。
- `itemEdits` 只存增 / 改 / 删的行；`itemOrder` 只存顺序。
- 覆盖字段区分三种操作：未提交（保留现状）、设置值（新增或替换玩家覆盖）、重置（删除玩家覆盖并回退 research）；允许为空的字段另以显式清空操作表示。
- 玩家内容的作者、修订和审计元数据与内容值一起稳定序列化；不能只保存最后一份无来源的正文。
- 序列化稳定：固定 key 顺序、2 空格缩进、稳定块 id，降低 git diff 噪音。

### 3.2 富文本 schema

允许的节点：

```
doc
paragraph
heading (level 3 / 4)
text
hardBreak
bulletList
orderedList
listItem
blockquote
codeBlock
horizontalRule
figure
```

允许的 mark / 属性：

| 能力 | 存储 | 规则 |
|---|---|---|
| 粗体 / 斜体 / 下划线 / 删除线 | mark | 是 |
| 链接 | mark | 只允许 `https:` |
| 字号 | `textStyle.fontSize` | 12–32 整数 |
| 颜色 | `textStyle.color` | 12 个 token 之一 |
| 对齐 | `paragraph/heading.textAlign` | left / center / right |

禁止：原始 HTML、任意 HEX、字体族、字重、行高、背景色、position、url()。

`figure` 只允许引用本图图片集：`n` 1–36，`side` left/right；禁止外链图片。

### 3.3 12 个颜色 token

```
red / orange / amber / green / teal / cyan
blue / indigo / purple / pink / gray / brown
```

- 亮色、暗色主题各有一套 CSS 变量。
- 每个 token 与对应面板背景对比度 ≥ 4.5:1。
- 内容只存 token 名，不存色值；编辑器只显示色块 + 名称，不提供取色器。
- 渲染时映射为 class（如 `doc-color-red`）或 `var(--doc-red)`，不允许内联任意色值。

### 3.4 关卡表

固定列：`关卡 / 名称 / 目标 / 关键流程 / 神器·道具 / 团灭点·备注`。

- 一行一关；范围写作 `第 1-2 关`。
- 来源：content 有覆盖就用 content，否则 research；两者都空时只显示 `stages` 数量。
- 数组顺序即表格行顺序；最多 30 行；`no` 不允许重复。
- 表格单元格是**结构化字段**：纯文本，不允许字号 / 颜色 / 对齐。
- 编辑时文本域可自动增高，但只是布局，不是富文本样式。
- 窄屏转为卡片布局，禁止横向滚动。

### 3.5 神器 / 道具

自动收集的信息有限：GFL 配置只有名字、冷却、次数，说明与服务器差异需要玩家补。

- **基表（research）**：`data/gfl-parsed/<slug>.json` + research 里的神器说明。
- **玩家层（content）**：`itemEdits` 逐行覆盖，未覆盖的行使用基表。
- **顺序**：`itemOrder`（`itemKey` 数组）；未列出的行按基表顺序追加。

`itemEdits` 行：

```json
[
  { "action": "update", "name": "Bag of Fire Salt", "cd": 50, "uses": 0, "intro": "…", "note": "本服 50 秒" },
  { "action": "add", "name": "新道具", "cd": 30, "uses": 1, "intro": "…" },
  { "action": "remove", "name": "Broken Flashlight", "note": "本图没有" }
]
```

规则：

- 名字：基表 / 社区行只读；新增行可填写。
- 冷却、次数、说明、备注可编辑；行内字段留空 / 未写表示本次不修改该项，继续保留当前玩家覆盖或回退到 research；要恢复 research 必须使用显式重置操作。
- 说明 / 备注用多行输入，按文本行数自动增高；不固定行高、不遮挡。
- 删除必须显式 `action: remove`；页面不显示该行，表下保留一句「社区反馈本图没有」。
- 合并：`mergeItems(base, itemEdits)` 后按 `itemOrder` 排序。
- 校验：复用现有 `itemlist` 规则（最多 40 行、名称 ≤60、说明 ≤200、备注 ≤200、冷却 0–3600、次数 0–99）。
- **神器表不允许富文本样式**：说明 / 备注是纯文本。
- 编辑器每行标 `服务器配置 / 社区补充 / 玩家修改 / 新增 / 已移除`；每行可「重置为 research」。
- 审核 diff：按行显示新增 / 删除 / 修改 / 顺序变化。

### 3.6 攻略技巧（核心富文本区）

攻略技巧是玩家编辑的核心，使用「小条目」块：

- 每个小条目 = 标题（纯文本）+ 富文本正文（`doc`）。
- 可自由添加 / 删除 / 上下移动，数量上限 30。
- 长文本正文允许字号 / 颜色 / 对齐；标题不允许。
- 有玩家 `guideItem` → 整节覆盖 research 攻略；没有 → 使用 research。
- 编辑器打开无玩家 guide 的图时，把 research 攻略转成 blocks 作为基线；保存后形成玩家整节覆盖。
- 编辑体验接近 Word：白纸式页面、标题与正文直接编辑、浮动工具栏。
- 审核按块 diff：新增 / 删除 / 顺序 / 标题 / 正文 / 样式摘要。

### 3.6.1 局部编辑的提交语义

- 编辑器提交的是“玩家层变更”，不是整份最终页面快照；一次只修改一个字段时，其他玩家覆盖必须原样保留。
- 字段操作必须显式区分：未提交（保留当前玩家覆盖或当前回退结果）、设置（写入或替换玩家覆盖）、重置为 research（删除该字段的玩家覆盖）、清空（只对允许为空的字段写入显式空值）。
- 删除攻略小条目、关卡行、神器行或视频条目必须在 diff 中显示为删除；不能通过 payload 缺省让审核员猜测删除意图。
- 视频补充默认沿用现有追加 + 去重语义；若提供整组替换，审核 diff 必须列出被删除的旧条目。
- “恢复 research”只移除玩家覆盖，页面随后重新读取最新 research；已发布玩家内容的删除仍需审核，并保留删除记录。

### 3.7 封面与图片集

回退链：

`heroImage` → 当前 `cover`（若在图片集中）→ 第一张 `kind: workshop` → 图片集第一张 → 当前 `cover` → `null`。

- 尺寸：主栏宽度；桌面 `aspect-ratio: 5/2`（宽度不变、降低高度），移动端 `2/1`，圆角 16px。
- 标题区底层用同一张封面图做浅背景，横跨整个视口宽度（亮色约 18%、暗色约 28%，去饱和 + 底部渐变到页面底色），复刻原站上部效果。
- 封面用 `<img>`，`preloadImage` + `fetchpriority="high"`；`og:image` 用封面。
- 封面图从图片集网格移除；封面不要求灯箱。
- 列表页卡片继续使用现有 `cover`。
- 封面选择只从已有图片集选，不新增上传通道。
- 图片集只收工坊作者公开预览图和玩家有权提供的真实游戏截图；不收本站渲染的示意图。
- 图片本体继续存 R2，仓库只存图片集清单；页面优先使用现有同源 `/terr/gallery/...` 地址，以保留缓存和国内访问回退策略。
- 视频继续使用点击后加载的 facade；投稿只收 B 站 / `b23.tv`，保留原站回链，不下载、不转存视频。
- 图片与视频收到作者或权利人撤下要求时，按现有下架规则处理：删除对应副本或链接、清理清单和玩家引用，不能只隐藏页面上的一处。
- 正文图片引用应优先使用稳定图片标识；若本期仍使用序号，必须在删除或重排图片后重新校验引用，不能让序号静默指向另一张图。玩家图片上限 36 张只计算 `kind: user`，工坊预览图不占名额。

#### 最终视觉参数（与 Demo 一致）

```css
/* 封面框：铺满、裁切，不留黑边 */
.cover-btn {
  width: 100%;
  aspect-ratio: 5/2;
  overflow: hidden;
  border-radius: 16px;
}
.cover-btn img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center 45%;
}
@media (max-width: 720px) {
  .cover-btn { aspect-ratio: 2/1; }
}

/* 标题区：全宽浅背景，内容仍对齐 1240 容器 */
.title-block {
  position: relative;
  overflow: hidden;
  width: 100vw;
  margin-left: calc(50% - 50vw);
  margin-right: calc(50% - 50vw);
}
.title-inner {
  position: relative;
  z-index: 1;
  max-width: 1240px;
  margin: 0 auto;
  padding: 0 24px;
}
.hero-wash {
  position: absolute;
  inset: 0;
  background: var(--hero-image) center 34% / cover no-repeat;
  opacity: .18;
  filter: saturate(.9);
  pointer-events: none;
  -webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,.95), rgba(0,0,0,.45) 60%, transparent 100%);
  mask-image: linear-gradient(to bottom, rgba(0,0,0,.95), rgba(0,0,0,.45) 60%, transparent 100%);
}
.hero-wash::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, transparent 0%, var(--bg) 100%);
}
[data-theme="dark"] .hero-wash { opacity: .28; }
@media (max-width: 720px) {
  .title-inner { padding: 0 16px; }
}
```

规则：

- 浅背景与封面使用**同一个图片 URL**：页面模板在外层写 `--hero-image: url("<heroImage>")`，避免重复下载；Demo 用 JS 把封面 `img.src` 写进该变量。
- 浅背景仅作氛围：`aria-hidden="true"`、`pointer-events:none`；标题、徽章、速览在 `.title-inner` 内。
- 封面 `object-fit: cover` 必须同时作用在 `width/height:100%` 上，否则原图自带的黑边会露出来。
- 移动端仍保持全宽浅背景，只收窄内容内边距。
- 调整主题或透明度后，先检查标题与正文对比度，再改数值。

### 3.8 视频

只保留三类：

```js
export const VIDEO_CATEGORIES = {
  run: '通关视频',
  guide: '攻略',
  music: '音乐',
};
```

旧 `videoKinds` 映射：`通关视频→run`；`老司机经验 / 触发攻略 / 彩蛋触发 / 相关视频→guide`；`音乐→music`。


---

## 4. 删除 / 合并 / 折叠

### A. 直接删（不渲染进正文）

`数据说明`、`数据概况`、`实体构成`、`实体预览`（正文内链接块）、`实体分布图`、`社区评价`、`社区补充`、`社区整理`块、`社区整理版（未采纳）`、速览里的实体数与工坊订阅、署名详情行、三个投稿按钮、社区致谢/改动记录、数据来源卡。

### B. 合并后删

| 原标题 | 目标 |
|---|---|
| 简介 / 摘要 / 简介（社区投稿） | `intro` |
| 背景故事 / 剧情 / 地图由 X 绘制 / 背景故事（社区投稿） | `story` |
| 关卡 / 关卡流程 / 关卡流程（经典版）/ 现代版 / 版本历史 / 更新日志 | `gameplay` / 关卡表 |
| 人类策略 / 僵尸策略 / 常见问题 / 攻略 / 神器讲解 / 社区整理 | `guideItem` |
| 基本信息 | 信息框 |
| 神器 / 道具 / 神器表 / Materia / 神器更正 / 社区神器补充 | `items` |
| 来源 / 资料来源 | 附录 |
| 视频攻略 | `videos` |
| 下载入口 / 标签 | 信息框 |

### C. 折叠附录

`工坊页面自述`、`音乐`、`BOSS`、`资料来源`、`数据来源` 一句话、预览暂无的完整说明。

### D. 保留

stub 提示、视频分类与展开、Pagefind 筛选、英文名、别名、徽章、关卡/人数/时长、目录、预览入口、信息框、下架提示、待补充、难度投票、移动端栏/抽屉/灯箱/视频 facade。

---

## 5. 渲染

- 玩家 `doc`：schema 校验 → 生成 HTML（TipTap `generateHTML` 或等价 ProseMirror 序列化）。
- research 正文：`markdown-it`，`html:false`，链接只允许 https；复用 `shared/guide-blocks.mjs` 处理 `:::figure N`。
- 正文基线：research 的 story/intro/gameplay 与 guide；content 中同名块覆盖；`guideItem` 存在时整节 guide 覆盖。
- 神器：GFL 基表 + research 说明 → 应用 `itemEdits` → 按 `itemOrder` 排序。
- 视频 / 标签 / 信息框：玩家有值用玩家，否则 research / 自动生成。
- 生成器只输出 frontmatter、自动数据与折叠附录；**不再把 research 正文复制进玩家内容**。
- 删除正文里的 `<MapGallery>` 标记；图片集由模板渲染。
- 生成器输出附录标题降为 `###`，便于结构断言。
- 不使用 `innerHTML` 直接塞用户 JSON；生成 HTML 后再做一次 DOM 清洗兜底。

---

## 6. 编辑器

新增 `/edit/<slug>/`，视觉与详情页一致：

- 标题区：标题可直接编辑；「编辑标题」按钮聚焦。
- 长文本块：背景故事 / 简介 / 玩法与关卡 / 攻略技巧小条目正文变成富文本编辑框；focus 时出现浮动格式工具栏。
- 攻略技巧：Word 式纸面；每个小条目 = 标题 + 富文本正文；添加 / 删除 / 上下移动。
- 信息框：可编辑字段用右对齐输入框；research 专属字段只读并标注「research」。
- 关卡表：结构化表格内编辑；文本域可自动增高，但无富文本样式。
- 神器表：表格内直接编辑冷却 / 次数 / 说明 / 备注；说明 / 备注多行自动增高；基表行名字只读；每行可「重置为 research」。
- 视频 / 标签 / 封面：对话框管理；封面从图片集选择。
- 预览：按 research + 玩家覆盖的最终效果渲染。
- 本地草稿、自动保存、离开提醒。
- 整页修订必须登录；单字段小修仍可匿名。
- 服务端与客户端共用 `shared/page-schema.mjs` 校验。

### 6.1 富文本工具栏

只对长文本块显示：

- 粗体、斜体、下划线、删除线
- H3 / H4
- 无序列表、有序列表、引用
- 链接、字号、颜色、对齐
- 撤销 / 重做 / 清除格式

结构化字段不显示富文本工具栏。

### 6.2 依赖

```bash
npm i @tiptap/core @tiptap/starter-kit @tiptap/extension-text-style \
  @tiptap/extension-color @tiptap/extension-text-align \
  @tiptap/extension-link @tiptap/extension-underline \
  @tiptap/extension-placeholder @tiptap/html
```

字号 / `figure` 节点用自定义扩展。

### 6.3 提交 payload

只带玩家改过的内容：

```json
{
  "baseRev": "<内容文件哈希>",
  "researchRev": "<research 哈希>",
  "title": "后室2:失眠症",
  "heroImage": "...",
  "blocks": [
    { "id": "story", "type": "story", "doc": { "type": "doc", "content": [] } },
    { "id": "guide-1", "type": "guideItem", "title": "…", "doc": { "type": "doc", "content": [] } }
  ],
  "infobox": { "author": "…", "stages": "6" },
  "stageRows": [],
  "videos": [],
  "itemEdits": [],
  "itemOrder": []
}
```

- 未出现的字段 = 用 research；不要整篇复制 research。
- `blocks` 只带玩家改过的固定块与完整 guide 块（有 guide 编辑时）。
- `itemEdits` 只带增 / 改 / 删的行；未出现的行 = 基表。
- `stageRows` / `videos` 仅在玩家改过时提交。

---

## 7. 审核与安全

### 7.1 现有安全基线（沿用，不重写）

| 控制 | 位置 | 说明 |
|---|---|---|
| 审核台密钥 | `worker/http.ts` `checkAdmin` | `ADMIN_TOKEN` 未配置时 503；`safeEqual` 恒定时间比较 |
| 同源检查 | `worker/http.ts` `checkOrigin` | 有 `Origin` 时必须同 host |
| 请求体上限 | `worker/http.ts` `readJsonBody` | 超限 413 |
| 限流 / 封禁 | `worker/http.ts` `allowWrite` / `isBanned` | 按 `ip_hash` 分桶 |
| 会话 | `worker/auth.ts` | HMAC 签名 Cookie；`HttpOnly; SameSite=Lax; Secure`；`pass_ver` 使旧会话失效 |
| 口令 | `worker/auth.ts` | PBKDF2-SHA256 / 10 万次 / 随机盐；连续失败锁定；登录限流 |
| 投稿校验 | `worker/submissions.ts` + `shared/submission-fields.mjs` | 服务端权威校验；字段白名单；`SLUG_RE` |
| 发布分离 | `worker/submissions.ts` | `approved` 只入队；`flush` 才写 git |
| 写回 | `worker/community.ts` | 细粒度 PAT；路径由服务端生成；commit 后更新 D1 |
| 图片 | `worker/covers.ts` / `worker/gallery.ts` | magic bytes；尺寸/体积上限；服务端文件名；KV TTL |
| 审核台渲染 | `src/pages/admin/index.astro` | 全部 `textContent`，禁止 `innerHTML` |
| 本人操作 | `worker/my-submissions.ts` | 校验 `user_id`，只能改自己的投稿 |

### 7.2 新流程必须解决的问题

1. **审核台令牌**
   - 现状：`ADMIN_TOKEN` 存在浏览器 `localStorage`，长期有效、共享身份。
   - 要求：审核台新增内容一律 `textContent`；块级 diff 禁止 `innerHTML`；增加 CSP；至少为每位审核员发独立令牌；令牌支持轮换；审核接口加限流。
2. **CSRF / 跨站**
   - 所有依赖 Cookie 的写操作（密码、资料、整页修订）在缺少 `Origin` 时拒绝；`/api/admin/*` 保持 Bearer，不添加 CORS。
3. **内容是不可信输入**
   - `doc` 必须按 schema 校验：节点 / mark / 属性全部白名单。
   - 字号 12–32 整数；颜色必须命中 12 token；链接只允许 https；`figure.n` 1–36。
   - 禁止原始 HTML、任意 HEX、字体族、背景色、position、url()。
   - research Markdown 仍 `html:false`。
   - 管理员 diff 必须转义后再输出。
4. **路径与 SSRF**
   - 写回只允许 `data/content/<slug>.json`；玩家内容永远不写 `data/research`、`data/gfl-parsed`。
   - 路径必须来自 `SLUG_RE` 校验后的 slug。
   - `heroImage` 必须存在于该图图片集清单，且 host 只允许站内 / R2。
5. **并发与覆盖**
   - 提交带 `baseRev`；写回前读取当前文件哈希。
   - 哈希不一致 → 标记冲突，不覆盖；不得静默 last-write-wins。
   - 同一 slug 多笔待写回修订按创建顺序串行应用。
6. **审核 ≠ 发布**
   - 保持 `pending → approved → applied`；`approved` 绝不改仓库。
   - 写回前重新执行一遍 schema 校验。
    - 受信任账号沿用现有 `account.trusted` 规则：符合资格的账号投稿直接进入 `approved` 待写回队列，其他投稿进入 `pending`；整页修订仍必须登录，但不另造一套与现有账号等级冲突的免审规则。
7. **滥用与配额**
   - 整页 payload 设上限（建议 64 KB），`readJsonBody` 提前拒绝。
   - 按账号与 IP 双重限额；整页修订限额低于普通投稿。
    - 投稿沿用现有 Turnstile 规则：配置 `TURNSTILE_SECRET` 时，有 token 就校验；没有 token 仍允许投稿。校验服务不可用或 token 无效时拒绝该次请求，未配置 secret 时依赖限流 + 人工审核。
   - `page_revisions` 设置保留策略。
8. **审计与隐私**
   - `page_revisions` 记录：`map_slug`、`submission_id`、`base_rev`、`payload`、`created_at`。
   - 发布记录：`reviewer`、`reviewed_at`、`commit_sha`。
   - 只存 `ip_hash`，不存明文 IP；日志不含令牌、会话 Cookie、完整联系方式。
   - 提交信息中的 `submitter` / `reviewer` 必须去掉换行。
9. **图片**
   - 继续复用 magic bytes、尺寸、体积、服务端文件名。
   - 新封面只做「从已有图片集选择」，不新增上传通道。
10. **失败关闭**
    - 缺少 `ADMIN_TOKEN`、`IP_SALT`、schema 或校验模块异常时拒绝写入，不降级放行。

### 7.3 安全验收用例

- 字号 11 / 33 / 小数 → 拒绝。
- 自定义 HEX、原始 HTML、外链图片、非法 mark → 拒绝。
- `figure.n` 越界 → 拒绝或降级为文字。
- 链接 `javascript:` / `data:` → 拒绝。
    - 编辑器 payload 覆盖 research 专属字段（实体数 / 工坊统计 / slug / 英文名等）→ 400；难度仍沿用现有独立投稿与投票流程，不由整页编辑器直接改基线。
- `itemEdits` 超行数 / 超字数 / 非法 action → 400。
- 未登录提交整页修订 → 401；无 `Origin` 的 Cookie 写操作 → 403。
- 过期 `baseRev` → 409；写回时文件已变 → 冲突，不覆盖。
- 重复点击写回 → 幂等，不产生重复 commit。
- 超长 payload → 413；高频整页提交 → 429。
- 审核台 XSS 用例（块标题、正文、diff）→ 无脚本执行。

---

## 8. 130 张验证与覆盖迁移

名单：107 有简介 + 18 有手写 sections + 13 有社区背景故事，去重约 130。

**原则：不把 research 批量复制成玩家内容。**

- 130 张主要用于**验证新渲染器**：research 的 sections 按 B 类规则映射到 story/intro/gameplay/guide，页面直接读 research。
- 只有**已有的玩家内容**才生成 `data/content/<slug>.json`：
  - `data/community` 里的 story / guide / section / summary 笔记 → 对应 block 或 `guideItem`。
  - 玩家改过的 tags / videos / items / cover → 对应字段覆盖。
  - research 专属字段（实体数 / 工坊统计 / 难度）不迁移到 content；其中的旧社区覆盖由站长先合入 research，再从旧文件移除。
- A 类丢弃；C 类不写入 content，仍由生成器附录提供。
- 旧 `data/community` 中的整篇草稿不能直接当作 research 写回；迁移时只作为玩家层内容或迁移报告处理。只有后续明确的仓库编辑，才能修改 `data/research`。
- 已通过、已写回和已采纳的旧投稿都要保留可追溯关系；若旧社区文档同时承担页面覆盖和历史记录，迁移脚本必须拆出当前玩家值与历史元数据，不能只保留最终文本。
- 三张富内容图（魔晄炉 / 米纳斯 / 皇家港）：
  - research 里的 `<StageAccordion>` 解析为 `stageRows` 基线（写进 research，不进 content）。
  - `<VideoEmbed url>` → research 视频基线。
  - `<RouteMap>` 丢弃。
  - `<GuideFigure>` 能映射到图片集序号则转 `figure` 节点，否则报告。
  - HTML 表格按内容归入 research 的 gameplay / guideItem，或丢弃并报告。
- `--dry-run` 输出：哪些图有玩家覆盖、哪些只是 research 基线、未识别节点。
- 迁移前打 tag；迁移后用排序文本快照对比，差异只允许 A/C 类。
- 完成条件：130 张 research 渲染与旧页一致（少噪音）；content 文件只包含真实玩家内容；零 research 副本；旧社区投稿的作者 / 修订 / 时间 / 投稿编号可追溯；一次局部迁移不会清掉同图其他玩家覆盖。

---

## 9. 阶段计划

本阶段顺序采用**视觉与交互先行，数据管线后接入**的方式。V0–V3 和 V-Gate 只使用固定 fixture、浏览器本地状态和模拟审核状态，不写 D1、不写 Git、不迁移存量数据；但交互协议、字段名和 diff 形状必须尽量使用最终设计，避免做成无法接入真实数据的假页面。

| 阶段 | 任务 | 完成条件 |
|---|---|---|
| **V0 视觉基线** | 整理详情页、编辑页、审核页共享的 fixture；确定页面容器、字号层级、颜色 token、响应式断点、状态色和空状态 | 三页可以用同一份样例地图打开；亮暗主题、桌面 / 移动端截图基线确定 |
| **V1 详情页切片** | 完成新版详情页固定骨架：标题区、封面、图片集、正文、关卡表、神器表、攻略、视频、附录、侧栏和目录 | 不接真实内容管线也能完整浏览；空数据、纯数据图、富内容图、无预览图四种状态可展示；移动端不横向溢出 |
| **V2 编辑页切片** | 完成 `/edit/**` 的真实编辑体验：富文本、攻略条目增删排序、关卡表、神器表、视频 / 标签 / 封面管理、预览、本地草稿、显式设置 / 重置 / 清空 | 使用 fixture 编辑后预览即时更新；刷新前后本地草稿可恢复；删除、重置和未提交字段的语义可见；不调用真实提交接口 |
| **V3 审核页切片** | 完成审核队列、现值 / 新值、块级 diff、样式摘要、媒体 diff、通过 / 驳回、待写回、冲突和错误状态的视觉与交互 | 至少覆盖新增、修改、删除、排序、修订、撤回、待写回和冲突八种状态；审核员无需看 JSON 就能判断改动 |
| **V-Gate 视觉验收** | 对三页进行产品评审和截图验收，集中修正布局、文案、操作路径和移动端行为 | 详情页、编辑页、审核页视觉与交互冻结；未通过前不进入真实数据管线 |
| **P0 内部契约** | 固化最终字段模型、ProseMirror schema、共享校验、合并规则、提交操作语义、作者 / 修订 / 投稿编号元数据和 fixture 到真实模型的映射 | 服务端与客户端共用 schema；研究层只读；玩家层只保存覆盖；所有字段都有设置 / 重置 / 清空定义 |
| **P1 统一读取层** | 接入 `data/research`、`data/gfl-parsed`、`data/gallery` 和 `data/content`；建立统一地图读取入口，详情页、列表、搜索、标签、推荐和编辑器预览全部复用 | research 基线与旧页面对照通过；玩家覆盖只影响允许字段；未覆盖字段跟随最新 research；无重复合并逻辑 |
| **P2 迁移与兼容** | 审计并迁移旧 `data/community`；保留作者、修订、时间、投稿编号、日志和媒体引用；130 张地图 dry-run、快照对比和异常报告 | 零 research 副本；真实玩家内容不丢；旧稿无法解释的内容进入报告；迁移可重复、可回滚 |
| **P3 真实编辑提交** | 将编辑页从 fixture 切换到统一读取接口和真实提交 payload；加入登录、匿名小修、账号署名、草稿和作者修订 / 删除申请 | 试点地图可以加载、修改、预览并生成只包含实际变更的待审 payload；其他玩家覆盖不被清除 |
| **P4 审核与发布闭环** | 接入 D1、服务端 schema 校验、审核 diff、`pending → approved → applied`、攒批写回、冲突保护、通知和媒体写回 | 完成真实端到端流程；沿用受信任账号和投稿 Turnstile 规则；research 永远不被网页写回 |
| **P5 清理与上线** | 删除旧玩家 Markdown / community 读取路径和重复草稿逻辑；保留必要兼容期；更新贡献、审核和回滚文档 | `build`、测试、内容校验、链接检查全绿；旧路径有明确迁移或关闭结果；可用单个 content 文件回滚 |

V-Gate 是硬闸门：三页视觉和交互没有确认前，不开始 P0 之后的真实数据接入。

---

## 10. 验证命令

```bash
npm run build
node --test worker/*.test.mjs scripts/content/*.test.mjs
npm run content:verify
npm run content:links
```

新增脚本（V0–P2）：

```bash
node scripts/content/audit-editorial.mjs
node scripts/legacy/migrate-editorial.mjs --dry-run
node scripts/content/check-block-order.mjs
node scripts/content/snapshot-page-text.mjs
```

富文本 / 安全回归（V2–P4）：

- 字号 11 / 33 / 小数 → 拒绝。
- 自定义 HEX / 原始 HTML / 外链图片 / 非法 mark → 拒绝。
- 12 个颜色 token 在亮暗主题下渲染正常，对比度达标。
- guide 小条目增删排序保存后顺序保持。
- 神器行上移 / 改说明 → 保存 → 重载后保持；新增行追加到末尾。
- 关卡行上移 → 表格顺序变化；重复 `no` 被拒。
- research 未覆盖时更新 research，页面跟着变；玩家覆盖后用 `researchRev` 提示。
- 审核台块级 diff 与样式摘要正确。
- 生成 HTML 无 XSS。

---

## 11. 回滚

 - V1–V3：视觉切片使用独立 fixture，不影响线上旧页面；验收不通过时丢弃切片即可。
 - P1：统一读取层保留旧生成器输出开关；关闭后恢复旧正文拼装。
 - P2：删除对应 `data/content/<slug>.json` 即回到 research 渲染；迁移脚本保留 dry-run 和迁移前 tag。
 - P4：未写回不产生内容变更；已写回用 `git revert` 单个 commit。
- 迁移前打 tag：`backup/pre-content-model-v2`。

---

## 12. 待确认

1. 12 个颜色 token 的最终名单（`red/orange/amber/green/teal/cyan/blue/indigo/purple/pink/gray/brown`）是否接受。
2. 攻略小条目上限 30、单个 `doc` ≤ 64KB 是否合适。
3. 审核台是否改为「每位审核员独立令牌」，还是暂时继续共用 `ADMIN_TOKEN` + 记录自填审核人。
4. 图片集顺序本期不做；如需要，另开「图片集排序」任务。

---

## 13. 视觉 Demo

- 详情页：`demo/backrooms-insomnia.html`
- 编辑页：`demo/backrooms-insomnia-edit.html`
- 审核页：`demo/backrooms-insomnia-admin.html`（V3 新增）
- Demo 是视觉原型：`contenteditable` 模拟富文本；正式 P3 用 TipTap / ProseMirror。
- 样本：`ze_backrooms_insomnia`。
- 编辑 Demo 覆盖：长文本编辑框、攻略技巧整块编辑（原型，最终为 `guideItem` 块）、结构化字段、神器行编辑、预览、本地草稿。
- 参数：`?theme=dark`、`?preview=1`、`?panel=cover|videos|tags`、`?focus=story|intro|gameplay|guide`、`?scroll=items`、`?demo=long`。
- 详情 / 编辑 Demo 的样本来源：`data/research/ze_backrooms_insomnia.json`、旧 `data/community/ze_backrooms_insomnia.json`、`data/gfl-parsed/ze_backrooms_insomnia.json`、`data/gallery/ze_backrooms_insomnia.json`、`src/content/maps/ze_backrooms_insomnia.mdx`；审核 Demo 使用脱敏的固定 pending / approved / applied fixture，不连接真实审核队列。
