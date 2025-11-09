/**
 * GenerateTestsFromRawDiffTool - 从外部 raw diff 生成测试（n8n/GitLab 集成）
 *
 * 职责：
 * 1. 解析 raw diff 并分析测试矩阵（可选）
 * 2. 调用 TestAgent 生成测试用例
 * 3. 返回测试代码和统计信息
 */

import { BaseTool, ToolMetadata } from '../core/base-tool.js';
import { parseDiff, generateNumberedDiff } from '../utils/diff-parser.js';
import { isFrontendFile } from '../schemas/diff.js';
import { TestAgent, TestAgentConfig } from '../agents/test-agent.js';
import { TestMatrixAnalyzer } from '../agents/test-matrix-analyzer.js';
import { BaseAnalyzeTestMatrix } from './base-analyze-test-matrix.js';
import { ResolvePathTool } from './resolve-path.js';
import { OpenAIClient } from '../clients/openai.js';
import { EmbeddingClient } from '../clients/embedding.js';
import { StateManager } from '../state/manager.js';
import { ContextStore } from '../core/context.js';
import { RawDiffSource } from '../core/code-change-source.js';
import { logger } from '../utils/logger.js';
import type { TestCase } from '../schemas/test-plan.js';
import type { FeatureItem, TestScenarioItem } from '../schemas/test-matrix.js';

export interface GenerateTestsFromRawDiffInput {
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
  scenarios?: string[];
  mode?: 'incremental' | 'full';
  maxTests?: number;
  analyzeMatrix?: boolean;
  forceRefresh?: boolean;
  framework?: 'vitest' | 'jest';
}

export interface GenerateTestsFromRawDiffOutput {
  identifier: string;
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

export class GenerateTestsFromRawDiffTool extends BaseTool<
  GenerateTestsFromRawDiffInput,
  GenerateTestsFromRawDiffOutput
> {
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

  getMetadata(): ToolMetadata {
    return {
      name: 'generate-tests-from-raw-diff',
      description:
        '从外部 raw diff 一次性完成分析 + 测试生成（端到端工具）。\n\n' +
        '💡 特性：\n' +
        '• 接受标准 unified diff 格式\n' +
        '• 自动（可选）分析测试矩阵\n' +
        '• 支持 Vitest / Jest\n' +
        '• 可限制测试数量、指定场景\n\n' +
        '⚙️ 参数建议：\n' +
        '• analyzeMatrix=true 时，会返回测试矩阵\n' +
        '• projectRoot 应与工作目录一致\n' +
        '• 可与 n8n 的 GitLab/GitHub 节点组合使用',
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
          forceRefresh: {
            type: 'boolean',
            description: '强制刷新缓存（默认 false）',
          },
          framework: {
            type: 'string',
            enum: ['vitest', 'jest'],
            description: '测试框架（可选，自动检测）',
          },
        },
        required: ['rawDiff', 'identifier', 'projectRoot'],
      },
      category: 'test-generation',
      version: '3.0.0',
    };
  }

  protected async executeImpl(
    input: GenerateTestsFromRawDiffInput
  ): Promise<GenerateTestsFromRawDiffOutput> {
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

    logger.info('[GenerateTestsFromRawDiffTool] Parsing raw diff...', {
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

    diff.numberedRaw = generateNumberedDiff(diff);
    diff.metadata = metadata ? { ...metadata } : {};

    // 过滤前端文件
    const frontendFiles = diff.files.filter((f) => isFrontendFile(f.path));
    diff.files = frontendFiles;

    if (diff.files.length === 0) {
      throw new Error(`No frontend files found in diff (identifier: ${identifier})`);
    }

    logger.info('[GenerateTestsFromRawDiffTool] Frontend files found', {
      count: diff.files.length,
      files: diff.files.map((f) => f.path),
    });

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

      matrixData = {
        features: analysisResult.matrix.features,
        scenarios: analysisResult.matrix.scenarios,
        statistics: this.generateStatistics(
          analysisResult.matrix.features,
          analysisResult.matrix.scenarios
        ),
      };

      logger.info('[GenerateTestsFromRawDiffTool] Matrix analysis completed', {
        identifier,
        totalFeatures: matrixData.features.length,
        totalScenarios: matrixData.scenarios.length,
      });
    }

    // 3. 生成测试
    const source = new RawDiffSource(identifier, diff, {
      source: 'raw',
      identifier,
      title: metadata?.title,
    });

    const testAgent = new TestAgent(this.openai, this.embedding, this.state, this.contextStore);

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

    logger.info('[GenerateTestsFromRawDiffTool] Generating tests...', {
      identifier,
      mode,
      scenarios: scenarios || 'auto',
      maxTests,
      framework,
    });

    const result = await testAgent.generate(source, config);

    if (!result.success) {
      throw new Error('Test generation failed');
    }

    const summary = this.generateSummary(result.tests);

    logger.info('[GenerateTestsFromRawDiffTool] Test generation completed', {
      identifier,
      totalTests: result.tests.length,
      framework: framework || 'vitest',
    });

    return {
      identifier,
      tests: result.tests,
      framework: framework || 'vitest',
      projectRoot,
      summary,
      ...(matrixData && { matrix: matrixData }),
    };
  }

  protected async beforeExecute(input: GenerateTestsFromRawDiffInput): Promise<void> {
    if (!input.rawDiff || input.rawDiff.trim().length === 0) {
      throw new Error('rawDiff cannot be empty');
    }

    if (!input.identifier || input.identifier.trim().length === 0) {
      throw new Error('identifier cannot be empty');
    }

    if (!input.projectRoot || input.projectRoot.trim().length === 0) {
      throw new Error('projectRoot cannot be empty');
    }

    if (input.maxTests !== undefined && input.maxTests <= 0) {
      throw new Error(`maxTests must be positive, got: ${input.maxTests}`);
    }
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
      const scenario = test.scenario || 'unknown';
      byScenario[scenario] = (byScenario[scenario] || 0) + 1;
      byFile[test.file] = (byFile[test.file] || 0) + 1;
    }

    return {
      totalTests: tests.length,
      byScenario,
      byFile,
      duplicatesRemoved: 0,
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
