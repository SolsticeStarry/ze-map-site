import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const maps = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/maps' }),
  schema: z.object({
    title: z.string(),
    titleEn: z.string(),
    game: z.enum(['CS:S', 'CS:GO', 'CS2']),
    /* 下面四项对「数据条目」可能暂时没有资料，允许留空 */
    author: z.string().optional(),
    version: z.string().optional(),
    difficulty: z.enum(['简单', '中等', '困难', '极难', '地狱', '未知']).default('未知'),
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
