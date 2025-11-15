/**
 * Generate Tests Worker Tool
 * 使用 Worker 线程生成测试用例
 */

import { BaseTool } from '../core/base-tool.js';
import type { ToolMetadata } from '../core/base-tool.js';
import type { TestCase } from '../schemas/test-plan.js';
import { getAppContext } from '../core/app-context.js';
import { OpenAIClient } from '../clients/openai.js';
import { EmbeddingClient } from '../clients/embedding.js';
import { StateManager } from '../state/manager.js';
import { ContextStore } from '../core/context.js';
import { TestAgent } from '../agents/test-agent.js';
import { logger } from '../utils/logger.js';
import { z } from 'zod';

const ArgsSchema = z.object({
  workspaceId: z.string().describe('工作区 ID'),
  diff: z.string().describe('Git diff 内容'),
  matrix: z.object({
    features: z.array(z.any()),
    scenarios: z.array(z.any()),
  }).passthrough().describe('测试矩阵'),
  projectConfig: z.object({
    projectRoot: z.string(),
    isMonorepo: z.boolean(),
    testFramework: z.enum(['vitest', 'jest', 'none']).optional(),
    hasExistingTests: z.boolean(),
  }).passthrough().describe('项目配置'),
  scenarios: z.array(z.string()).optional().describe('要生成的场景列表'),
  maxTests: z.number().optional().describe('最大测试用例数量'),
});

type GenerateArgs = z.infer<typeof ArgsSchema>;

interface GenerationResult {
  tests: TestCase[];
}

export class GenerateTestsWorkerTool extends BaseTool<GenerateArgs, TestCase[]> {
  constructor(
    private openai: OpenAIClient,
    private embedding: EmbeddingClient,
    private state: StateManager,
    private contextStore: ContextStore
  ) {
    super();
  }

  getMetadata(): ToolMetadata {
    return {
      name: 'generate-tests-worker',
      description: `使用 Worker 线程生成测试用例。

此工具会在后台 Worker 线程中执行测试生成任务，避免阻塞主线程。如果 Worker 不可用或失败，会自动回退到直接执行。

参数：
- workspaceId: 工作区 ID
- diff: Git diff 内容
- matrix: 测试矩阵（从 analyze-test-matrix-worker 获取）
- projectConfig: 项目配置
- scenarios: 可选，指定要生成的场景列表
- maxTests: 可选，限制生成的测试用例数量

返回：
- tests: 生成的测试用例列表`,
      inputSchema: {},
    };
  }

  getZodSchema() {
    return ArgsSchema;
  }

  async executeImpl(args: GenerateArgs): Promise<TestCase[]> {
    const { workspaceId, diff, matrix, projectConfig, scenarios, maxTests } = args;

    logger.info('[GenerateTestsWorker] Starting test generation', {
      workspaceId,
      diffLength: diff.length,
      scenariosCount: scenarios?.length || 'all',
    });

    const context = getAppContext();
    const workerPool = (context as any).workerPool;

    // 尝试使用 Worker 执行
    if (workerPool && process.env.WORKER_ENABLED !== 'false') {
      try {
        const result: GenerationResult = await workerPool.executeTask({
          type: 'generate',
          workspaceId,
          payload: {
            diff,
            matrix,
            projectConfig,
            scenarios,
            maxTests,
          },
          timeout: 300000, // 5 分钟超时
        });

        logger.info('[GenerateTestsWorker] Worker generation completed', {
          workspaceId,
          testsCount: result.tests.length,
        });

        return result.tests;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn('[GenerateTestsWorker] Worker failed, falling back to direct execution', {
          workspaceId,
          error: errorMessage,
        });
        // Fall through to direct execution
      }
    }

    // 回退：直接执行
    logger.info('[GenerateTestsWorker] Using direct execution', { workspaceId });

    const agent = new TestAgent(this.openai, this.embedding, this.state, this.contextStore);

    // 创建代码变更源
    const { RawDiffSource } = await import('../core/code-change-source.js');
    
    const diffObj = {
      revisionId: workspaceId,
      raw: diff,
      numberedRaw: diff,
      files: [],
      metadata: {
        title: 'Test Generation',
      },
    };
    
    const source = new RawDiffSource(workspaceId, diffObj);

    const result = await agent.generate(source, {
      maxSteps: 10,
      mode: 'full',
      scenarios,
      maxTests,
      framework: projectConfig.testFramework,
      projectRoot: projectConfig.projectRoot,
    });

    logger.info('[GenerateTestsWorker] Direct generation completed', {
      workspaceId,
      testsCount: result.tests.length,
    });

    return result.tests;
  }
}
