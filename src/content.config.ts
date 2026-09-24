import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { DIFFICULTIES, DIFFICULTY_DEFAULT } from '../shared/difficulty.mjs';

const maps = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/maps' }),
  schema: z.object({
    title: z.string(),
    titleEn: z.string(),
    game: z.enum(['CS:S', 'CS:GO', 'CS2']),
    /* 下面四项对「数据条目」可能暂时没有资料，允许留空 */
    author: z.string().optional(),
    /** 作者署名的补充说明（多作者 / 原作与移植的区分），侧栏只显示简短 author */
    authorNote: z.string().optional(),
    version: z.string().optional(),
    /* 难度枚举取自 shared/difficulty.mjs —— 与投票 Worker 共用一份定义。
       类型断言只是因为 z.enum 需要「非空元组」字面量类型，运行时校验完全按 DIFFICULTIES 走。
       2026-09-24 的线上构建失败就是有人写了枚举外的「普通」，这份共享定义就是为了不再重演。 */
    difficulty: z.enum(DIFFICULTIES as [string, ...string[]]).default(DIFFICULTY_DEFAULT),
    players: z.string().optional(),
    duration: z.string().optional(),
    stages: z.number(),
    tags: z.array(z.string()),
    cover: z.string().optional(),
    workshopUrl: z.string().url().optional(),
    downloadUrl: z.string().url().optional(),
    videoUrls: z.array(z.string()).optional(),
    releaseDate: z.coerce.string().optional(),
    lastUpdated: z.coerce.string().optional(),
    featured: z.boolean().default(false),

    /* ===== 实体预览（数据来自 CS2 服务端实体 dump） ===== */
    /** 实体数据分片 slug，对应 /entity/data/<entitySlug>.bin */
    entitySlug: z.string().optional(),
    /** 原始索引键：<模式>/<地图名>/<工坊ID> */
    entityKey: z.string().optional(),
    /** 工坊文件 ID */
    workshopId: z.string().optional(),
    /** 工坊订阅数（热度） */
    workshopSubs: z.number().optional(),
    /** 工坊浏览量 */
    workshopViews: z.number().optional(),
    /** 工坊条目是否已下架 / 不可见 */
    workshopMissing: z.boolean().default(false),
    /** 工坊上传者昵称（不一定是原作者，常见于 CS2 移植版） */
    uploader: z.string().optional(),
    /** 实体总数（dump 统计） */
    entityCount: z.number().optional(),
    /** 是否只有数据、正文待社区补充 */
    stub: z.boolean().default(false),
    /** 资料出处链接 */
    sources: z.array(z.string()).optional(),
  }),
});

export const collections = { maps };
