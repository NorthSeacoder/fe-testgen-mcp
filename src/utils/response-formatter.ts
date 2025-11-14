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
  let errorMessage: string;
  let errorStack: string | undefined;
  let errorDetails: Record<string, unknown> = {};

  if (error instanceof Error) {
    // 标准 Error 对象
    errorMessage = error.message;
    errorStack = error.stack;
  } else if (typeof error === 'object' && error !== null) {
    // 复杂错误对象（如 {tool, error, metadata}）
    const errorObj = error as Record<string, unknown>;
    
    // 提取错误消息
    if (typeof errorObj.error === 'string') {
      errorMessage = errorObj.error;
    } else if (errorObj.error instanceof Error) {
      errorMessage = errorObj.error.message;
      errorStack = errorObj.error.stack;
    } else {
      errorMessage = JSON.stringify(errorObj.error);
    }
    
    // 保留其他字段
    Object.keys(errorObj).forEach(key => {
      if (key !== 'error') {
        errorDetails[key] = errorObj[key];
      }
    });
  } else {
    // 其他类型（字符串、数字等）
    errorMessage = String(error);
  }

  const response: Record<string, unknown> = {
    error: errorMessage,
  };

  if (errorStack) {
    response.stack = errorStack;
  }

  // 合并其他详细信息
  Object.assign(response, errorDetails);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(response, null, 2),
      },
    ],
    isError: true,
  };
}

/**
 * 格式化 Diff 响应（用于 diff 获取类工具）
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
