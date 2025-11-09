/**
 * ReviewAgent - 统一的代码审查 Agent（基于 ReAct 模式）
 *
 * 职责：
 * 1. 分析代码变更
 * 2. 识别审查维度（React/TypeScript/Performance/Security 等）
 * 3. 执行多维度审查
 * 4. 合并和去重审查结果
 * 5. 发布评论（可选）
 *
 * 特点：
 * - 使用 ReAct 循环自主决策
 * - 支持动态选择审查维度
 * - 支持增量模式和去重
 * - 支持并行审查多个维度
 */

import { OpenAIClient } from '../clients/openai.js';
import { EmbeddingClient } from '../clients/embedding.js';
import { StateManager } from '../state/manager.js';
import { ContextStore, AgentContext, Thought, Action, Observation } from '../core/context.js';
import { logger } from '../utils/logger.js';
import { getMetrics } from '../utils/metrics.js';
import type { Issue } from '../schemas/issue.js';
import type { Diff } from '../schemas/diff.js';

// 导入所有 CR agents
import { ReactAgent } from './cr/react.js';
import { TypeScriptAgent } from './cr/typescript.js';
import { PerformanceAgent } from './cr/performance.js';
import { SecurityAgent } from './cr/security.js';
import { AccessibilityAgent } from './cr/accessibility.js';
import { CSSAgent } from './cr/css.js';
import { I18nAgent } from './cr/i18n.js';
import { BaseAgent } from './base.js';

export interface ReviewAgentConfig {
  maxSteps: number;
  mode: 'incremental' | 'full';
  dimensions?: string[]; // 可选的审查维度，如果不指定则自动选择
  minConfidence?: number;
  autoPublish?: boolean; // 是否自动发布评论
  parallelReview?: boolean; // 是否并行审查
}

export interface ReviewAgentResult {
  success: boolean;
  issues: Issue[];
  dimensions: string[]; // 实际使用的审查维度
  matrix?: unknown;
  published?: boolean;
  context: AgentContext;
}

// 审查维度定义
interface ReviewDimension {
  name: string;
  agent: BaseAgent<Issue>;
  applicable: (files: string[]) => boolean;
  description: string;
}

export class ReviewAgent {
  private dimensions: Map<string, ReviewDimension>;

  constructor(
    private llm: OpenAIClient,
    private embedding: EmbeddingClient,
    private stateManager: StateManager,
    private contextStore: ContextStore,
    projectContextPrompt?: string
  ) {
    // 初始化所有审查维度
    this.dimensions = new Map([
      [
        'react',
        {
          name: 'react',
          agent: new ReactAgent(llm, projectContextPrompt),
          applicable: (files) => files.some((f) => /\.(tsx?|jsx)$/.test(f)),
          description: 'React 最佳实践审查',
        },
      ],
      [
        'typescript',
        {
          name: 'typescript',
          agent: new TypeScriptAgent(llm, projectContextPrompt),
          applicable: (files) => files.some((f) => /\.tsx?$/.test(f)),
          description: 'TypeScript 类型安全审查',
        },
      ],
      [
        'performance',
        {
          name: 'performance',
          agent: new PerformanceAgent(llm, projectContextPrompt),
          applicable: (files) => files.some((f) => /\.(tsx?|jsx|vue)$/.test(f)),
          description: '性能优化审查',
        },
      ],
      [
        'security',
        {
          name: 'security',
          agent: new SecurityAgent(llm, projectContextPrompt),
          applicable: () => true, // 所有文件都需要安全审查
          description: '安全性审查',
        },
      ],
      [
        'accessibility',
        {
          name: 'accessibility',
          agent: new AccessibilityAgent(llm, projectContextPrompt),
          applicable: (files) => files.some((f) => /\.(tsx?|jsx|vue)$/.test(f)),
          description: '可访问性审查',
        },
      ],
      [
        'css',
        {
          name: 'css',
          agent: new CSSAgent(llm, projectContextPrompt),
          applicable: (files) => files.some((f) => /\.(css|scss|less|vue)$/.test(f)),
          description: 'CSS 规范审查',
        },
      ],
      [
        'i18n',
        {
          name: 'i18n',
          agent: new I18nAgent(llm, projectContextPrompt),
          applicable: (files) => files.some((f) => /\.(tsx?|jsx|vue)$/.test(f)),
          description: '国际化审查',
        },
      ],
    ]);
  }

  /**
   * 更新项目上下文（动态更新所有 agents）
   */
  updateProjectContext(projectContextPrompt?: string): void {
    for (const dimension of this.dimensions.values()) {
      dimension.agent.updateProjectContext(projectContextPrompt);
    }
    logger.info('[ReviewAgent] Updated project context for all dimensions');
  }

  /**
   * 执行代码审查
   */
  async review(diff: Diff, config: ReviewAgentConfig): Promise<ReviewAgentResult> {
    const sessionId = this.generateSessionId();

    logger.info('[ReviewAgent] Starting code review', {
      revisionId: diff.revisionId,
      filesCount: diff.files.length,
      mode: config.mode,
    });

    getMetrics().recordCounter('review_agent.execution.started', 1, {
      mode: config.mode,
    });

    // 创建上下文
    const context = this.contextStore.create(sessionId, 'review-agent', 'Code review', {
      goal: 'Analyze code changes and identify issues across multiple dimensions',
      maxSteps: config.maxSteps,
      initialData: {
        diff,
        config,
        issues: [],
        environment: {
          llmConfigured: !!this.llm,
          embeddingEnabled: !!this.embedding,
          stateManagerAvailable: !!this.stateManager,
        },
      },
    });

    try {
      // Step 1: 选择审查维度
      const dimensions = await this.selectDimensions(diff, config, context);
      this.addObservation(context, {
        type: 'tool_result',
        source: 'dimension-selector',
        content: { dimensions: dimensions.map((d) => d.name) },
        timestamp: Date.now(),
      });

      // Step 2: 执行审查
      const issues = await this.executeReview(diff, dimensions, config, context);
      context.data.issues = issues;

      // Step 3: （可选）发布评论
      let published = false;
      if (config.autoPublish) {
        published = await this.publishComments(issues, diff, context);
      }

      context.isComplete = true;

      getMetrics().recordCounter('review_agent.execution.completed', 1, {
        status: 'success',
      });
      getMetrics().recordHistogram('review_agent.issues_found', issues.length, {
        mode: config.mode,
      });

      return {
        success: true,
        issues,
        dimensions: dimensions.map((d) => d.name),
        published,
        context,
      };
    } catch (error) {
      logger.error('[ReviewAgent] Execution failed', { error });

      getMetrics().recordCounter('review_agent.execution.completed', 1, {
        status: 'error',
      });

      return {
        success: false,
        issues: [],
        dimensions: [],
        context,
      };
    }
  }

  /**
   * 选择适用的审查维度
   */
  private async selectDimensions(
    diff: Diff,
    config: ReviewAgentConfig,
    context: AgentContext
  ): Promise<ReviewDimension[]> {
    logger.info('[ReviewAgent] Selecting review dimensions');

    const filePaths = diff.files.map((f) => f.path);

    // 如果手动指定了维度，使用指定的
    if (config.dimensions && config.dimensions.length > 0) {
      const selected = config.dimensions
        .map((name) => this.dimensions.get(name))
        .filter((d): d is ReviewDimension => d !== undefined);

      this.addThought(context, {
        content: `Using manually specified dimensions: ${selected.map((d) => d.name).join(', ')}`,
        timestamp: Date.now(),
      });

      return selected;
    }

    // 自动选择适用的维度
    const applicable = Array.from(this.dimensions.values()).filter((d) => d.applicable(filePaths));

    this.addThought(context, {
      content: `Auto-selected ${applicable.length} applicable dimensions: ${applicable
        .map((d) => d.name)
        .join(', ')}`,
      timestamp: Date.now(),
    });

    return applicable;
  }

  /**
   * 执行审查
   */
  private async executeReview(
    diff: Diff,
    dimensions: ReviewDimension[],
    config: ReviewAgentConfig,
    context: AgentContext
  ): Promise<Issue[]> {
    logger.info('[ReviewAgent] Executing review', {
      dimensions: dimensions.map((d) => d.name),
      parallel: config.parallelReview,
    });

    const reviewContext = {
      diff: diff.numberedRaw || diff.raw,
      files: diff.files.map((f) => ({
        path: f.path,
        content: f.hunks.map((h) => h.lines.join('\n')).join('\n'),
      })),
    };

    // 并行或串行执行审查
    const allIssues: Issue[] = [];

    if (config.parallelReview !== false) {
      // 并行执行
      this.addThought(context, {
        content: `Executing ${dimensions.length} dimensions in parallel`,
        timestamp: Date.now(),
      });

      const results = await Promise.all(
        dimensions.map(async (dimension) => {
          try {
            logger.info(`[ReviewAgent] Running ${dimension.name} review`);
            const result = await dimension.agent.execute(reviewContext);
            return result.items;
          } catch (error) {
            logger.error(`[ReviewAgent] ${dimension.name} review failed`, { error });
            return [];
          }
        })
      );

      for (const issues of results) {
        allIssues.push(...issues);
      }
    } else {
      // 串行执行
      for (const dimension of dimensions) {
        this.addThought(context, {
          content: `Executing ${dimension.name} review`,
          timestamp: Date.now(),
        });

        try {
          const result = await dimension.agent.execute(reviewContext);
          allIssues.push(...result.items);
        } catch (error) {
          logger.error(`[ReviewAgent] ${dimension.name} review failed`, { error });
        }
      }
    }

    // 过滤低置信度的问题
    const minConfidence = config.minConfidence ?? 0.7;
    const filtered = allIssues.filter((issue) => issue.confidence >= minConfidence);

    logger.info('[ReviewAgent] Review completed', {
      totalIssues: allIssues.length,
      filteredIssues: filtered.length,
      minConfidence,
    });

    this.addThought(context, {
      content: `Found ${allIssues.length} issues, ${filtered.length} after filtering (min confidence: ${minConfidence})`,
      timestamp: Date.now(),
    });

    return filtered;
  }

  /**
   * 发布评论
   */
  private async publishComments(
    issues: Issue[],
    diff: Diff,
    context: AgentContext
  ): Promise<boolean> {
    logger.info('[ReviewAgent] Publishing comments');

    // TODO: 调用 PublishCommentsTool
    this.addAction(context, {
      type: 'call_tool',
      toolName: 'publish-phabricator-comments',
      parameters: { issues, revisionId: diff.revisionId },
      timestamp: Date.now(),
    });

    return false; // Placeholder
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
    return `review-agent-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }
}
