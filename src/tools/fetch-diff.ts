/**
 * FetchDiffTool - 基于 BaseTool 的重构版本
 */

import { z } from 'zod';
import { BaseTool, ToolMetadata } from '../core/base-tool.js';
import { PhabricatorClient } from '../clients/phabricator.js';
import { Cache } from '../cache/cache.js';
import { parseDiff, generateNumberedDiff } from '../utils/diff-parser.js';
import { computeContentHash } from '../utils/fingerprint.js';
import type { Diff } from '../schemas/diff.js';
import { isFrontendFile } from '../schemas/diff.js';
import { logger } from '../utils/logger.js';

// Zod schema for FetchDiffInput
export const FetchDiffInputSchema = z.object({
  revisionId: z.string().describe('REQUIRED. Phabricator Revision ID (e.g., "D538642" or "538642"). Extract from user message patterns like: "fetch D12345", "获取 diff D538642", "看下 12345". If user provides only numbers, add "D" prefix.'),
  forceRefresh: z.boolean().optional().describe('强制刷新缓存'),
});

export interface FetchDiffInput {
  revisionId: string;
  forceRefresh?: boolean;
}

export interface FetchDiffOutput {
  diff: Diff;
  source: 'cache' | 'phabricator';
}

export class FetchDiffTool extends BaseTool<FetchDiffInput, FetchDiffOutput> {
  constructor(
    private phabClient: PhabricatorClient,
    private cache: Cache
  ) {
    super();
  }

  // Expose Zod schema for FastMCP
  getZodSchema() {
    return FetchDiffInputSchema;
  }

  getMetadata(): ToolMetadata {
    return {
      name: 'fetch-diff',
      description:
        '从 Phabricator 获取完整的 diff 内容（包括所有变更细节）。\n\n' +
        '💡 使用场景：\n' +
        '1. 在调用其他工具前，先查看 diff 的完整信息\n' +
        '2. 了解变更的具体内容、文件路径和统计信息\n' +
        '3. 获取 diff 对象后，可传递给其他工具（review-frontend-diff、analyze-test-matrix、generate-tests）避免重复请求\n\n' +
        '📤 输出信息（完整且详细）：\n' +
        '• Revision 标题和描述\n' +
        '• 文件路径列表\n' +
        '• 变更类型（新增/修改/删除）\n' +
        '• 增删行数统计\n' +
        '• 每个文件的 hunks（包含具体的变更行内容）\n' +
        '• 完整的 diff 文本（带行号，标准 unified diff 格式，使用 NEW_LINE_xxx 标记新行）\n' +
        '• diff 对象可作为参数传递给其他工具，避免重复获取',
      inputSchema: {
        type: 'object',
        properties: {
          revisionId: {
            type: 'string',
            description: 'REQUIRED. Phabricator Revision ID (e.g., "D538642" or "538642"). Extract from user message patterns like: "fetch D12345", "获取 diff D538642", "看下 12345". If user provides only numbers, add "D" prefix.',
          },
          forceRefresh: {
            type: 'boolean',
            description: '强制刷新缓存',
          },
        },
        required: ['revisionId'],
      },
      category: 'code-retrieval',
      version: '3.0.0',
    };
  }

  protected async executeImpl(input: FetchDiffInput): Promise<FetchDiffOutput> {
    const { revisionId, forceRefresh = false } = input;
    const cacheKey = `diff:${revisionId}`;

    // 尝试从缓存获取
    if (!forceRefresh) {
      const cached = await this.cache.get<Diff>(cacheKey);
      if (cached) {
        logger.info(`Cache hit for diff ${revisionId}`);
        return { diff: cached, source: 'cache' };
      }
    }

    // 从 Phabricator 获取
    logger.info(`Fetching diff for revision ${revisionId}...`);
    const { diffId, raw } = await this.phabClient.getRawDiff(revisionId);
    const revisionInfo = await this.phabClient.getRevisionInfo(revisionId);

    // 解析 diff
    const diff = parseDiff(raw, revisionId, {
      diffId,
      title: revisionInfo.title,
      summary: revisionInfo.summary,
      author: revisionInfo.authorPHID,
    });

    // 生成带行号的 diff
    diff.numberedRaw = generateNumberedDiff(diff);

    // 缓存结果
    await this.cache.set(cacheKey, diff);

    logger.info(`Fetched diff with ${diff.files.length} files`);
    return { diff, source: 'phabricator' };
  }

  async fetch(input: FetchDiffInput): Promise<Diff> {
    const result = await this.execute(input);
    if (!result.success || !result.data) {
      throw new Error(result.error || 'Failed to fetch diff');
    }
    return result.data.diff;
  }

  /**
   * 过滤前端文件
   */
  filterFrontendFiles(diff: Diff): Diff {
    return {
      ...diff,
      files: diff.files.filter(file => isFrontendFile(file.path)),
    };
  }

  /**
   * 计算 diff 指纹
   */
  computeDiffFingerprint(diff: Diff): string {
    const content = diff.files.map(f => `${f.path}:${f.additions}:${f.deletions}`).join('|');
    return computeContentHash(content);
  }
}
