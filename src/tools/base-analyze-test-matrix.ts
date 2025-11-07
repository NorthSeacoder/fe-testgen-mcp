/**
 * 测试矩阵分析的共享逻辑
 */

import { ResolvePathTool } from './resolve-path.js';
import { detectProjectTestStack } from './detect-stack.js';
import { TestMatrixAnalyzer } from '../agents/test-matrix-analyzer.js';
import { StateManager } from '../state/manager.js';
import { getTestStackDetectionPath } from '../utils/project-root.js';
import type { TestMatrixAnalysis } from '../schemas/test-matrix.js';
import type { Diff } from '../schemas/diff.js';
import { logger } from '../utils/logger.js';

export interface AnalyzeContext {
  diff: Diff;
  revisionId: string;
  projectRoot?: string;
  metadata?: {
    commitInfo?: {
      hash: string;
      author: string;
      date: string;
      message: string;
    };
  };
  messages?: {
    emptyDiff?: (diff: Diff) => string;
    noFrontendFiles?: (diff: Diff) => string;
    noFeatures?: (diff: Diff) => string;
  };
}

/**
 * 共享的测试矩阵分析逻辑
 */
export class BaseAnalyzeTestMatrix {
  constructor(
    private resolvePathTool: ResolvePathTool,
    private stateManager: StateManager,
    private analyzer: TestMatrixAnalyzer
  ) {}

  /**
   * 执行测试矩阵分析
   */
  async analyze(context: AnalyzeContext): Promise<TestMatrixAnalysis> {
    const startTime = Date.now();
    const { diff, revisionId, projectRoot, metadata, messages } = context;

    const emptyDiffMessage = messages?.emptyDiff?.(diff) ?? `Diff 内容为空。文件数量: ${diff.files.length}`;
    const noFrontendFilesMessage =
      messages?.noFrontendFiles?.(diff) ??
      (metadata?.commitInfo
        ? `No frontend files found in commit ${metadata.commitInfo.hash}. Total files: ${diff.files.length}`
        : `没有前端文件变更。总文件数: ${diff.files.length}`);
    const noFeaturesMessage =
      messages?.noFeatures?.(diff) ??
      (() => {
        const baseMessage =
          `未检测到功能变更。\n` +
          `可能原因：\n` +
          `1. ${metadata?.commitInfo ? 'commit' : 'diff'} 中没有前端代码变更\n` +
          `2. 变更都是格式调整或注释修改\n` +
          `3. AI 分析失败（请检查日志）\n\n`;

        if (metadata?.commitInfo) {
          return (
            baseMessage +
            `commit: ${metadata.commitInfo.hash}\n` +
            `message: ${metadata.commitInfo.message}\n` +
            `diff 文件数量: ${diff.files.length}`
          );
        }

        return (
          baseMessage +
          `diff 文件数量: ${diff.files.length}\n` +
          `文件路径: ${diff.files.map(f => f.path).join(', ')}`
        );
      })();

    if (diff.files.length === 0) {
      throw new Error(noFrontendFilesMessage);
    }

    // 1. 解析项目根目录
    const filePaths = diff.files.map(f => f.path);
    const resolveResult = await this.resolvePathTool.resolve({
      paths: filePaths,
      projectRoot,
    });

    logger.info('Project root resolved', {
      root: resolveResult.root,
      isMonorepo: resolveResult.isMonorepo,
      workspaceType: resolveResult.workspaceType,
    });

    const projectRootInfo = {
      root: resolveResult.root,
      isMonorepo: resolveResult.isMonorepo,
      workspaceType: resolveResult.workspaceType,
    };

    // 2. 检测测试框架
    const testDetectionPath = getTestStackDetectionPath(projectRootInfo, filePaths[0]);
    const stack = await detectProjectTestStack(testDetectionPath);
    const framework = stack.unit || 'vitest';

    logger.info('Test stack detected', {
      framework,
      detectionPath: testDetectionPath,
    });

    // 3. 构建分析上下文
    const analysisContext = {
      diff: diff.numberedRaw || diff.raw,
      files: diff.files.map(f => ({
        path: f.path,
        content: f.hunks.map(h => h.lines.join('\n')).join('\n'),
      })),
      framework,
    };

    // 验证 diff 内容
    if (!analysisContext.diff || analysisContext.diff.trim().length === 0) {
      throw new Error(emptyDiffMessage);
    }

    if (analysisContext.files.length === 0) {
      throw new Error(noFrontendFilesMessage);
    }

    logger.info('Context prepared for analysis', {
      diffLength: analysisContext.diff.length,
      filesCount: analysisContext.files.length,
      filePaths: analysisContext.files.map(f => f.path),
    });

    // 4. 执行矩阵分析
    logger.info('Analyzing test matrix...');
    const analysisResult = await this.analyzer.execute(analysisContext);

    if (analysisResult.items.length === 0) {
      throw new Error('Test matrix analysis failed: no items returned');
    }

    const matrixData = analysisResult.items[0];

    // 检查是否有功能变更
    if (!matrixData.features || matrixData.features.length === 0) {
      logger.warn('No features detected in test matrix analysis', {
        itemsLength: analysisResult.items.length,
        matrixDataKeys: Object.keys(matrixData),
        rawResponse: JSON.stringify(matrixData, null, 2).substring(0, 500),
      });
      throw new Error(noFeaturesMessage);
    }

    logger.info('Features detected', {
      featuresCount: matrixData.features.length,
      scenariosCount: matrixData.scenarios?.length || 0,
      featureNames: matrixData.features.map(f => f.name).join(', '),
    });

    // 5. 计算统计信息
    const coverageStats = {
      'happy-path': 0,
      'edge-case': 0,
      'error-path': 0,
      'state-change': 0,
    };

    for (const scenario of matrixData.scenarios) {
      const scenarioType = scenario.scenario;
      if (
        scenarioType === 'happy-path' ||
        scenarioType === 'edge-case' ||
        scenarioType === 'error-path' ||
        scenarioType === 'state-change'
      ) {
        coverageStats[scenarioType]++;
      }
    }

    const estimatedTests = matrixData.scenarios.reduce(
      (sum, s) => sum + s.testCases.length,
      0
    );

    // 6. 构建结果
    const result: TestMatrixAnalysis = {
      matrix: {
        features: matrixData.features,
        scenarios: matrixData.scenarios,
        summary: {
          totalFeatures: matrixData.features.length,
          totalScenarios: matrixData.scenarios.length,
          estimatedTests,
          coverage: coverageStats,
        },
      },
      metadata: {
        diffId: diff.diffId || metadata?.commitInfo?.hash || '',
        revisionId,
        framework,
        duration: Date.now() - startTime,
        ...(metadata?.commitInfo && { commitInfo: metadata.commitInfo }),
      },
    };

    // 7. 保存矩阵到状态
    await this.stateManager.saveTestMatrix(revisionId, result.matrix);

    logger.info('Test matrix analysis completed', {
      features: result.matrix.summary.totalFeatures,
      scenarios: result.matrix.summary.totalScenarios,
      estimatedTests: result.matrix.summary.estimatedTests,
      ...(metadata?.commitInfo
        ? { commit: metadata.commitInfo.hash.substring(0, 7) }
        : { revisionId }),
    });

    return result;
  }
}
