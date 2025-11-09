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
 * - 支持多种代码变更来源（Phabricator、Git、Raw）
 * - 使用 ReAct 循环自主决策
 * - 支持增量模式和去重
 */

import { OpenAIClient } from '../clients/openai.js';
import { EmbeddingClient } from '../clients/embedding.js';
import { StateManager } from '../state/manager.js';
import { CodeChangeSource } from '../core/code-change-source.js';
import { ContextStore, AgentContext, Thought, Action, Observation } from '../core/context.js';
import { logger } from '../utils/logger.js';
import { getMetrics } from '../utils/metrics.js';
import type { TestCase } from '../schemas/test-plan.js';
import type { Diff } from '../schemas/diff.js';

export interface TestAgentConfig {
  maxSteps: number;
  mode: 'incremental' | 'full';
  maxTests?: number;
  scenarios?: string[];
  autoWrite?: boolean; // 是否自动写入文件
  autoRun?: boolean; // 是否自动执行测试
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
      const matrix = await this.analyzeTestMatrix(diff, context);
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
  private async analyzeTestMatrix(diff: Diff, context: AgentContext): Promise<unknown> {
    logger.info('[TestAgent] Analyzing test matrix');

    // TODO: 调用 TestMatrixAnalyzer
    // 这里简化处理
    const matrix = {
      features: diff.files.map(f => f.path),
      scenarios: ['happy-path', 'edge-case', 'error-path'],
    };

    this.addThought(context, {
      content: `Identified ${diff.files.length} changed files. Will generate tests for scenarios: ${matrix.scenarios.join(', ')}`,
      timestamp: Date.now(),
    });

    return matrix;
  }

  /**
   * 生成测试用例
   */
  private async generateTests(
    _diff: Diff,
    _matrix: unknown,
    _config: TestAgentConfig,
    context: AgentContext
  ): Promise<TestCase[]> {
    logger.info('[TestAgent] Generating test cases');

    // TODO: 调用测试生成 Agent
    // 这里返回空数组作为示例
    const tests: TestCase[] = [];

    this.addThought(context, {
      content: `Generated ${tests.length} test cases`,
      timestamp: Date.now(),
    });

    return tests;
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
