import { FetchDiffTool } from './fetch-diff.js';
import { ResolvePathTool } from './resolve-path.js';
import { detectProjectTestStack } from './detect-stack.js';
import { TestMatrixAnalyzer } from '../agents/test-matrix-analyzer.js';
import { StateManager } from '../state/manager.js';
import { getTestStackDetectionPath } from '../utils/project-root.js';
import type { TestMatrixAnalysis } from '../schemas/test-matrix.js';
import { logger } from '../utils/logger.js';

export interface AnalyzeTestMatrixInput {
  revisionId: string;
  projectRoot?: string;
  forceRefresh?: boolean;
}

export class AnalyzeTestMatrixTool {
  constructor(
    private fetchDiffTool: FetchDiffTool,
    private resolvePathTool: ResolvePathTool,
    private stateManager: StateManager,
    private analyzer: TestMatrixAnalyzer
  ) {}

  async analyze(input: AnalyzeTestMatrixInput): Promise<TestMatrixAnalysis> {
    const startTime = Date.now();

    // 1. 获取 diff
    const diff = await this.fetchDiffTool.fetch({
      revisionId: input.revisionId,
      forceRefresh: input.forceRefresh || false,
    });

    // 过滤前端文件
    const frontendDiff = this.fetchDiffTool.filterFrontendFiles(diff);

    // 2. 通过 resolve-path 工具解析项目根目录
    const filePaths = frontendDiff.files.map(f => f.path);
    const resolveResult = await this.resolvePathTool.resolve({
      paths: filePaths,
      projectRoot: input.projectRoot, // 传递 projectRoot 参数
    });
    
    logger.info('Project root resolved', {
      root: resolveResult.root,
      isMonorepo: resolveResult.isMonorepo,
      workspaceType: resolveResult.workspaceType,
    });
    
    // 构造 ProjectRoot 对象（兼容原有逻辑）
    const projectRoot = {
      root: resolveResult.root,
      isMonorepo: resolveResult.isMonorepo,
      workspaceType: resolveResult.workspaceType,
    };

    // 3. 检测测试栈
    const testDetectionPath = getTestStackDetectionPath(
      projectRoot,
      filePaths[0]
    );
    
    const stack = await detectProjectTestStack(testDetectionPath);
    const framework = stack.unit || 'vitest';
    
    logger.info('Test stack detected', {
      framework,
      detectionPath: testDetectionPath,
    });

    // 4. 构建上下文
    const context = {
      diff: frontendDiff.numberedRaw || frontendDiff.raw,
      files: frontendDiff.files.map(f => ({
        path: f.path,
        content: f.hunks.map(h => h.lines.join('\n')).join('\n'),
      })),
      framework,
    };
    
    // 验证 diff 内容
    if (!context.diff || context.diff.trim().length === 0) {
      throw new Error(`Diff 内容为空。文件数量: ${frontendDiff.files.length}`);
    }
    
    if (context.files.length === 0) {
      throw new Error(`没有前端文件变更。总文件数: ${diff.files.length}`);
    }
    
    logger.info('Context prepared for analysis', {
      diffLength: context.diff.length,
      filesCount: context.files.length,
      filePaths: context.files.map(f => f.path),
    });

    // 5. 执行矩阵分析
    logger.info('Analyzing test matrix...', {
      diffFilesCount: frontendDiff.files.length,
      diffLength: frontendDiff.raw?.length || 0,
    });
    const analysisResult = await this.analyzer.execute(context);

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
      throw new Error(
        `未检测到功能变更。\n` +
        `可能原因：\n` +
        `1. diff 中没有前端代码变更\n` +
        `2. 变更都是格式调整或注释修改\n` +
        `3. AI 分析失败（请检查日志）\n\n` +
        `diff 文件数量: ${frontendDiff.files.length}\n` +
        `文件路径: ${frontendDiff.files.map(f => f.path).join(', ')}`
      );
    }
    
    logger.info('Features detected', {
      featuresCount: matrixData.features.length,
      scenariosCount: matrixData.scenarios?.length || 0,
      featureNames: matrixData.features.map(f => f.name).join(', '),
    });

    // 6. 计算统计信息
    const coverageStats = {
      'happy-path': 0,
      'edge-case': 0,
      'error-path': 0,
      'state-change': 0,
    };

    for (const scenario of matrixData.scenarios) {
      const scenarioType = scenario.scenario;
      // 只统计 schema 中定义的 4 种类型
      if (scenarioType === 'happy-path' || scenarioType === 'edge-case' || 
          scenarioType === 'error-path' || scenarioType === 'state-change') {
        coverageStats[scenarioType]++;
      }
    }

    const estimatedTests = matrixData.scenarios.reduce(
      (sum, s) => sum + s.testCases.length,
      0
    );

    // 7. 构建结果
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
        diffId: diff.diffId || '',
        revisionId: input.revisionId,
        framework,
        duration: Date.now() - startTime,
      },
    };

    // 8. 保存矩阵到状态（供后续生成测试用例使用）
    await this.stateManager.saveTestMatrix(input.revisionId, result.matrix);

    logger.info('Test matrix analysis completed', {
      features: result.matrix.summary.totalFeatures,
      scenarios: result.matrix.summary.totalScenarios,
      estimatedTests: result.matrix.summary.estimatedTests,
    });

    return result;
  }
}

