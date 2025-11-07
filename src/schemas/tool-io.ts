import { z } from 'zod';

// MCP 工具输入输出 schemas

// detect-project-test-stack
export const DetectStackInput = z.object({
  repoRoot: z.string().optional(),
});
export type DetectStackInput = z.infer<typeof DetectStackInput>;

export const DetectStackOutput = z.object({
  unit: z.enum(['vitest', 'jest']).nullable(),
});
export type DetectStackOutput = z.infer<typeof DetectStackOutput>;

// review-frontend-diff
export const ReviewDiffInput = z.object({
  revisionId: z.string(),
  topics: z.array(z.string()).optional(), // 手动指定主题（可选）
  mode: z.enum(['incremental', 'full']).optional().default('incremental'),
  confidenceMin: z.number().optional(),
  publish: z.boolean().optional().default(false),
  forceRefresh: z.boolean().optional().default(false),
});
export type ReviewDiffInput = z.infer<typeof ReviewDiffInput>;

// generate-tests
export const GenerateTestsInput = z.object({
  revisionId: z.string(),
  projectRoot: z.string().optional(),
  scenarios: z.array(z.string()).optional(),
  mode: z.enum(['incremental', 'full']).optional().default('incremental'),
  maxTests: z.number().optional(),
  forceRefresh: z.boolean().optional().default(false),
});
export type GenerateTestsInput = z.infer<typeof GenerateTestsInput>;

// publish-phabricator-comments
export const PublishCommentsInput = z.object({
  revisionId: z.string(),
  comments: z.array(z.object({
    file: z.string(),
    line: z.number(),
    message: z.string(),
    issueId: z.string(),
  })),
  message: z.string().optional(),
  incremental: z.boolean().optional().default(true),
});
export type PublishCommentsInput = z.infer<typeof PublishCommentsInput>;

export const PublishCommentsOutput = z.object({
  published: z.number(),
  skipped: z.number(),
  failed: z.number(),
  details: z.array(z.object({
    issueId: z.string(),
    status: z.enum(['published', 'skipped', 'failed']),
    error: z.string().optional(),
    reason: z.string().optional(), // 跳过原因（如 "Duplicate (exact match)" 或 "Duplicate (95.2% similar)"）
  })),
});
export type PublishCommentsOutput = z.infer<typeof PublishCommentsOutput>;

// cache-control
export const CacheControlInput = z.object({
  action: z.enum(['get', 'set', 'invalidate']),
  key: z.string().optional(),
  pattern: z.string().optional(),
});
export type CacheControlInput = z.infer<typeof CacheControlInput>;

