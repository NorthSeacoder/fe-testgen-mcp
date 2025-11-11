/**
 * AnalyzeRawDiffTestMatrixTool - 从外部 raw diff 分析测试矩阵（n8n/GitLab 集成）
 *
 * 职责：
 * 1. 接受外部传入的 raw diff 文本
 * 2. 解析 diff 并分析测试矩阵
 * 3. 返回功能清单和测试场景
 */

import { z } from 'zod';
import { BaseTool, ToolMetadata } from '../core/base-tool.js';
import { BaseAnalyzeTestMatrix } from './base-analyze-test-matrix.js';
import { ResolvePathTool } from './resolve-path.js';
import { TestMatrixAnalyzer } from '../agents/test-matrix-analyzer.js';
import { OpenAIClient } from '../clients/openai.js';
import { StateManager } from '../state/manager.js';
import { parseDiff, generateNumberedDiff } from '../utils/diff-parser.js';
import { isFrontendFile } from '../schemas/diff.js';
import { logger } from '../utils/logger.js';
import type { FeatureItem, TestScenarioItem } from '../schemas/test-matrix.js';

// Zod schema for AnalyzeRawDiffTestMatrixInput
export const AnalyzeRawDiffTestMatrixInputSchema = z.object({
  rawDiff: z.string().describe('Unified diff 格式的原始文本（必需）'),
  identifier: z.string().describe('唯一标识符，如 MR ID、PR ID、commit hash（必需）'),
  projectRoot: z.string().describe('项目根目录绝对路径（必需）'),
  metadata: z.object({
    title: z.string().optional(),
    author: z.string().optional(),
    mergeRequestId: z.string().optional(),
    commitHash: z.string().optional(),
    branch: z.string().optional(),
  }).optional().describe('可选的元数据'),
  forceRefresh: z.boolean().optional().describe('强制刷新缓存（默认 false）'),
});

export interface AnalyzeRawDiffTestMatrixInput {
  rawDiff: string; // Unified diff 格式的原始文本
  identifier: string; // 唯一标识符（如 MR ID、PR ID）
  projectRoot: string; // 项目根目录绝对路径
  metadata?: {
    title?: string;
    author?: string;
    mergeRequestId?: string;
    commitHash?: string;
    branch?: string;
  };
  forceRefresh?: boolean;
}

export interface AnalyzeRawDiffTestMatrixOutput {
  identifier: string;
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

export class AnalyzeRawDiffTestMatrixTool extends BaseTool<
  AnalyzeRawDiffTestMatrixInput,
  AnalyzeRawDiffTestMatrixOutput
> {
  private baseAnalyzer: BaseAnalyzeTestMatrix;

  constructor(openai: OpenAIClient, state: StateManager) {
    super();
    const resolvePathTool = new ResolvePathTool();
    const analyzer = new TestMatrixAnalyzer(openai);
    this.baseAnalyzer = new BaseAnalyzeTestMatrix(resolvePathTool, state, analyzer);
  }

  // Expose Zod schema for FastMCP
  getZodSchema() {
    return AnalyzeRawDiffTestMatrixInputSchema;
  }

  getMetadata(): ToolMetadata {
    return {
      name: 'analyze-raw-diff-test-matrix',
      description:
        '从外部传入的 raw diff 内容分析测试矩阵（专为 n8n/GitLab 工作流设计）。\n\n' +
        '💡 特性：\n' +
        '• 接受标准 unified diff 格式\n' +
        '• 支持 GitLab MR、GitHub PR 等平台\n' +
        '• 分步式工作流，先分析后决策\n' +
        '• 自动检测测试框架\n\n' +
        '📋 使用场景：\n' +
        '• n8n 工作流中，GitLab 节点已获取 diff\n' +
        '• CI/CD 流程中的增量测试分析\n' +
        '• 分步式测试生成（先分析矩阵，再决定是否生成）\n\n' +
        '⚠️ 注意：\n' +
        '• rawDiff 必须是标准 unified diff 格式\n' +
        '• projectRoot 必须是有效的项目根目录\n' +
        '• 返回的矩阵可用于 generate-tests-from-raw-diff',
      inputSchema: {
        type: 'object',
        properties: {
          rawDiff: {
            type: 'string',
            description: 'Unified diff 格式的原始文本（必需）',
          },
          identifier: {
            type: 'string',
            description: '唯一标识符，如 MR ID、PR ID、commit hash（必需）',
          },
          projectRoot: {
            type: 'string',
            description: '项目根目录绝对路径（必需）',
          },
          metadata: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              author: { type: 'string' },
              mergeRequestId: { type: 'string' },
              commitHash: { type: 'string' },
              branch: { type: 'string' },
            },
            description: '可选的元数据',
          },
          forceRefresh: {
            type: 'boolean',
            description: '强制刷新缓存（默认 false）',
          },
        },
        required: ['rawDiff', 'identifier', 'projectRoot'],
      },
      category: 'test-generation',
      version: '3.0.0',
    };
  }

  protected async executeImpl(
    input: AnalyzeRawDiffTestMatrixInput
  ): Promise<AnalyzeRawDiffTestMatrixOutput> {
    const { rawDiff, identifier, projectRoot, metadata } = input;

    logger.info('[AnalyzeRawDiffTestMatrixTool] Parsing raw diff...', {
      identifier,
      diffLength: rawDiff.length,
    });

    // 1. 解析 raw diff
    const diff = parseDiff(rawDiff, identifier, {
      diffId: metadata?.commitHash || identifier,
      title: metadata?.title,
      summary: metadata?.mergeRequestId || metadata?.commitHash,
      author: metadata?.author,
    });

    // 生成带行号的 diff
    diff.numberedRaw = generateNumberedDiff(diff);

    // 过滤前端文件
    const frontendFiles = diff.files.filter((f) => isFrontendFile(f.path));
    diff.files = frontendFiles;

    if (diff.files.length === 0) {
      throw new Error(`No frontend files found in diff (identifier: ${identifier})`);
    }

    logger.info('[AnalyzeRawDiffTestMatrixTool] Frontend files found', {
      count: diff.files.length,
      files: diff.files.map((f) => f.path),
    });

    // 2. 使用 BaseAnalyzeTestMatrix 执行分析
    const analysisResult = await this.baseAnalyzer.analyze({
      diff,
      revisionId: identifier,
      projectRoot,
      metadata: {
        commitInfo: metadata?.commitHash
          ? {
              hash: metadata.commitHash,
              author: metadata.author || 'unknown',
              date: new Date().toISOString(),
              message: metadata.title || '',
            }
          : undefined,
      },
      messages: {
        emptyDiff: () => `Raw diff is empty (identifier: ${identifier})`,
        noFrontendFiles: () =>
          `No frontend files found in raw diff (identifier: ${identifier}). Total files: ${diff.files.length}`,
        noFeatures: () =>
          `No features detected in raw diff (identifier: ${identifier}).\n` +
          `Files analyzed: ${diff.files.map((f) => f.path).join(', ')}`,
      },
    });

    // 3. 转换为工具输出格式
    const statistics = this.generateStatistics(
      analysisResult.matrix.features,
      analysisResult.matrix.scenarios
    );

    logger.info('[AnalyzeRawDiffTestMatrixTool] Analysis completed', {
      identifier,
      totalFeatures: analysisResult.matrix.features.length,
      totalScenarios: analysisResult.matrix.scenarios.length,
      estimatedTests: statistics.estimatedTests,
    });

    return {
      identifier,
      features: analysisResult.matrix.features,
      scenarios: analysisResult.matrix.scenarios,
      framework: analysisResult.metadata.framework || 'vitest',
      projectRoot,
      statistics,
    };
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
