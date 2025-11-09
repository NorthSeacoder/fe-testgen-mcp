/**
 * AnalyzeTestMatrixTool - 封装 TestMatrixAnalyzer 为 MCP 工具
 *
 * 职责：
 * 1. 从 Phabricator 获取 diff
 * 2. 分析代码变更的功能清单和测试矩阵
 * 3. 检测测试框架
 * 4. 返回测试矩阵结果供后续生成使用
 */

import { BaseTool, ToolMetadata } from '../core/base-tool.js';
import { TestMatrixAnalyzer } from '../agents/test-matrix-analyzer.js';
import { BaseAnalyzeTestMatrix } from './base-analyze-test-matrix.js';
import { ResolvePathTool } from './resolve-path.js';
import { FetchDiffTool } from './fetch-diff.js';
import { OpenAIClient } from '../clients/openai.js';
import { StateManager } from '../state/manager.js';
import { logger } from '../utils/logger.js';
import type { FeatureItem, TestScenarioItem } from '../schemas/test-matrix.js';

export interface AnalyzeTestMatrixInput {
  revisionId: string;
  projectRoot?: string; // 项目根目录绝对路径（强烈推荐提供）
  forceRefresh?: boolean;
}

export interface AnalyzeTestMatrixOutput {
  revisionId: string;
  features: FeatureItem[];
  scenarios: TestScenarioItem[];
  framework: string;
  projectRoot: string;
  statistics: {
    totalFeatures: number;
    totalScenarios: number;
    estimatedTests: number;
    featuresByType: Record<string, number>;
    scenariosByType: Record<string, number>;
  };
}

export class AnalyzeTestMatrixTool extends BaseTool<AnalyzeTestMatrixInput, AnalyzeTestMatrixOutput> {
  private baseAnalyzer: BaseAnalyzeTestMatrix;

  constructor(
    openai: OpenAIClient,
    state: StateManager,
    private fetchDiffTool: FetchDiffTool
  ) {
    super();
    const resolvePathTool = new ResolvePathTool();
    const analyzer = new TestMatrixAnalyzer(openai);
    this.baseAnalyzer = new BaseAnalyzeTestMatrix(resolvePathTool, state, analyzer);
  }

  getMetadata(): ToolMetadata {
    return {
      name: 'analyze-test-matrix',
      description:
        '分析代码变更的功能清单和测试矩阵，这是测试生成的第一步。\n\n' +
        '🔍 分析内容：\n' +
        '• 功能清单（变更涉及的功能点）\n' +
        '• 测试矩阵（每个功能需要的测试场景）\n' +
        '• 测试框架检测（Vitest/Jest）\n' +
        '• 项目根目录检测\n\n' +
        '📊 输出信息：\n' +
        '• features: 功能清单数组\n' +
        '• scenarios: 测试场景数组\n' +
        '• framework: 检测到的测试框架\n' +
        '• projectRoot: 项目根目录路径\n' +
        '• statistics: 统计信息\n\n' +
        '💡 推荐工作流：\n' +
        '1. 调用 fetch-diff 查看 diff 内容和文件路径\n' +
        '2. 执行 pwd 命令获取当前工作目录\n' +
        '3. 调用此工具，传入 projectRoot 参数\n' +
        '4. 保存返回的 projectRoot 值，供 generate-tests 使用\n\n' +
        '⚠️ 注意：projectRoot 参数虽然可选，但强烈建议提供，否则可能导致路径解析失败。',
      inputSchema: {
        type: 'object',
        properties: {
          revisionId: {
            type: 'string',
            description: 'Revision ID（如 D551414）',
          },
          projectRoot: {
            type: 'string',
            description: '项目根目录绝对路径（强烈推荐提供，用于检测测试框架和解析文件路径）',
          },
          forceRefresh: {
            type: 'boolean',
            description: '强制刷新缓存（默认 false）',
          },
        },
        required: ['revisionId'],
      },
      category: 'test-generation',
      version: '3.0.0',
    };
  }

  protected async executeImpl(input: AnalyzeTestMatrixInput): Promise<AnalyzeTestMatrixOutput> {
    const { revisionId, projectRoot, forceRefresh = false } = input;

    // 1. 获取 diff
    logger.info(`[AnalyzeTestMatrixTool] Fetching diff for ${revisionId}...`);
    const diffResult = await this.fetchDiffTool.fetch({ revisionId, forceRefresh });
    const diff = this.fetchDiffTool.filterFrontendFiles(diffResult);

    if (diff.files.length === 0) {
      throw new Error(`No frontend files found in revision ${revisionId}`);
    }

    // 2. 使用 BaseAnalyzeTestMatrix 执行分析
    logger.info(`[AnalyzeTestMatrixTool] Analyzing test matrix...`);
    const analysisResult = await this.baseAnalyzer.analyze({
      diff,
      revisionId,
      projectRoot,
    });

    // 3. 转换为工具输出格式
    const statistics = this.generateStatistics(
      analysisResult.matrix.features,
      analysisResult.matrix.scenarios
    );

    logger.info(`[AnalyzeTestMatrixTool] Analysis completed`, {
      totalFeatures: analysisResult.matrix.features.length,
      totalScenarios: analysisResult.matrix.scenarios.length,
      estimatedTests: statistics.estimatedTests,
    });

    return {
      revisionId,
      features: analysisResult.matrix.features,
      scenarios: analysisResult.matrix.scenarios,
      framework: analysisResult.metadata.framework || 'vitest',
      projectRoot: projectRoot || process.cwd(),
      statistics,
    };
  }

  protected async beforeExecute(input: AnalyzeTestMatrixInput): Promise<void> {
    // 验证输入
    if (!input.revisionId || !input.revisionId.match(/^D\d+$/i)) {
      throw new Error(`Invalid revision ID: ${input.revisionId}`);
    }

    if (input.projectRoot) {
      logger.info('[AnalyzeTestMatrixTool] Using provided projectRoot:', input.projectRoot);
    } else {
      logger.warn(
        '[AnalyzeTestMatrixTool] projectRoot not provided, will attempt auto-detection (may be inaccurate)'
      );
    }
  }

  private generateStatistics(
    features: FeatureItem[],
    scenarios: TestScenarioItem[]
  ): {
    totalFeatures: number;
    totalScenarios: number;
    estimatedTests: number;
    featuresByType: Record<string, number>;
    scenariosByType: Record<string, number>;
  } {
    const featuresByType: Record<string, number> = {};
    const scenariosByType: Record<string, number> = {};

    for (const feature of features) {
      featuresByType[feature.type] = (featuresByType[feature.type] || 0) + 1;
    }

    for (const scenario of scenarios) {
      scenariosByType[scenario.scenario] = (scenariosByType[scenario.scenario] || 0) + 1;
    }

    // 估算测试数量：每个场景可能生成 1-3 个测试用例
    const estimatedTests = scenarios.reduce((sum, s) => sum + (s.testCases?.length || 2), 0);

    return {
      totalFeatures: features.length,
      totalScenarios: scenarios.length,
      estimatedTests,
      featuresByType,
      scenariosByType,
    };
  }
}
