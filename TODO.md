# 待办与已知问题

> 整理时间：2026-09-23 · 线上版本：`d764704`（含 `c91dd8f`「update 1」的全部内容 + 构建修复；20:27 推送后构建成功，已线上验证，见第 1、20 条）
> 口径：已完成的事项保留记录（方便回溯），未闭环的排在前面。
> 标注「待你操作」的，我这边无法代劳（需要控制台权限或你的决策）。

---

## 一、需要你决定或操作的

### 1. ~~自定义 404 页没有生效~~ ✅ 已修复（2026-09-23，顺带修掉线上构建失败）

- **现象**：访问不存在的路径返回 404 状态码，但**响应体是空的**，看不到站内做的 404 页面。
- **原因**：`dist/404.html` 已经构建并部署（直接访问 `/404.html` 是 200），但这是 **Workers 静态资源**项目，默认 `not_found_handling: none`，平台不会自动把 `404.html` 当兜底页。控制台 Settings 里**没有**这个开关（assets 配置由构建时的 wrangler 注入，仓库里没有配置文件时无法指定）。
- **已做的修法**：仓库根目录新增 `wrangler.jsonc`：

  ```jsonc
  {
    "name": "ze-map-site",
    "compatibility_date": "2026-09-23",
    "assets": {
      "directory": "./dist",
      "not_found_handling": "404-page",
      "html_handling": "auto-trailing-slash"
    }
  }
  ```

  这个文件**同时**关掉了 wrangler 的自动配置（autoconfig）——那正是 `c91dd8f` 构建失败的根因，详见第 20 条。两份收益一个文件。
- **风险（仍然成立）**：仓库里一旦有 wrangler 配置，`npx wrangler deploy` 就完全以它为准；`name` 写错会新建一个 Worker（自定义域名不会跟过去），`assets.directory` 写错会**整站没有静态资源**。所以文件里两处都加了警告注释。
- **验证**：
  - 本地 `npm run build` 退出码 0、808 页、`dist/404.html` 6,036 字节；
  - `npx wrangler deploy --dry-run` 退出码 0，日志 **没有**出现 autoconfig 的交互提示，直接 `Read 3695 files from the assets directory ...\dist`；
  - **上线后实测（2026-09-23，`d764704`）**：`/no-such-page-xyz/` 与 `/totally-bogus-98765` 均返回 **404 且 body 约 5,809 字符**的站内 404 页（含 `<html>`、导航链接、样式与文案）；修复前同样路径 body 为空。
  - 顺带确认 `public/_headers` 的 4 条规则全部生效：`/entity/data/*.bin` → `Content-Type: application/gzip` + `max-age=86400`；`/entity/catalog.json`、`/sitemap.xml` → `max-age=3600`。
- **状态**：✅ 已上线并验证通过（过程与一个易踩的坑见第 20 条「上线确认」）。

### 2. 分支预览没开启（影响上线流程）〔待你操作〕

- 控制台现状：**Builds for non-production branches 未勾选**、**Worker Previews 未设置**。
- 影响：推 `main` 直接上生产（现在就是这样），推其它分支不会构建、拿不到预览地址。
- 建议：开启 Worker Previews + 勾选非生产分支构建。之后流程可变为：推 `feature/*` → 预览地址验收 → 合并 `main` 上生产。
- 成本：控制台点两下。

### 3. ~~皇家港条目的工坊链接是占位地址~~ ✅ 已修复（2026-09-23）

- **原问题**：`src/content/maps/ze_pirates_port_royal.mdx` 里 `workshopUrl: https://steamcommunity.com/workshop/`（工坊首页，不是这张图），侧栏「Steam 创意工坊」按钮会跳到无关页面。
- **连带发现（更严重）**：`ze_ffvii_mako_reactor.mdx` 的工坊链接指向 `id=3278111368`，经 Steam Web API 查询 **result=9「查无此项」**——条目已不存在，点进去是死链。正文「来源」一节里也重复了同一个失效 ID。
- **已改为**：
  - 皇家港 → `id=3381572627`（`ze_Pirates_Port_Royal`，2024-12-09 发布，订阅 2677）
  - 魔晄炉 → `id=3273375829`（`ze_FFVII_Mako_Reactor_v6_p`，2024-06-23 发布，订阅 2628；与条目里的实体数据同版本）——frontmatter 与正文来源共两处
- **验证**：`npm run build` 通过（807 页）、`npm run content:links` 死链 0、全仓库已无 `3278111368` 引用、三个 ID 均经 Steam API 确认 `result=1`。
- **注意**：另外 21 张「工坊已下架」的条目仍会显示工坊按钮，但详情页侧栏有明确提示（属于预期行为，见第 5 条）。

---

## 二、内容缺口

### 4. 447 张条目仍是「资料待补充」

- 现状：547 张条目中 **100 张有攻略资料**（97 篇线上检索 + 3 篇手写），447 张只有工坊自述 + 实体统计 + 服务器配置。
- 继续扩的方法（已验证可靠，每轮 20 张、6 个代理分批最稳）：

  ```powershell
  node scripts/content/generate-map-entries.mjs --priority 24   # 生成待检索优先级表
  # 派发检索 → 产出 data/research/<地图名>.json
  npm run content:verify      # 质量闸门（来源链接、难度枚举、可疑措辞、标签字符）
  npm run maps:generate       # 合并进条目
  npm run build; npm run content:links
  ```

- 检索代理的可用线索（**已验证**）：`steamcommunity.com/profiles/<id>/?xml=1`（PowerShell 可抓）、`bbs.moeub.cn` / `bbs.zombieden.cn` 的 `forum.php?mod=viewthread&action=printable&tid=<id>`、`bbs.fyscs.cn`、`gamebanana.com/apiv11`、`api.bilibili.com/x/web-interface/view?bvid=`、`s2ze.net`、GFL 配置仓库。**不可用**：zombieescape.fandom.com、Google 系、nide.gg。
- 成本：每 20 张约 10–20 分钟（可后台并行）。

### 5. ~~21 张「工坊已下架」的图缺少专门提示~~ ✅ 已修复

- **改动**：`MapCard.astro` 增加 `workshopMissing` 判断 → 卡片信息区显示灰色「工坊已下架」标记（带删除线样式）；`global.css` 新增 `.map-flag.gone`（含亮色主题）。
- **验证**：构建后地图库页出现 21 处「工坊已下架」，与 `workshopMissing: true` 的条目数一致。

### 6. GFL 神器 / BOSS / 音乐只覆盖 253/548 张

- 现状：抓到 341 份 GFL 配置、匹配上 253 张图（神器 166 页 / BOSS 126 页 / 音乐 171 页）。
- 原因：GFL 没跑那些图，或图名差异更大。我**故意放弃**了宽松匹配（例如 `ze_doom` vs `ze_doomglaven`、`ze_obf_npst_v1` vs `v2`）——把别人的神器表安到这张图上属于事实错误，比缺数据更糟。
- 可选改法：人工确认一批别名，写进 `data/gfl-parsed/_aliases.json`（或改 `scripts/content/link-gfl-configs.mjs` 的匹配规则）。收益递减，优先级低。

### 7. ~~`ze_minecraft_universe` 的关卡数与服务器配置冲突~~ ✅ 已修复（并系统性复核）

- **查实**：该图实体里有 `stage1_exit`、`stage1end` 与 **31 个 `stage2_*` 实体**（含 `stage2_boss_*`），GFL 里对应 BOSS 是 `Command Cube`/`stage2_boss_HP_counter` → **确实至少 2 关**，而 dump 的 `st` 字段记成了 1。
- **修法**：生成器新增 `stageCountFromEntities()`——仅当实体名**明确**写了 `stageN / lvlN / levelN`、编号出现 ≥2 个、相关命名实体 ≥10 个、编号基本连续（覆盖率 ≥60%）、且结果 ≤12 时才修正，避免把楼层号/偶发命名当关卡号。
- **结果**：19 张图的关卡数被修正并打印明细，例如
  `ze_minecraft_universe 1→2`、`ze_surf_hp 1→7`（与检索资料里"7 个滑翔关"一致）、`ze_shroomforest_p 7→8`、`ze_urbanstone 0→5`、`ze_pokemon_kanto_v1 4→7`。
  两条可疑数据被规则挡下：`ze_bisounours_party [1,2,3,12]`、`ze_system_cs2_l [1,10]`（编号不连续）。
- **验证**：`dist/maps/ze_minecraft_universe/` 的侧栏与 hero 均显示 2 关；`ze_surf_hp` 显示 7 关。

### 8. ~~部分条目的「作者」字段是整句说明~~ ✅ 已修复

- **改动**：schema 新增 `authorNote`；生成器把含「；」的作者署名在第一个分号处拆开——`author` 只留第一段，完整署名著入 `authorNote`；详情页侧栏在信息表下方以「署名详情：…」显示。
- **结果**：34 个条目带上 `authorNote`（`ze_dark_souls` 侧栏的作者从三行说明变成一句，完整说明移到下方小字）。
- **验证**：`dist/maps/ze_dark_souls/` 侧栏作者为「原作 cs:s 版 ze_Dark_Soul 由 Headshooter.SC、HaRyDe、Batnik_Ref 制作」，下方显示完整署名。

### 9. 非 ZE 的 97 张图只在预览工具里，站点没有入口

- 现状：实体数据包含 TTT 43 / MG 39 / DE 15 张，`/preview/` 的左侧可以切换模式看到它们，但站点（地图库、标签、sitemap）只收录 ZE 548 张。
- 决策点：要不要给这些模式也开条目？（需要先确认站点定位是否只做 ZE。）

---

## 三、体验与技术债

### 10. ~~`/preview/` 窄屏下实体搜索框溢出约 20px~~ ✅ 已修复

- **改动**：`preview.css` 的窄屏媒体查询里给 `.esearch` 补 `width: auto`（此前 `left/right` 与基础规则的 `width: min(360px,62%)` 冲突），并把搜索框移到底部、宽度撑满。
- **验证**：390px 视口下 `/preview/` 的 `scrollWidth == clientWidth`。

### 11. ~~站点没有全文搜索~~ ✅ 已接入 Pagefind

- **改动**：
  - 依赖 `pagefind@1.5.2`（devDependency）；
  - `npm run build` = `astro build && node scripts/content/build-search.mjs`（包装脚本会重试一次，仍失败**不阻塞部署**，站点照常发布）；
  - 新增 `/search/` 页面（中文界面文案、暗色主题适配、支持 `?q=` 直接出结果），导航栏加入「搜索」；
  - 站点页头/页脚标记 `data-pagefind-ignore`，避免结果摘要混入导航。
- **验证**：构建日志 `[search] 索引已生成：dist/pagefind（3.12 MB）`；无头浏览器实测 `/search/?q=黑暗之魂` 返回 11 条结果，首条为「黑暗之魂:亚诺尔隆德」。
- **已知限制**：Pagefind 对 `zh-cn` 不支持词干还原（官方提示，搜索仍可用，但不会跨词根匹配）；开发模式（`npm run dev`）没有索引，`/search/` 会显示"索引尚未生成"的兜底提示，属预期。
- **SEO 小尾巴（未处理，等你决定）**：`/search/` 既**不在 `sitemap.xml` 里**、页面也**没有 `noindex`**。搜索页本身是薄内容页，常规做法是二选一：要么加进 sitemap（把它当正常功能页收录），要么在 `search.astro` 的 `BaseLayout` 传一个 `noindex`（推荐，避免薄页被收录）。现状两者都没做，所以它仍可能被导航链接带进索引。另：`route.png` 的 404 是**站外旧链接**（仓库里早已改名 `overview.png`，三个路线图实测 200），无需处理。

### 12. ~~`/tags/` 索引页偏长~~ ✅ 已修复

- **改动**：`tags/index.astro` 重写——253 个标签分三档展示（常见 ≥5 张共 30 个 / 一般 2–4 张共 52 个 / 长尾仅 1 张共 171 个，长尾默认折叠），加搜索框（搜索时自动展开长尾），常见标签额外显示 3 个代表地图名。
- **验证**：页面显示「共 253 个标签 · 30 个常见标签 · 52 个一般标签 · 171 个仅 1 张地图」，长尾默认 `display:none`。

### 13. ~~移动端只在无头浏览器验证过~~ ✅ 已实测并修复观感问题

- **观测方法**：写了一个 iframe 观测台（真实 390px 视口 + 844/2500 高度），逐页截图看真实移动端渲染——比之前只查"有没有横向溢出"有效得多。
- **发现并修复的真问题**：
  1. **`/preview/` 在手机上基本不可用**：侧栏吃掉一半宽度、顶部徽章挤成一列盖住标题、图层面板盖住画布 →
     侧栏改为**抽屉**（窄屏默认收起，点「☰ 地图」打开，选图后自动关闭并触发 resize）、徽章改为横向滚动单行、隐藏副标题、图层面板改为底部面板且**默认收起**、实体搜索框移到底部。
  2. **地图库筛选栏占三行、卡片过高**：筛选栏改两列紧凑布局；卡片封面在窄屏改为 2:1（更矮）；`players`/`duration` 这类自由文本用两行截断，不再把卡片撑高；卡片字号上调。
  3. **首屏 hero 太高**：窄屏压缩 hero 内边距、徽章与标题字号，隐藏"向下滚动"提示。
  4. **长链接溢出被裁**：详情页来源里的长 URL 在窄屏超宽，已加 `overflow-wrap: anywhere`。
- **验证**：390px 下 11 个页面 `scrollWidth == clientWidth`（零横向溢出）；观感截图对比前后。
- **仍未验证**：真机（iOS Safari / Android Chrome）与触控手势（viewer 的旋转/平移/缩放只测过鼠标路径）。

### 14. ~~两处「实体数」口径不同~~ ✅ 已说明

- **改动**：预览页徽章改为「645 张地图（全部模式）」；`/about` 增加一条说明——站点收录 547 张 ZE 条目（实体数合计 571,134），实体预览工具另含 TTT/MG/DE 97 张共 645 张、62.9 万实体，"两处口径不同"。
- **验证**：`dist/about/` 出现「两者口径不同」，`public/preview/app.js` 徽章文案已更新。

---

## 四、运维备忘（不是待办，但容易踩）

### 15. wrangler 配置的坑（见第 1 条）

仓库里一旦有 `wrangler.jsonc`，部署完全以它为准；`assets.directory` 必须指向 `./dist`，否则整站 404。改动后必须立刻验证。

### 16. 常规操作清单

```powershell
npm run dev                                  # 本地开发（注意：开发模式没有搜索索引）
npm run build                                # 构建 + 生成搜索索引（约 40s，808 页）
npm run content:links                        # 构建后查站内死链（必须 0）
npm run content:verify                       # 校验 data/research 资料
node scripts/entity-data/verify-entity-data.mjs --all   # 校验实体分片
npm run maps:generate                        # 重新生成条目（含标签大小写归一、关卡数复核）
npm run search:index                         # 只重建搜索索引
```

> ⚠️ 本地构建时如果 `npm run preview` 正在运行，偶尔会因 dist 被占用报错（Windows 文件锁）。
> 先停掉预览服务再构建即可，CI 上不存在这个问题。

### 17. 仓库体积构成（约 17 MB 新增）

| 路径 | 体积 | 可否重建 |
|---|---|---|
| `public/entity/data`（645 个分片） | 10.9 MB | ✅ `npm run data:entity`（需原始 10 MB 单文件，已 gitignore） |
| `public/images/covers`（548 张 WebP） | 3.5 MB | ✅ `npm run data:covers` |
| `src/content/maps`（547 个 MDX） | 2.1 MB | ✅ `npm run maps:generate` |
| `data/gfl`（627 个配置） | 1.1 MB | ✅ `scripts/content/fetch-gfl-configs.ps1` |
| `data/research`（97 篇资料） | 0.3 MB | ❌ 人工检索成果，**不要删** |
| `data/workshop`（548 个工坊数据） | 0.3 MB | ✅ `scripts/content/fetch-workshop.ps1` |

如需瘦身：`data/gfl` 与 `public/entity/data` 都可以不入库（改成构建时下载/生成），但目前入库换来的是「换台机器能离线重跑」。

### 18. 实体预览入口的可发现性（2026-09-23 追加完成）

- **问题**：地图卡片上的「实体预览」原先是灰色小标签，和旁边的「订阅 / 实体数」一样是纯文字，看不出能点；详情页侧栏的入口也偏"文字块"，只有 hover 才变色。
- **改动**：
  - 地图卡片：把卡片从「整张是 `<a>`」改成「`div` + 整卡透明点击层（`.map-card-hit`）+ 独立的预览按钮」——
    预览按钮做成**实心红橙渐变胶囊**（`🧊 实体预览 ↗`，带阴影与 hover 抬升），层级在点击层之上；
  - 详情页侧栏：`.entity-cta` 改为**实心渐变按钮卡**（白字 + 深色「打开实体预览 ↗」按钮 + 阴影）；
  - 新增/统一 `target="_blank" rel="noopener"`：卡片按钮、详情页入口、首页推广位、404 页入口都在**新标签页**打开预览（站内普通导航仍在本页跳转）。
- **验证**：
  - 构建后地图库 547 个 `preview-btn` 且 547 个带 `target="_blank"`，547 个整卡点击层；
  - 用 `elementFromPoint` 实测点击命中：按钮中心 → `.preview-btn`（开预览）、封面/标题中心 → `.map-card-hit`（进详情）；
  - `npm run content:links`：808 页 / 17,075 处引用，死链 0。
- **影响文件**：`src/components/MapCard.astro`、`src/pages/maps/[...slug].astro`、`src/pages/index.astro`、`src/pages/404.astro`、`src/styles/global.css`。

### 19. 一次踩过的坑（留作教训）

- **标签大小写**：`Boss` / `boss` / `BOSS` 在 Windows 上是同一个目录，本地看不出问题，Cloudflare 是大小写敏感文件系统 → 线上 404。已在生成器里做归一（手写写法优先），并加了 `content:links` 死链检查兜底。
- **MDX 里的 `<` 和 `{`**：工坊正文含这些字符会被当 JSX 解析导致构建失败，生成器已统一转义。
- **PowerShell 5.1 读 UTF-8**：`.ps1` 无 BOM 会把中文读成乱码；`data/workshop/*.json` 曾被写出 BOM 导致 Node `JSON.parse` 抛错。相关脚本已处理（脚本保持 ASCII、JSON 不带 BOM 写）。

### 20. 一次线上构建失败：wrangler 自动配置 + 构建期读文件依赖 cwd（2026-09-23 修复）

- **现象**：`c91dd8f`（update 1）的 Build #e80f3333 红叉，日志报
  `Error: no such file or directory, readAll '/bundle/public/entity/catalog.json'`。
  线上仍是 `9103f1d` —— 所以那次推送的**搜索页、重新生成的地图条目、按钮改动都没上线**（实测 `https://ze-map.cn/search/` 返回 404 可印证）。
- **根因链**（两件事叠在一起才炸）：
  1. 仓库里没有 wrangler 配置文件 → `npx wrangler deploy` 触发 **autoconfig**：非交互环境下「Proceed with setup?」的回退值是 **yes**，于是它自动装了 `@astrojs/cloudflare`、改了 `astro.config.mjs`、**又重跑了一遍 `npm run build`**（日志里的 `🛠️ Configuring project for Astro with "astro add cloudflare"` 就是它）；
  2. 这次重跑是在 Cloudflare 适配器下预渲染的，**工作目录变成 `/bundle`**；而 `about.astro` 当时是 `fs.promises.readFile('public/entity/catalog.json')` —— 相对路径按 cwd 解析，于是读不到文件，构建中断。
  - 为什么 `9103f1d` 能上线：它的 `about.astro` **没有**这行读文件的代码，是 `c91dd8f` 才加进去的（`git show c91dd8f -- src/pages/about.astro` 可见）。所以这是一个「新代码 + 部署环境的隐藏行为」共同触发的问题。
- **修法**（两层，缺一不可）：
  1. `about.astro` 改为构建期 `import catalog from '../../public/entity/catalog.json'`：由打包器按**模块图**解析，与运行时 cwd 无关，任何打包/适配器环境都成立。数字仍是预览工具的同一份 `catalog.json`，没有第二份真相。
  2. 新增 `wrangler.jsonc`：按官方文档，**只要存在 wrangler 配置文件，autoconfig 就不会运行**（[automatic-configuration](https://developers.cloudflare.com/workers/framework-guides/automatic-configuration/)：「If a Wrangler configuration file already exists, automatic configuration will not run」）。
- **验证**：
  - `npm run build` 退出码 **0**、808 页、搜索索引 3.14 MB、`dist/about/` 仍显示 547 / 645 / 98；
  - `npx wrangler deploy --dry-run` 退出码 **0**，日志直接 `Read 3695 files from the assets directory ...\dist`，**不再出现** autoconfig 交互提示；
  - 全仓库复查：`src/` 里已无任何构建期文件读取（只剩这一处，且已改成 import）。
- **教训**：**构建期不要用相对路径读文件**。要读就 `import`（打包器解析）或显式用 `process.cwd()`／绝对路径。这类代码在本地和 CI 的默认路径下都正常，只在打包环境变了（适配器、预渲染、cwd 不同）时才炸，而且报错信息（`/bundle/...`）和你的代码看起来毫无关系。
- **上线确认（2026-09-23 晚，`d764704`）**：修复推送后构建成功并部署，实测三项通过 —— ① 未知路径返回 404 且**带站内 404 页**（这条只有 `wrangler.jsonc` 生效才可能，是 autoconfig 已被关掉的硬证据）；② `/search/` 由 404 变 200（`c91dd8f` 的内容一并上线）；③ 线上 `_headers` 规则、`sitemap.xml`（806 条）、改好的工坊 ID 均已生效。
  ⚠️ **别被红叉误导**：期间控制台又出现过一次失败的 Build（如 #fcef6da7，条目仍标 `c91dd8f`）—— 那是点了「**Retry build**」的结果，它**固定重跑那次失败构建的旧提交**，必然以同样的 `readAll '/bundle/public/entity/catalog.json'` 失败，与本次修复无关。**看构建结果请认提交号，不要只看红叉**；要重跑就用 `New deployment` 选最新提交，或再推一次 `main`。

### 21. 一次前端交互全部失效：`is:inline` 脚本里写了 TypeScript（2026-09-23 修复）

- **现象**（你报的）：右上角「🌙 / ☀️」主题按钮点了没反应；手机端顶部「三条横杠」菜单同样点了没反应。两个控件**同时**失效——这个「同时」就是关键线索。
- **根因**：`src/layouts/BaseLayout.astro` 的交互脚本原本写成 `<script is:inline>`，而 `is:inline` 的语义是「原样输出，**什么都不要动**」——其中就包括**不做 TypeScript 转译**。可脚本里有一个 TS 类型断言：
  `const target = e.target as HTMLElement;`
  浏览器拿到的是纯 JS，`as HTMLElement` 是语法错误；而**一个 `<script>` 只要解析失败，整段都不会执行**，于是写在它前面的主题监听、菜单监听跟着一起失效。
- **为什么一直没被发现**：Astro 默认的 `<script>`（不加 `is:inline`）会经 Vite 打包并剥掉类型，写 TS 完全正常；只有 `is:inline` 才原样输出。而且这类错误**只在浏览器里才报**，构建期不报错，也不影响其它页面。
- **线上证据**：线上首页那段脚本共 1,126 字符，`as HTMLElement` 出现在第 889 字符处；同一段脚本里 `theme-toggle` / `menu-toggle` 的监听代码都还在，只是整段没跑。
- **排查经验**：凡是「同一块里的多个交互一起失效」，先怀疑**脚本没被解析/执行**，而不是逐个控件去查 z-index、事件绑定或 CSS。
- **修法**（两层）：
  1. 去掉 TS 断言，改成纯 JS 且能正确收窄：`const target = e.target instanceof Node ? e.target : null;`
  2. 把这块 `<script is:inline>` 改回**普通 `<script>`**（交给 Astro 处理）——类型会被剥掉，将来再写错语法**构建期就会报错**，从根上堵住同类问题。
  3. head 里那段「预置主题」脚本**继续保留 `is:inline`**（它必须在首屏绘制前同步执行，否则会闪白），所以它只写纯 JS。
- **验证**：
  - `npm run build` 退出码 0；构建产物中含 `as HTMLElement` 的 HTML 由 **807 个降到 0 个**；
  - 用最小 DOM 桩（含事件冒泡模拟）直接跑构建产物：主题按钮点击后 `dataset.theme` 在 dark/light 间正确翻转并写入 `localStorage`；菜单点击可展开/收起、点导航链接自动收起、点页面其他区域收起、点主题按钮也收起 —— **12 项断言全过**。
- **教训**：`is:inline` 的意思是「这段代码我说了算，你别碰」，所以它**不转译 TS、不压缩、不做语法检查**。要在里面写脚本，就只写最朴素的 JS；否则请去掉 `is:inline`，让 Astro 管。
- **复查结论**：全仓库其余 `is:inline` 脚本（`BaseLayout` 的主题预置、`search.astro` 的 Pagefind 启动）都是纯 JS，无同类隐患。另外 5 个文件里的 `as HTMLElement`（`index.astro`、`maps/index.astro`、`tags/index.astro`、`tags/[tag].astro`）都在**普通** `<script>` 里，会被正常转译，不受影响。
