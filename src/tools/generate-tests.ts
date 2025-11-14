/**
 * GenerateTestsTool - 封装 TestAgent 为 MCP 工具
 *
 * 职责：
 * 1. 从 Phabricator 获取 diff
 * 2. 分析测试矩阵（或使用已有的矩阵）
 * 3. 调用 TestAgent 生成测试代码
 * 4. 返回生成的测试用例
 */

import { z } from 'zod';
import { BaseTool, ToolMetadata } from '../core/base-tool.js';
import { TestAgent, TestAgentConfig } from '../agents/test-agent.js';
import { TestMatrixAnalyzer } from '../agents/test-matrix-analyzer.js';
import { BaseAnalyzeTestMatrix } from './base-analyze-test-matrix.js';
import { ResolvePathTool } from './resolve-path.js';
import { RawDiffSource } from '../core/code-change-source.js';
import { OpenAIClient } from '../clients/openai.js';
import { EmbeddingClient } from '../clients/embedding.js';
import { StateManager } from '../state/manager.js';
import { ContextStore } from '../core/context.js';
import { logger } from '../utils/logger.js';
import { parseDiff, generateNumberedDiff } from '../utils/diff-parser.js';
import { isFrontendFile } from '../schemas/diff.js';
import type { FeatureItem, TestScenarioItem } from '../schemas/test-matrix.js';
import type { TestCase } from '../schemas/test-plan.js';

// Zod schema for GenerateTestsInput
export const GenerateTestsInputSchema = z.object({
  rawDiff: z.string().describe('REQUIRED. Unified diff 格式的原始文本（git diff 或其他工具生成的 diff）'),
  identifier: z.string().optional().describe('唯一标识符（如 MR ID、PR ID、commit hash）'),
  projectRoot: z.string().optional().describe('项目根目录绝对路径（必须与 analyze-test-matrix 使用相同值）'),
  metadata: z.object({
    title: z.string().optional(),
    author: z.string().optional(),
    mergeRequestId: z.string().optional(),
    commitHash: z.string().optional(),
    branch: z.string().optional(),
  }).optional().describe('可选的元数据'),
  scenarios: z.array(z.enum(['happy-path', 'edge-case', 'error-path', 'state-change'])).optional().describe('手动指定测试场景（可选）'),
  mode: z.enum(['incremental', 'full']).optional().describe('增量或全量模式（默认 incremental）'),
  maxTests: z.number().optional().describe('最大测试数量（可选）'),
  analyzeMatrix: z.boolean().optional().describe('是否先分析测试矩阵（默认 true）'),
  framework: z.enum(['vitest', 'jest']).optional().describe('测试框架（可选，通常自动检测）'),
});

export interface GenerateTestsInput {
  rawDiff: string;
  identifier?: string;
  projectRoot?: string;
  metadata?: {
    title?: string;
    author?: string;
    mergeRequestId?: string;
    commitHash?: string;
    branch?: string;
  };
  scenarios?: string[];
  mode?: 'incremental' | 'full';
  maxTests?: number;
  analyzeMatrix?: boolean;
  framework?: string;
}

export interface GenerateTestsOutput {
  revisionId: string;
  tests: TestCase[];
  framework: string;
  projectRoot: string;
  summary: {
    totalTests: number;
    byScenario: Record<string, number>;
    byFile: Record<string, number>;
    duplicatesRemoved: number;
  };
  matrix?: {
    features: FeatureItem[];
    scenarios: TestScenarioItem[];
    statistics: {
      totalFeatures: number;
      totalScenarios: number;
      estimatedTests: number;
      featuresByType: Record<string, number>;
      scenariosByType: Record<string, number>;
    };
  };
}

export class GenerateTestsTool extends BaseTool<GenerateTestsInput, GenerateTestsOutput> {
  private baseAnalyzer: BaseAnalyzeTestMatrix;

  constructor(
    private openai: OpenAIClient,
    private embedding: EmbeddingClient,
    private state: StateManager,
    private contextStore: ContextStore
  ) {
    super();
    const resolvePathTool = new ResolvePathTool();
    const analyzer = new TestMatrixAnalyzer(openai);
    this.baseAnalyzer = new BaseAnalyzeTestMatrix(resolvePathTool, state, analyzer);
  }

  // Expose Zod schema for FastMCP
  getZodSchema() {
    return GenerateTestsInputSchema;
  }

  getMetadata(): ToolMetadata {
    return {
      name: 'generate-tests',
      description:
        '基于测试矩阵生成具体的单元测试代码，支持多种测试场景。\n\n' +
        '🧪 测试场景类型：\n' +
        '• happy-path: 正常流程测试\n' +
        '• edge-case: 边界条件测试\n' +
        '• error-path: 异常处理测试\n' +
        '• state-change: 状态变更测试\n\n' +
        '💡 特性：\n' +
        '• 自动并行生成多种场景测试\n' +
        '• 智能去重（基于测试 ID）\n' +
        '• 支持增量模式和全量模式\n' +
        '• 自动检测测试框架（Vitest/Jest）\n' +
        '• Embedding 增强的测试生成\n\n' +
        '📝 推荐工作流：\n' +
        '1. 在客户端或工作流中获取 unified diff（git diff 输出）\n' +
        '2. 先调用 analyze-test-matrix 获取测试矩阵和 projectRoot\n' +
        '3. 使用相同的 rawDiff 和 projectRoot 调用此工具\n' +
        '4. 可选手动指定测试场景或使用自动生成\n\n' +
        '⚠️ 注意：projectRoot 参数必须与 analyze-test-matrix 使用相同的值。',
      inputSchema: {
        type: 'object',
        properties: {
          rawDiff: {
            type: 'string',
            description: 'Unified diff 格式的原始文本（git diff 或其他工具生成的 diff）',
          },
          identifier: {
            type: 'string',
            description: '唯一标识符（如 MR ID、PR ID、commit hash）',
          },
          projectRoot: {
            type: 'string',
            description: '项目根目录绝对路径（必须与 analyze-test-matrix 使用相同值）',
          },
          metadata: {
            type: 'object',
            description: '可选的元数据（用于补充 diff 背景信息）',
          },
          scenarios: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['happy-path', 'edge-case', 'error-path', 'state-change'],
            },
            description: '手动指定测试场景（可选）',
          },
          mode: {
            type: 'string',
            enum: ['incremental', 'full'],
            description: '增量或全量模式（默认 incremental）',
          },
          maxTests: {
            type: 'number',
            description: '最大测试数量（可选）',
          },
          analyzeMatrix: {
            type: 'boolean',
            description: '是否先分析测试矩阵（默认 true）',
          },
          framework: {
            type: 'string',
            enum: ['vitest', 'jest'],
            description: '测试框架（可选，通常自动检测）',
          },
        },
        required: ['rawDiff'],
      },
      category: 'test-generation',
      version: '3.0.0',
    };
  }

  protected async executeImpl(input: GenerateTestsInput): Promise<GenerateTestsOutput> {
    const {
      rawDiff,
      identifier,
      projectRoot,
      metadata,
      scenarios,
      mode = 'incremental',
      maxTests,
      analyzeMatrix = true,
      framework,
    } = input;

    const effectiveId = identifier || metadata?.commitHash || 'unknown';

    // 1. 解析 diff
    logger.info(`[GenerateTestsTool] Parsing raw diff for ${effectiveId}...`);
    const parsedDiff = parseDiff(rawDiff, effectiveId, {
      diffId: metadata?.commitHash || identifier,
      title: metadata?.title,
      summary: metadata?.mergeRequestId || metadata?.commitHash,
      author: metadata?.author,
    });
    parsedDiff.numberedRaw = generateNumberedDiff(parsedDiff);
    parsedDiff.metadata = metadata ? { ...metadata } : {};
    const frontendFiles = parsedDiff.files.filter((f) => isFrontendFile(f.path));
    parsedDiff.files = frontendFiles;
    const diff = parsedDiff;

    if (diff.files.length === 0) {
      throw new Error(`No frontend files found in ${effectiveId}`);
    }

    // 2. （可选）分析测试矩阵
    let matrixData:
      | {
          features: FeatureItem[];
          scenarios: TestScenarioItem[];
          statistics: {
            totalFeatures: number;
            totalScenarios: number;
            estimatedTests: number;
            featuresByType: Record<string, number>;
            scenariosByType: Record<string, number>;
          };
        }
      | undefined;

    if (analyzeMatrix) {
      logger.info('[GenerateTestsTool] Analyzing test matrix before generation...', {
        identifier: effectiveId,
      });
      const analysisResult = await this.baseAnalyzer.analyze({
        diff,
        revisionId: effectiveId,
        projectRoot,
        metadata: metadata ? {
          commitInfo: metadata.commitHash ? {
            hash: metadata.commitHash,
            author: metadata.author || 'unknown',
            date: new Date().toISOString(),
            message: metadata.title || '',
          } : undefined,
        } : undefined,
      });

      matrixData = {
        features: analysisResult.matrix.features,
        scenarios: analysisResult.matrix.scenarios,
        statistics: this.generateMatrixStatistics(
          analysisResult.matrix.features,
          analysisResult.matrix.scenarios
        ),
      };
    }

    // 3. 创建 CodeChangeSource
    const source = new RawDiffSource(effectiveId, diff, {
      source: rawDiff ? 'raw' : 'phabricator',
      identifier: effectiveId,
      title: diff.title,
    });

    // 4. 创建 TestAgent
    const testAgent = new TestAgent(
      this.openai,
      this.embedding,
      this.state,
      this.contextStore
    );

    // 5. 执行测试生成
    logger.info(`[GenerateTestsTool] Generating tests...`, {
      identifier: effectiveId,
      mode,
      scenarios: scenarios || 'auto',
      maxTests,
      projectRoot,
      framework,
    });

    const config: TestAgentConfig = {
      maxSteps: 10,
      mode,
      maxTests,
      scenarios,
      autoWrite: false,
      autoRun: false,
      maxConcurrency: 3,
      projectRoot,
      framework,
    };

    const result = await testAgent.generate(source, config);

    if (!result.success) {
      throw new Error(`Test generation failed`);
    }

    // 6. 生成统计摘要
    const summary = this.generateSummary(result.tests);

    logger.info(`[GenerateTestsTool] Test generation completed`, {
      identifier: effectiveId,
      totalTests: result.tests.length,
      framework: framework || 'vitest',
    });

    return {
      revisionId: effectiveId,
      tests: result.tests,
      framework: framework || 'vitest',
      projectRoot: projectRoot || process.cwd(),
      summary,
      ...(matrixData && { matrix: matrixData }),
    };
  }

  private generateSummary(tests: TestCase[]): {
    totalTests: number;
    byScenario: Record<string, number>;
    byFile: Record<string, number>;
    duplicatesRemoved: number;
  } {
    const byScenario: Record<string, number> = {};
    const byFile: Record<string, number> = {};

    for (const test of tests) {
      // 按场景统计
      const scenario = test.scenario || (test as any).metadata?.scenario || 'unknown';
      byScenario[scenario] = (byScenario[scenario] || 0) + 1;

      // 按文件统计
      byFile[test.file] = (byFile[test.file] || 0) + 1;
    }

    return {
      totalTests: tests.length,
      byScenario,
      byFile,
      duplicatesRemoved: 0, // TestAgent 内部已处理去重
    };
  }

  private generateMatrixStatistics(
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

    const estimatedTests = scenarios.reduce((sum: number, s: any) => sum + (s.testCases?.length || 2), 0);

    return {
      totalFeatures: features.length,
      totalScenarios: scenarios.length,
      estimatedTests,
      featuresByType,
      scenariosByType,
    };
  }
}
