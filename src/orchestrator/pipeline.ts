import pLimit from 'p-limit';
import { EmbeddingClient } from '../clients/embedding.js';
import type { Issue } from '../schemas/issue.js';
import type { TestCase } from '../schemas/test-plan.js';
import { BaseAgent } from '../agents/base.js';
import { logger } from '../utils/logger.js';

export interface FilterConfig {
  confidenceMinGlobal: number;
  scenarioConfidenceMin: Record<string, number>;
  similarityThreshold: number;
  scenarioLimits?: Record<string, number>;
}

export interface OrchestratorConfig {
  parallelAgents: boolean;
  maxConcurrency: number;
  filter: FilterConfig;
}

export class Orchestrator {
  private config: OrchestratorConfig;
  private embeddingClient?: EmbeddingClient;

  constructor(config: OrchestratorConfig, embeddingClient?: EmbeddingClient) {
    // 确保 filter 配置存在
    if (!config.filter) {
      throw new Error('Orchestrator config.filter is required');
    }
    this.config = config;
    this.embeddingClient = embeddingClient;
  }

  /**
   * 并行执行多个 Agent
   */
  async executeAgents<T>(
    agents: Array<BaseAgent<T>>,
    context: {
      diff: string;
      files: Array<{ path: string; content: string }>;
      metadata?: Record<string, unknown>;
    }
  ): Promise<Array<{ agent: string; result: { items: T[]; confidence: number } }>> {
    if (!this.config.parallelAgents || agents.length === 0) {
      return [];
    }

    const limit = pLimit(this.config.maxConcurrency);
    const tasks = agents.map(agent =>
      limit(async () => {
        try {
          const result = await agent.execute(context);
          return {
            agent: agent.getName(),
            result,
          };
        } catch (error) {
          logger.error(`Agent ${agent.getName()} failed`, { error });
          return {
            agent: agent.getName(),
            result: { items: [], confidence: 0 },
          };
        }
      })
    );

    return Promise.all(tasks);
  }

  /**
   * 聚合 CR 问题并去重
   */
  async aggregateIssues(
    agentResults: Array<{ agent: string; result: { items: Issue[]; confidence: number } }>
  ): Promise<Issue[]> {
    // 收集所有问题
    let allIssues: Issue[] = [];
    for (const { result } of agentResults) {
      allIssues.push(...result.items);
    }

    // 置信度过滤
    allIssues = this.filterByConfidence(allIssues);

    // 相似度去重
    if (this.embeddingClient) {
      allIssues = await this.deduplicateBySimilarity(allIssues);
    }

    // 排序：文件 → 严重度 → 行号
    allIssues.sort((a, b) => {
      if (a.file !== b.file) {
        return a.file.localeCompare(b.file);
      }
      const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
      const aSev = severityOrder[a.severity] || 0;
      const bSev = severityOrder[b.severity] || 0;
      if (aSev !== bSev) {
        return bSev - aSev;
      }
      return a.line - b.line;
    });

    return allIssues;
  }

  /**
   * 聚合测试用例并去重
   */
  async aggregateTests(
    agentResults: Array<{ agent: string; result: { items: TestCase[]; confidence: number } }>
  ): Promise<TestCase[]> {
    // 收集所有测试
    let allTests: TestCase[] = [];
    for (const { result } of agentResults) {
      allTests.push(...result.items);
    }

    // 置信度过滤
    allTests = this.filterTestsByConfidence(allTests);

    // 按场景分组并应用限额
    const byScenario: Record<string, TestCase[]> = {};
    for (const test of allTests) {
      const scenario = test.scenario;
      if (!byScenario[scenario]) {
        byScenario[scenario] = [];
      }
      byScenario[scenario].push(test);
    }

    // 对每个场景应用限额和排序
    const filtered: TestCase[] = [];
    for (const [scenario, tests] of Object.entries(byScenario)) {
      const limit = this.config.filter.scenarioLimits?.[scenario] || 10;
      const sorted = tests.sort((a, b) => {
        // 按置信度排序
        return b.confidence - a.confidence;
      });
      filtered.push(...sorted.slice(0, limit));
    }

    return filtered;
  }

  /**
   * 按置信度过滤问题
   */
  private filterByConfidence(issues: Issue[]): Issue[] {
    const { confidenceMinGlobal, scenarioConfidenceMin } = this.config.filter;

    return issues.filter(issue => {
      const minConfidence = scenarioConfidenceMin[issue.severity] || confidenceMinGlobal;
      return issue.confidence >= minConfidence;
    });
  }

  /**
   * 按置信度过滤测试
   */
  private filterTestsByConfidence(tests: TestCase[]): TestCase[] {
    const { confidenceMinGlobal, scenarioConfidenceMin } = this.config.filter;

    return tests.filter(test => {
      const minConfidence = scenarioConfidenceMin[test.scenario] || confidenceMinGlobal;
      return test.confidence >= minConfidence;
    });
  }

  /**
   * 基于相似度去重
   */
  private async deduplicateBySimilarity(issues: Issue[]): Promise<Issue[]> {
    if (!this.embeddingClient || issues.length <= 1) {
      return issues;
    }

    const messages = issues.map(issue => `${issue.message} ${issue.suggestion}`).filter(m => m.trim());
    if (messages.length === 0) {
      return issues;
    }

    try {
      const embeddings = await this.embeddingClient.encode(messages);
      const keepIndices: number[] = [];

      for (let i = 0; i < issues.length; i++) {
        let isDuplicate = false;

        for (const j of keepIndices) {
          const similarity = this.embeddingClient.cosineSimilarity(embeddings[i], embeddings[j]);
          if (similarity > this.config.filter.similarityThreshold) {
            // 相似，保留置信度更高的
            if (issues[i].confidence > issues[j].confidence) {
              const index = keepIndices.indexOf(j);
              keepIndices.splice(index, 1);
              keepIndices.push(i);
            }
            isDuplicate = true;
            break;
          }
        }

        if (!isDuplicate) {
          keepIndices.push(i);
        }
      }

      return keepIndices.map(i => issues[i]);
    } catch (error) {
      logger.warn('Failed to deduplicate by similarity', { error });
      return issues;
    }
  }
}

