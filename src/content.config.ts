import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const maps = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/maps' }),
  schema: z.object({
    title: z.string(),
    titleEn: z.string(),
    game: z.enum(['CS:S', 'CS:GO', 'CS2']),
    author: z.string(),
    version: z.string().optional(),
    difficulty: z.enum(['简单', '中等', '困难', '极难', '地狱']),
    players: z.string(),
    duration: z.string(),
    stages: z.number(),
    tags: z.array(z.string()),
    cover: z.string().optional(),
    workshopUrl: z.string().url().optional(),
    downloadUrl: z.string().url().optional(),
    videoUrls: z.array(z.string()).optional(),
    releaseDate: z.coerce.string().optional(),
    lastUpdated: z.coerce.string().optional(),
    featured: z.boolean().default(false),
  }),
});

export const collections = { maps };