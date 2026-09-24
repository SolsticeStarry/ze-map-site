# data/community/

社区投稿的落盘目录。**一张地图一个文件**，文件名就是地图 slug
（与 `src/content/maps/<slug>.mdx` 同名，也与网址 `/maps/<slug>/` 一致）。

## 谁写这个目录

**不是手写的** —— 是审核台在通过一条投稿后，由 Worker 调 GitHub API 写进来的：

```
投稿表单 /submit/  →  D1 待审队列  →  /admin 审核通过  →  写入这里  →  触发 Cloudflare 重建
```

所以这里每个文件，`git log` 都能看到「谁提的、谁审的、改了什么、依据什么」。

## 文件格式

```jsonc
{
  "v": 1,
  "slug": "ze_flowering",
  "updatedAt": "2026-09-24T07:00:00.000Z",
  "fields": {
    // 只出现「被社区覆盖过」的字段
    "difficulty": { "v": "普通", "by": "某玩家", "at": "…", "submission": 12 }
  },
  "notes": [
    { "text": "补充说明正文……", "by": "某玩家", "at": "…", "submission": 13 }
  ],
  "log": [ /* 每次变更一行，便于追溯 */ ]
}
```

可覆盖字段：`difficulty` `tags` `author` `authorNote` `version` `players`
`duration` `stages` `sources` `videoUrls`（定义在 `shared/submission-fields.mjs`）。

## 渲染优先级

**社区（本目录） > 人工资料 `data/research/` > 自动生成 `src/content/maps/`**

合并逻辑在 `src/lib/maps.ts` 的 `mergeEntry()`；页面请通过 `getMaps()` 取数据。

## ⚠️ 三个容易踩的点

1. **读取一律走 `src/lib/maps.ts`，不要直接 `getCollection('maps')`。**
   那样拿到的是没合并社区覆盖的原始数据，会出现「详情页显示困难、地图库里还是
   中等」这种自相矛盾。（曾经试过在 content loader 里 `store.set()` 回写合并结果，
   Astro 不认，详见 `src/lib/maps.ts` 顶部注释。）
2. **本目录靠 `.gitignore` 里的一条白名单才入得了库**（`data/*` 会连它一起忽略，
   `!data/community/` 才放行）。那行删了，文件就进不了仓库，构建期也读不到。
3. **想撤销某次社区改动**：删掉对应文件，或者 `git revert` 那次提交。
   两种方式都会在下次构建时生效。
