import { z } from 'zod';
import { CRTopic } from './topic.js';

// CR 问题严重度
export const IssueSeverity = z.enum(['critical', 'high', 'medium', 'low']);
export type IssueSeverity = z.infer<typeof IssueSeverity>;

// CR 问题
export const Issue = z.object({
  id: z.string(), // 稳定指纹
  file: z.string(),
  line: z.number(),
  severity: IssueSeverity,
  topic: CRTopic,
  message: z.string(),
  suggestion: z.string(),
  confidence: z.number().min(0).max(1),
  createdAt: z.string().optional(),
  publishedAt: z.string().optional(),
});
export type Issue = z.infer<typeof Issue>;

// CR 结果
export const ReviewResult = z.object({
  summary: z.string(),
  identifiedTopics: z.array(z.string()),
  issues: z.array(Issue),
  testingSuggestions: z.string().optional(),
  metadata: z.object({
    mode: z.enum(['incremental', 'full']),
    agentsRun: z.array(z.string()),
    duration: z.number(),
    cacheHit: z.boolean(),
  }),
});
export type ReviewResult = z.infer<typeof ReviewResult>;

