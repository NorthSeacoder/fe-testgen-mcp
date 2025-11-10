/**
 * FetchDiffTool - 基于 BaseTool 的重构版本
 */

import { BaseTool, ToolMetadata } from '../core/base-tool.js';
import { PhabricatorClient } from '../clients/phabricator.js';
import { Cache } from '../cache/cache.js';
import { parseDiff, generateNumberedDiff } from '../utils/diff-parser.js';
import { computeContentHash } from '../utils/fingerprint.js';
import type { Diff } from '../schemas/diff.js';
import { isFrontendFile } from '../schemas/diff.js';
import { logger } from '../utils/logger.js';
import { extractRevisionId } from '../utils/revision.js';

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

  getMetadata(): ToolMetadata {
    return {
      name: 'fetch-diff',
      description:
        '从 Phabricator 获取完整的 diff 内容（包括所有变更细节）。\n\n' +
        '💡 使用场景：\n' +
        '1. 在调用其他工具前，先查看 diff 的完整信息\n' +
        '2. 了解变更的具体内容、文件路径和统计信息\n' +
        '3. 仅需查看 diff 内容，不执行其他操作\n\n' +
        '📤 输出信息（完整且详细）：\n' +
        '• Revision 标题和描述\n' +
        '• 文件路径列表\n' +
        '• 变更类型（新增/修改/删除）\n' +
        '• 增删行数统计\n' +
        '• 每个文件的 hunks（包含具体的变更行内容）\n' +
        '• 完整的 diff 文本（带行号，标准 unified diff 格式，使用 NEW_LINE_xxx 标记新行）',
      inputSchema: {
        type: 'object',
        properties: {
          revisionId: {
            type: 'string',
            description: 'Phabricator Revision ID，必须以 D 开头后跟数字（如 D551414 或 D12345）。如果用户只提供数字（如 12345），请自动添加 D 前缀。支持从用户消息中提取，例如"review diff D12345"或"帮我 review 一下这个 diff D12345"',
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

  protected async beforeExecute(input: FetchDiffInput): Promise<void> {
    // 规范化 revisionId：智能提取和规范化
    const normalized = extractRevisionId(input.revisionId);
    if (normalized && normalized !== input.revisionId) {
      logger.info(`[FetchDiffTool] Auto-normalized revision ID from "${input.revisionId}" to "${normalized}"`);
      input.revisionId = normalized;
    }

    // 验证输入
    if (!input.revisionId || !input.revisionId.match(/^D\d+$/i)) {
      throw new Error(`Invalid revision ID: ${input.revisionId}. Expected format: D followed by numbers (e.g., D12345)`);
    }
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
