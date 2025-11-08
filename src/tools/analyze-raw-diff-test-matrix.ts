/**
 * 分析外部传入的 raw diff 内容，生成测试矩阵
 * 专为 n8n 等外部工作流设计，接受 GitLab/GitHub 等平台的 diff 内容
 */

import { ResolvePathTool } from './resolve-path.js';
import { TestMatrixAnalyzer } from '../agents/test-matrix-analyzer.js';
import { StateManager } from '../state/manager.js';
import { BaseAnalyzeTestMatrix } from './base-analyze-test-matrix.js';
import { parseDiff, generateNumberedDiff } from '../utils/diff-parser.js';
import { isFrontendFile } from '../schemas/diff.js';
import { computeContentHash } from '../utils/fingerprint.js';
import type { TestMatrixAnalysis } from '../schemas/test-matrix.js';
import type { Diff } from '../schemas/diff.js';
import { logger } from '../utils/logger.js';

export interface AnalyzeRawDiffTestMatrixInput {
  rawDiff: string;
  identifier: string;
  projectRoot: string;
  metadata?: {
    title?: string;
    author?: string;
    mergeRequestId?: string;
    commitHash?: string;
    branch?: string;
  };
  forceRefresh?: boolean;
}

/**
 * 分析外部传入的 raw diff 内容
 */
export class AnalyzeRawDiffTestMatrixTool {
  private baseAnalyzer: BaseAnalyzeTestMatrix;

  constructor(
    private resolvePathTool: ResolvePathTool,
    private stateManager: StateManager,
    private analyzer: TestMatrixAnalyzer
  ) {
    this.baseAnalyzer = new BaseAnalyzeTestMatrix(this.resolvePathTool, this.stateManager, this.analyzer);
  }

  async analyze(input: AnalyzeRawDiffTestMatrixInput): Promise<TestMatrixAnalysis> {
    const { rawDiff, identifier, projectRoot, metadata, forceRefresh } = input;

    logger.info('Analyzing raw diff for test matrix', {
      identifier,
      projectRoot,
      diffLength: rawDiff.length,
      metadata,
    });

    // 1. 解析 diff
    const diff = parseDiff(rawDiff, identifier, {
      diffId: metadata?.mergeRequestId || metadata?.commitHash || 'unknown',
      title: metadata?.title || '',
      summary: `Branch: ${metadata?.branch || 'unknown'}`,
      author: metadata?.author || 'unknown',
    });

    // 2. 生成带行号的 diff
    diff.numberedRaw = generateNumberedDiff(diff);

    // 3. 过滤前端文件
    const frontendDiff: Diff = {
      ...diff,
      files: diff.files.filter(file => isFrontendFile(file.path)),
    };

    if (frontendDiff.files.length === 0) {
      throw new Error(
        `No frontend files found in diff. Total files: ${diff.files.length}. ` +
        `Frontend file extensions: .js, .jsx, .ts, .tsx, .vue, .css, .scss, .less`
      );
    }

    logger.info('Frontend files filtered', {
      totalFiles: diff.files.length,
      frontendFiles: frontendDiff.files.length,
      frontendPaths: frontendDiff.files.map(f => f.path).join(', '),
    });

    // 4. 计算 diff 指纹（用于去重和缓存）
    const diffFingerprint = computeContentHash(
      frontendDiff.files.map(f => `${f.path}:${f.additions}:${f.deletions}`).join('|')
    );

    // 5. 检查缓存状态
    if (!forceRefresh) {
      try {
        const existingState = await this.baseAnalyzer['stateManager'].getState(identifier);
        if (existingState?.testMatrix && existingState.diffFingerprint === diffFingerprint) {
          logger.info('Using cached test matrix', {
            identifier,
            diffFingerprint,
          });
          return {
            matrix: existingState.testMatrix,
            metadata: {
              diffId: diff.diffId || '',
              revisionId: identifier,
              framework: null,
              duration: 0,
            },
          };
        }
      } catch (error) {
        logger.debug('Cache check failed, will proceed with fresh analysis', { error });
      }
    }

    // 6. 初始化状态
    await this.baseAnalyzer['stateManager'].initState(
      identifier,
      diff.diffId || 'unknown',
      diffFingerprint
    );

    // 7. 使用基类分析
    const result = await this.baseAnalyzer.analyze({
      diff: frontendDiff,
      revisionId: identifier,
      projectRoot,
      metadata: metadata?.commitHash ? {
        commitInfo: {
          hash: metadata.commitHash,
          author: metadata.author || 'unknown',
          date: new Date().toISOString(),
          message: metadata.title || '',
        },
      } : undefined,
      messages: {
        emptyDiff: () => `Diff content is empty. Files: ${diff.files.length}`,
        noFrontendFiles: () =>
          `No frontend files found in diff. Total files: ${diff.files.length}. ` +
          `Frontend file extensions: .js, .jsx, .ts, .tsx, .vue, .css, .scss, .less`,
        noFeatures: () => {
          const baseMsg =
            `No feature changes detected.\n` +
            `Possible reasons:\n` +
            `1. No frontend code changes in the diff\n` +
            `2. Changes are formatting or comment adjustments only\n` +
            `3. AI analysis failed (check logs)\n\n`;

          if (metadata?.mergeRequestId) {
            return (
              baseMsg +
              `MR ID: ${metadata.mergeRequestId}\n` +
              `Title: ${metadata.title || 'N/A'}\n` +
              `Files: ${diff.files.length}`
            );
          }

          return baseMsg + `Files: ${diff.files.length}\n` + `Paths: ${diff.files.map(f => f.path).join(', ')}`;
        },
      },
    });

    logger.info('Raw diff test matrix analysis completed', {
      identifier,
      features: result.matrix.summary.totalFeatures,
      scenarios: result.matrix.summary.totalScenarios,
      estimatedTests: result.matrix.summary.estimatedTests,
    });

    return result;
  }
}
