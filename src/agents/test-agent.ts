/**
 * TestAgent - 基于 ReAct 模式的测试生成 Agent
 *
 * 职责：
 * 1. 分析代码变更
 * 2. 生成测试矩阵
 * 3. 生成测试代码
 * 4. 写入测试文件
 * 5. 执行测试（可选）
 *
 * 特点：
 * - 支持多种代码变更来源（Git、Raw diff、外部工作流）
 * - 使用 ReAct 循环自主决策
 * - 支持增量模式和去重
 */

import { OpenAIClient } from '../clients/openai.js';
import { EmbeddingClient } from '../clients/embedding.js';
import { StateManager } from '../state/manager.js';
import { CodeChangeSource } from '../core/code-change-source.js';
import { ContextStore, AgentContext, Thought, Action, Observation } from '../core/context.js';
import { AgentCoordinator, AgentTask } from '../core/agent-coordinator.js';
import { logger } from '../utils/logger.js';
import { getMetrics } from '../utils/metrics.js';
import type { TestCase } from '../schemas/test-plan.js';
import type { Diff } from '../schemas/diff.js';
import type { TestMatrix } from '../schemas/test-matrix.js';
import { TestMatrixAnalyzer } from './test-matrix-analyzer.js';
import {
  HappyPathTestAgent,
  EdgeCaseTestAgent,
  ErrorPathTestAgent,
  StateChangeTestAgent,
} from './tests/index.js';
import { AgentResult, BaseAgent } from './base.js';

export interface TestAgentConfig {
  maxSteps: number;
  mode: 'incremental' | 'full';
  maxTests?: number;
  scenarios?: string[];
  autoWrite?: boolean; // 是否自动写入文件
  autoRun?: boolean; // 是否自动执行测试
  maxConcurrency?: number; // 最大并发数，默认 3
  projectRoot?: string; // 项目根目录
  framework?: string; // 测试框架
}

export interface TestAgentResult {
  success: boolean;
  tests: TestCase[];
  matrix?: unknown;
  filesWritten?: string[];
  testResults?: unknown;
  context: AgentContext;
}

export class TestAgent {
  constructor(
    private _llm: OpenAIClient,
    private _embedding: EmbeddingClient,
    private _stateManager: StateManager,
    private contextStore: ContextStore
  ) {}

  /**
   * 执行测试生成流程
   */
  async generate(
    source: CodeChangeSource,
    config: TestAgentConfig
  ): Promise<TestAgentResult> {
    const sessionId = this.generateSessionId();
    const metadata = source.getMetadata();

    logger.info('[TestAgent] Starting test generation', {
      source: metadata.source,
      identifier: metadata.identifier,
      mode: config.mode,
    });

    getMetrics().recordCounter('test_agent.execution.started', 1, {
      source: metadata.source,
      mode: config.mode,
    });

    // 创建上下文
    const context = this.contextStore.create(sessionId, 'test-agent', 'Generate unit tests', {
      goal: 'Analyze code changes and generate comprehensive unit tests',
      maxSteps: config.maxSteps,
      initialData: {
        source: metadata,
        config,
        tests: [],
        environment: {
          llmConfigured: !!this._llm,
          embeddingEnabled: !!this._embedding,
          stateManagerAvailable: !!this._stateManager,
        },
      },
    });

    try {
      // Step 1: 获取代码变更
      const diff = await source.fetchChanges();
      this.addObservation(context, {
        type: 'tool_result',
        source: 'code-change-source',
        content: { diff, filesCount: diff.files.length },
        timestamp: Date.now(),
      });

      // Step 2: 分析测试矩阵
      const matrix = await this.analyzeTestMatrix(diff, config, context);
      this.addObservation(context, {
        type: 'tool_result',
        source: 'analyze-test-matrix',
        content: matrix,
        timestamp: Date.now(),
      });

      // Step 3: 生成测试用例
      const tests = await this.generateTests(diff, matrix, config, context);
      context.data.tests = tests;

      // Step 4: （可选）写入文件
      let filesWritten: string[] | undefined;
      if (config.autoWrite) {
        filesWritten = await this.writeTestFiles(tests, context);
      }

      // Step 5: （可选）执行测试
      let testResults: unknown;
      if (config.autoRun && filesWritten) {
        testResults = await this.runTests(filesWritten, context);
      }

      context.isComplete = true;

      getMetrics().recordCounter('test_agent.execution.completed', 1, {
        source: metadata.source,
        status: 'success',
      });
      getMetrics().recordHistogram('test_agent.tests_generated', tests.length, {
        source: metadata.source,
      });

      return {
        success: true,
        tests,
        matrix,
        filesWritten,
        testResults,
        context,
      };
    } catch (error) {
      logger.error('[TestAgent] Execution failed', { error });

      getMetrics().recordCounter('test_agent.execution.completed', 1, {
        source: metadata.source,
        status: 'error',
      });

      return {
        success: false,
        tests: [],
        context,
      };
    }
  }

  /**
   * 分析测试矩阵
   */
  private async analyzeTestMatrix(
    diff: Diff,
    config: TestAgentConfig,
    context: AgentContext
  ): Promise<TestMatrix> {
    logger.info('[TestAgent] Analyzing test matrix');

    const analyzer = new TestMatrixAnalyzer(this._llm);

    const reviewContext = {
      diff: diff.numberedRaw || diff.raw,
      files: diff.files.map((f) => ({
        path: f.path,
        content: f.hunks.map((h) => h.lines.join('\n')).join('\n'),
      })),
      framework: config.framework,
    };

    try {
      const result = await analyzer.execute(reviewContext);

      if (!result.items || result.items.length === 0 || !result.items[0]) {
        throw new Error('Test matrix analysis returned no results');
      }

      const matrixData = result.items[0];
      const features = matrixData.features || [];
      const scenarios = matrixData.scenarios || [];

      // 构建测试矩阵
      const matrix: TestMatrix = {
        features,
        scenarios,
        summary: {
          totalFeatures: features.length,
          totalScenarios: scenarios.length,
          estimatedTests: scenarios.length,
          coverage: {
            'happy-path': scenarios.filter((s) => s.scenario === 'happy-path').length,
            'edge-case': scenarios.filter((s) => s.scenario === 'edge-case').length,
            'error-path': scenarios.filter((s) => s.scenario === 'error-path').length,
            'state-change': scenarios.filter((s) => s.scenario === 'state-change').length,
          },
        },
      };

      this.addThought(context, {
        content: `Identified ${features.length} features and ${scenarios.length} test scenarios`,
        timestamp: Date.now(),
      });

      logger.info('[TestAgent] Test matrix analyzed', {
        features: features.length,
        scenarios: scenarios.length,
      });

      return matrix;
    } catch (error) {
      logger.error('[TestAgent] Test matrix analysis failed', { error });

      // 返回空矩阵
      this.addThought(context, {
        content: `Test matrix analysis failed: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: Date.now(),
      });

      return {
        features: [],
        scenarios: [],
        summary: {
          totalFeatures: 0,
          totalScenarios: 0,
          estimatedTests: 0,
          coverage: {
            'happy-path': 0,
            'edge-case': 0,
            'error-path': 0,
            'state-change': 0,
          },
        },
      };
    }
  }

  /**
   * 生成测试用例（使用 AgentCoordinator 并行生成）
   */
  private async generateTests(
    diff: Diff,
    matrix: TestMatrix,
    config: TestAgentConfig,
    context: AgentContext
  ): Promise<TestCase[]> {
    logger.info('[TestAgent] Generating test cases');

    if (matrix.features.length === 0 || matrix.scenarios.length === 0) {
      logger.warn('[TestAgent] No features or scenarios found, skipping test generation');
      this.addThought(context, {
        content: 'No features or scenarios found, skipping test generation',
        timestamp: Date.now(),
      });
      return [];
    }

    // 准备测试生成的上下文
    const reviewContext = {
      diff: diff.numberedRaw || diff.raw,
      files: diff.files.map((f) => ({
        path: f.path,
        content: f.hunks.map((h) => h.lines.join('\n')).join('\n'),
      })),
      metadata: {
        framework: config.framework || 'vitest',
        existingTests: undefined, // TODO: 可以通过 Embedding 查找相似测试
      },
    };

    // 根据 scenario 选择对应的 Agent
    const scenarioAgents = new Map<string, BaseAgent<TestCase>>();
    scenarioAgents.set('happy-path', new HappyPathTestAgent(this._llm));
    scenarioAgents.set('edge-case', new EdgeCaseTestAgent(this._llm));
    scenarioAgents.set('error-path', new ErrorPathTestAgent(this._llm));
    scenarioAgents.set('state-change', new StateChangeTestAgent(this._llm));

    // 获取需要生成的场景类型（基于矩阵或配置）
    const scenariosToGenerate = config.scenarios || ['happy-path', 'edge-case', 'error-path', 'state-change'];
    const applicableScenarios = scenariosToGenerate.filter((s) => scenarioAgents.has(s));

    if (applicableScenarios.length === 0) {
      logger.warn('[TestAgent] No applicable scenarios found');
      return [];
    }

    this.addThought(context, {
      content: `Generating tests for scenarios: ${applicableScenarios.join(', ')}`,
      timestamp: Date.now(),
    });

    // 使用 AgentCoordinator 并行生成测试
    const coordinator = new AgentCoordinator<typeof reviewContext, AgentResult<TestCase>>(
      this.contextStore,
      {
        maxConcurrency: config.maxConcurrency || 3,
        continueOnError: true,
        retryOnError: true,
        maxRetries: 2,
      }
    );

    const tasks: AgentTask<typeof reviewContext, AgentResult<TestCase>>[] = applicableScenarios.map((scenario) => ({
      id: scenario,
      name: `test-gen-${scenario}`,
      agent: scenarioAgents.get(scenario)!,
      input: reviewContext,
      priority: scenario === 'happy-path' ? 10 : 5, // happy-path 优先级最高
    }));

    const result = await coordinator.executeParallel(tasks);

    // 合并所有测试结果
    const allTests: TestCase[] = [];
    for (const taskResult of result.results) {
      if (taskResult.success && taskResult.output) {
        allTests.push(...taskResult.output.items);
      }
    }

    // 去重（基于测试 ID）
    const uniqueTestsMap = new Map<string, TestCase>();
    for (const test of allTests) {
      if (test.id && !uniqueTestsMap.has(test.id)) {
        uniqueTestsMap.set(test.id, test);
      }
    }

    let finalTests = Array.from(uniqueTestsMap.values());

    // 限制测试数量（如果配置了 maxTests）
    if (config.maxTests && finalTests.length > config.maxTests) {
      // 按置信度排序，保留前 N 个
      finalTests = finalTests
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, config.maxTests);

      logger.info('[TestAgent] Limited test cases', {
        original: uniqueTestsMap.size,
        limited: finalTests.length,
      });
    }

    this.addThought(context, {
      content: `Generated ${finalTests.length} test cases (from ${applicableScenarios.length} scenarios)`,
      timestamp: Date.now(),
    });

    logger.info('[TestAgent] Test cases generated', {
      totalScenarios: applicableScenarios.length,
      totalTests: finalTests.length,
      successCount: result.successCount,
      errorCount: result.errorCount,
    });

    return finalTests;
  }

  /**
   * 写入测试文件
   */
  private async writeTestFiles(tests: TestCase[], context: AgentContext): Promise<string[]> {
    logger.info('[TestAgent] Writing test files');

    // TODO: 调用 WriteTestFileTool
    const filesWritten: string[] = [];

    this.addAction(context, {
      type: 'call_tool',
      toolName: 'write-test-file',
      parameters: { tests },
      timestamp: Date.now(),
    });

    return filesWritten;
  }

  /**
   * 执行测试
   */
  private async runTests(files: string[], context: AgentContext): Promise<unknown> {
    logger.info('[TestAgent] Running tests');

    // TODO: 调用 RunTestsTool
    this.addAction(context, {
      type: 'call_tool',
      toolName: 'run-tests',
      parameters: { files },
      timestamp: Date.now(),
    });

    return { status: 'passed', results: [] };
  }

  private addThought(context: AgentContext, thought: Thought): void {
    this.contextStore.addHistory(context.sessionId, { thought });
  }

  private addAction(context: AgentContext, action: Action): void {
    this.contextStore.addHistory(context.sessionId, { action });
  }

  private addObservation(context: AgentContext, observation: Observation): void {
    this.contextStore.addHistory(context.sessionId, { observation });
  }

  private generateSessionId(): string {
    return `test-agent-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }
}
