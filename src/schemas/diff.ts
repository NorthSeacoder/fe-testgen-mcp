import { z } from 'zod';

// Diff 文件变更类型
export const DiffChangeType = z.enum(['added', 'modified', 'deleted', 'renamed']);
export type DiffChangeType = z.infer<typeof DiffChangeType>;

// Diff 文件信息
export const DiffFile = z.object({
  path: z.string(),
  changeType: DiffChangeType,
  additions: z.number().default(0),
  deletions: z.number().default(0),
  hunks: z.array(z.object({
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(z.string()),
  })).default([]),
});
export type DiffFile = z.infer<typeof DiffFile>;

// Diff 数据结构
export const Diff = z.object({
  revisionId: z.string(),
  diffId: z.string().optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  author: z.string().optional(),
  files: z.array(DiffFile),
  raw: z.string(), // 原始 diff 文本
  numberedRaw: z.string().optional(), // 带行号的 diff 文本
});
export type Diff = z.infer<typeof Diff>;

// 前端文件过滤器
export const FRONTEND_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx',
  '.vue', '.svelte',
  '.css', '.scss', '.less',
  '.json', '.yml', '.yaml',
  '.mdx',
];

export function isFrontendFile(path: string): boolean {
  return FRONTEND_EXTENSIONS.some(ext => path.endsWith(ext));
}

