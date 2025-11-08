import { TopicIdentifierAgent } from '../agents/topic-identifier.js';
import { Orchestrator } from './pipeline.js';
import type { Diff } from '../schemas/diff.js';
import type { Issue } from '../schemas/issue.js';
import type { TestCase } from '../schemas/test-plan.js';
import { BaseAgent } from '../agents/base.js';
import { logger } from '../utils/logger.js';
import { extractFileDiff } from '../utils/diff-parser.js';

export interface WorkflowContext {
  diff: Diff;
  commitMessage?: string;
  mode: 'incremental' | 'full';
  existingIssues?: Issue[];
  existingTests?: TestCase[];
}

export interface WorkflowResult<T> {
  items: T[];
  identifiedTopics: string[];
  metadata: {
    agentsRun: string[];
    duration: number;
  };
}

export class Workflow {
  constructor(
    private topicIdentifier: TopicIdentifierAgent,
    private orchestrator: Orchestrator,
    private crAgents: Map<string, BaseAgent<Issue>>,
    private testAgents: Map<string, BaseAgent<TestCase>>
  ) {}

  /**
   * 执行 CR 工作流
   */
  async executeReview(context: WorkflowContext): Promise<WorkflowResult<Issue>> {
    const startTime = Date.now();

    // 1. 识别主题
    logger.info('Identifying topics...');
    const { crTopics } = await this.topicIdentifier.identifyTopics(
      context.diff.raw,
      context.commitMessage
    );

    // 2. 选择要运行的 Agent
    const agentsToRun: BaseAgent<Issue>[] = [];
    for (const topic of crTopics) {
      const agent = this.crAgents.get(topic);
      if (agent) {
        agentsToRun.push(agent);
      }
    }

    // 确保 testing-suggestions 始终运行
    const testingAgent = this.crAgents.get('testing-suggestions');
    if (testingAgent && !agentsToRun.includes(testingAgent)) {
      agentsToRun.push(testingAgent);
    }

    // 3. 并行执行 Agent
    logger.info(`Running ${agentsToRun.length} CR agents...`);
    
    // 为每个文件提取其 diff 片段
    const filesWithContent = context.diff.files.map(f => {
      const content = extractFileDiff(context.diff.raw, f.path);
      if (content.length < 50) {
        logger.warn(`File ${f.path} has very short diff content: ${content.length} chars`);
      }
      return {
        path: f.path,
        content,
      };
    });
    
    const agentResults = await this.orchestrator.executeAgents(
      agentsToRun,
      {
        diff: context.diff.raw,
        files: filesWithContent,
        metadata: {
          commitMessage: context.commitMessage,
        },
      }
    );

    // 4. 聚合结果
    const issues = await this.orchestrator.aggregateIssues(agentResults);

    // 5. 增量模式：对比现有问题
    let finalIssues = issues;
    if (context.mode === 'incremental' && context.existingIssues) {
      const existingIds = new Set(context.existingIssues.map(i => i.id));
      finalIssues = issues.filter(issue => !existingIds.has(issue.id));
      logger.info(`Incremental mode: ${finalIssues.length} new issues (${issues.length} total)`);
    }

    const duration = Date.now() - startTime;

    return {
      items: finalIssues,
      identifiedTopics: crTopics,
      metadata: {
        agentsRun: agentsToRun.map(a => a.getName()),
        duration,
      },
    };
  }

  /**
   * 执行测试生成工作流
   */
  async executeTestGeneration(
    context: WorkflowContext & {
      framework: string;
      existingTestContext?: string;
      scenarios?: string[];
    }
  ): Promise<WorkflowResult<TestCase>> {
    const startTime = Date.now();

    // 1. 识别测试场景（如果未手动指定）
    let testScenarios: string[];
    if (context.scenarios && context.scenarios.length > 0) {
      logger.info('Using manually specified test scenarios', { scenarios: context.scenarios });
      testScenarios = context.scenarios;
    } else {
      logger.info('Identifying test scenarios...');
      const result = await this.topicIdentifier.identifyTopics(
        context.diff.raw,
        context.commitMessage
      );
      testScenarios = result.testScenarios;
    }

    // 2. 选择要运行的 Agent
    const agentsToRun: BaseAgent<TestCase>[] = [];
    for (const scenario of testScenarios) {
      const agent = this.testAgents.get(scenario);
      if (agent) {
        agentsToRun.push(agent);
      }
    }

    // 默认至少运行 happy-path
    if (agentsToRun.length === 0) {
      const happyPathAgent = this.testAgents.get('happy-path');
      if (happyPathAgent) {
        agentsToRun.push(happyPathAgent);
      }
    }

    // 3. 并行执行 Agent
    logger.info(`Running ${agentsToRun.length} test agents...`);
    const agentResults = await this.orchestrator.executeAgents(
      agentsToRun,
      {
        diff: context.diff.raw,
        files: context.diff.files.map(f => ({
          path: f.path,
          content: extractFileDiff(context.diff.raw, f.path), // 提取该文件的 diff 片段
        })),
        metadata: {
          framework: context.framework,
          existingTests: context.existingTestContext,
        },
      }
    );

    // 4. 聚合结果
    const tests = await this.orchestrator.aggregateTests(agentResults);

    // 5. 增量模式：对比现有测试
    let finalTests = tests;
    if (context.mode === 'incremental' && context.existingTests) {
      const existingIds = new Set(context.existingTests.map(t => t.id));
      finalTests = tests.filter(test => !existingIds.has(test.id));
      logger.info(`Incremental mode: ${finalTests.length} new tests (${tests.length} total)`);
    }

    const duration = Date.now() - startTime;

    return {
      items: finalTests,
      identifiedTopics: testScenarios,
      metadata: {
        agentsRun: agentsToRun.map(a => a.getName()),
        duration,
      },
    };
  }
}

