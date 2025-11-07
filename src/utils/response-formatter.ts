/**
 * MCP 响应格式化工具
 * 统一 MCP tool 的响应格式
 */

import type { Diff } from '../schemas/diff.js';

/**
 * 格式化 JSON 响应
 */
export function formatJsonResponse(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

/**
 * 格式化错误响应
 */
export function formatErrorResponse(error: unknown) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            error: errorMessage,
            stack: errorStack,
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

/**
 * 格式化 Diff 响应（用于 fetch-diff 和 fetch-commit-changes）
 */
export function formatDiffResponse(diff: Diff, metadata?: {
  commit?: {
    hash: string;
    author: string;
    date: string;
    message: string;
  };
}) {
  const baseResponse = {
    ...(metadata?.commit ? { commit: metadata.commit } : {}),
    revisionId: diff.revisionId,
    diffId: diff.diffId,
    title: diff.title,
    summary: diff.summary,
    files: diff.files.map(f => ({
      path: f.path,
      changeType: f.changeType,
      additions: f.additions,
      deletions: f.deletions,
      hunks: f.hunks.map(h => ({
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        content: h.lines.join('\n'),
      })),
    })),
    fullDiff: diff.numberedRaw || diff.raw,
  };

  return formatJsonResponse(baseResponse);
}
