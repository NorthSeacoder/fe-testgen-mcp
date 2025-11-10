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
import { FetchDiffTool } from './fetch-diff.js';
import { RawDiffSource } from '../core/code-change-source.js';
import { OpenAIClient } from '../clients/openai.js';
import { EmbeddingClient } from '../clients/embedding.js';
import { StateManager } from '../state/manager.js';
import { ContextStore } from '../core/context.js';
import { logger } from '../utils/logger.js';
import type { TestCase } from '../schemas/test-plan.js';
import { extractRevisionId } from '../utils/revision.js';

// Zod schema for GenerateTestsInput
export const GenerateTestsInputSchema = z.object({
  revisionId: z.string().describe('REQUIRED. Phabricator Revision ID (e.g., "D538642" or "538642"). Extract from user message patterns like: "generate tests for D12345", "生成 D538642 的测试", "给 12345 写测试". If user provides only numbers, add "D" prefix.'),
  diff: z.any().optional().describe('可选的 diff 对象（如果已通过 fetch-diff 获取）。如果提供此参数，将跳过重新获取 diff 的步骤。'),
  projectRoot: z.string().optional().describe('项目根目录绝对路径（必须与 analyze-test-matrix 使用相同值）'),
  scenarios: z.array(z.enum(['happy-path', 'edge-case', 'error-path', 'state-change'])).optional().describe('手动指定测试场景（可选）'),
  mode: z.enum(['incremental', 'full']).optional().describe('增量或全量模式（默认 incremental）'),
  maxTests: z.number().optional().describe('最大测试数量（可选）'),
  forceRefresh: z.boolean().optional().describe('强制刷新缓存（默认 false）'),
  framework: z.enum(['vitest', 'jest']).optional().describe('测试框架（可选，通常自动检测）'),
});

export interface GenerateTestsInput {
  revisionId: string;
  diff?: any; // 可选的 diff 对象（如果已通过 fetch-diff 获取）
  projectRoot?: string; // 项目根目录（必须与 analyze-test-matrix 使用相同值）
  scenarios?: string[]; // 手动指定测试场景（可选）
  mode?: 'incremental' | 'full'; // 增量或全量模式（默认 incremental）
  maxTests?: number; // 最大测试数量（可选）
  forceRefresh?: boolean; // 强制刷新缓存（默认 false）
  framework?: string; // 测试框架（可选，通常自动检测）
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
}

export class GenerateTestsTool extends BaseTool<GenerateTestsInput, GenerateTestsOutput> {
  constructor(
    private openai: OpenAIClient,
    private embedding: EmbeddingClient,
    private state: StateManager,
    private contextStore: ContextStore,
    private fetchDiffTool: FetchDiffTool
  ) {
    super();
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
        '• Embedding 增强的测试生成\n' +
        '• 支持传入已获取的 diff 对象，避免重复请求\n\n' +
        '📝 推荐工作流：\n' +
        '1. 先调用 analyze-test-matrix 获取测试矩阵\n' +
        '2. 使用相同的 projectRoot 调用此工具（可选传入 diff 对象避免重复请求）\n' +
        '3. 可选手动指定测试场景或使用自动生成\n\n' +
        '⚠️ 注意：projectRoot 参数必须与 analyze-test-matrix 使用相同的值。',
      inputSchema: {
        type: 'object',
        properties: {
          revisionId: {
            type: 'string',
            description: 'REQUIRED. Phabricator Revision ID (e.g., "D538642" or "538642"). Extract from user message patterns like: "generate tests for D12345", "生成 D538642 的测试", "给 12345 写测试". If user provides only numbers, add "D" prefix.',
          },
          diff: {
            type: 'object',
            description: '可选的 diff 对象（如果已通过 fetch-diff 获取）。如果提供此参数，将跳过重新获取 diff 的步骤。',
          },
          projectRoot: {
            type: 'string',
            description: '项目根目录绝对路径（必须与 analyze-test-matrix 使用相同值）',
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
          forceRefresh: {
            type: 'boolean',
            description: '强制刷新缓存（默认 false）',
          },
          framework: {
            type: 'string',
            enum: ['vitest', 'jest'],
            description: '测试框架（可选，通常自动检测）',
          },
        },
        required: ['revisionId'],
      },
      category: 'test-generation',
      version: '3.0.0',
    };
  }

  protected async executeImpl(input: GenerateTestsInput): Promise<GenerateTestsOutput> {
    const {
      revisionId,
      diff: providedDiff,
      projectRoot,
      scenarios,
      mode = 'incremental',
      maxTests,
      forceRefresh = false,
      framework,
    } = input;

    // 1. 获取 diff（如果没有提供）
    let diff;
    if (providedDiff) {
      logger.info(`[GenerateTestsTool] Using provided diff for ${revisionId}`);
      diff = this.fetchDiffTool.filterFrontendFiles(providedDiff);
    } else {
      logger.info(`[GenerateTestsTool] Fetching diff for ${revisionId}...`);
      const diffResult = await this.fetchDiffTool.fetch({ revisionId, forceRefresh });
      diff = this.fetchDiffTool.filterFrontendFiles(diffResult);
    }

    if (diff.files.length === 0) {
      throw new Error(`No frontend files found in revision ${revisionId}`);
    }

    // 2. 创建 CodeChangeSource
    const source = new RawDiffSource(revisionId, diff, {
      source: 'phabricator',
      identifier: revisionId,
      title: diff.title,
    });

    // 3. 创建 TestAgent
    const testAgent = new TestAgent(
      this.openai,
      this.embedding,
      this.state,
      this.contextStore
    );

    // 4. 执行测试生成
    logger.info(`[GenerateTestsTool] Generating tests...`, {
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
      autoWrite: false, // 不自动写入文件，让用户自己处理
      autoRun: false,
      maxConcurrency: 3,
      projectRoot,
      framework,
    };

    const result = await testAgent.generate(source, config);

    if (!result.success) {
      throw new Error(`Test generation failed`);
    }

    // 5. 生成统计摘要
    const summary = this.generateSummary(result.tests);

    logger.info(`[GenerateTestsTool] Test generation completed`, {
      totalTests: result.tests.length,
      framework: framework || 'vitest',
    });

    return {
      revisionId,
      tests: result.tests,
      framework: framework || 'vitest',
      projectRoot: projectRoot || process.cwd(),
      summary,
    };
  }

  protected async beforeExecute(input: GenerateTestsInput): Promise<void> {
    // 规范化 revisionId
    const normalized = extractRevisionId(input.revisionId);
    if (normalized && normalized !== input.revisionId) {
      logger.info(
        `[GenerateTestsTool] Auto-normalized revision ID from "${input.revisionId}" to "${normalized}"`
      );
      input.revisionId = normalized;
    }

    // 验证输入
    if (!input.revisionId || !input.revisionId.match(/^D\d+$/i)) {
      throw new Error(`Invalid revision ID: ${input.revisionId}`);
    }

    if (input.maxTests !== undefined && input.maxTests <= 0) {
      throw new Error(`maxTests must be positive, got: ${input.maxTests}`);
    }

    if (!input.projectRoot) {
      logger.warn(
        '[GenerateTestsTool] projectRoot not provided, will attempt auto-detection (may be inaccurate)'
      );
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
}
