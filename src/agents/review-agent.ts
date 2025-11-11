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
import { AgentCoordinator, AgentTask } from '../core/agent-coordinator.js';
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
import { AgentResult, BaseAgent } from './base.js';

export interface ReviewAgentConfig {
  maxSteps: number;
  mode: 'incremental' | 'full';
  dimensions?: string[]; // 可选的审查维度，如果不指定则自动选择
  minConfidence?: number;
  autoPublish?: boolean; // 是否自动发布评论
  parallelReview?: boolean; // 是否并行审查
  maxConcurrency?: number; // 最大并发数，默认 3
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
    const dimensions: Array<[string, ReviewDimension]> = [
      [
        'react',
        {
          name: 'react',
          agent: new ReactAgent(llm, projectContextPrompt),
          applicable: (files: string[]) => files.some((f: string) => /\.(tsx?|jsx)$/.test(f)),
          description: 'React 最佳实践审查',
        },
      ],
      [
        'typescript',
        {
          name: 'typescript',
          agent: new TypeScriptAgent(llm, projectContextPrompt),
          applicable: (files: string[]) => files.some((f: string) => /\.tsx?$/.test(f)),
          description: 'TypeScript 类型安全审查',
        },
      ],
      [
        'performance',
        {
          name: 'performance',
          agent: new PerformanceAgent(llm, projectContextPrompt),
          applicable: (files: string[]) => files.some((f: string) => /\.(tsx?|jsx|vue)$/.test(f)),
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
          applicable: (files: string[]) => files.some((f: string) => /\.(tsx?|jsx|vue)$/.test(f)),
          description: '可访问性审查',
        },
      ],
      [
        'css',
        {
          name: 'css',
          agent: new CSSAgent(llm, projectContextPrompt),
          applicable: (files: string[]) => files.some((f: string) => /\.(css|scss|less|vue)$/.test(f)),
          description: 'CSS 规范审查',
        },
      ],
      [
        'i18n',
        {
          name: 'i18n',
          agent: new I18nAgent(llm, projectContextPrompt),
          applicable: (files: string[]) => files.some((f: string) => /\.(tsx?|jsx|vue)$/.test(f)),
          description: '国际化审查',
        },
      ],
    ];
    this.dimensions = new Map(dimensions);
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
   * 执行审查（使用 AgentCoordinator 进行并发控制）
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
      maxConcurrency: config.maxConcurrency,
    });

    const reviewContext = {
      diff: diff.numberedRaw || diff.raw,
      files: diff.files.map((f) => ({
        path: f.path,
        content: f.hunks.map((h) => h.lines.join('\n')).join('\n'),
      })),
    };

    const allIssues: Issue[] = [];

    if (config.parallelReview !== false) {
      // 使用 AgentCoordinator 进行并行执行（带并发控制）
      this.addThought(context, {
        content: `Executing ${dimensions.length} dimensions in parallel with max concurrency ${config.maxConcurrency || 3}`,
        timestamp: Date.now(),
      });

      const coordinator = new AgentCoordinator<typeof reviewContext, AgentResult<Issue>>(
        this.contextStore,
        {
          maxConcurrency: config.maxConcurrency || 3,
          continueOnError: true,
          retryOnError: true,
          maxRetries: 2,
        }
      );

      const tasks: AgentTask<typeof reviewContext, AgentResult<Issue>>[] = dimensions.map((dimension) => ({
        id: dimension.name,
        name: dimension.name,
        agent: dimension.agent,
        input: reviewContext,
        priority: dimension.name === 'security' ? 10 : 5, // 安全审查优先级最高
      }));

      const result = await coordinator.executeParallel(tasks);

      // 合并结果
      for (const taskResult of result.results) {
        if (taskResult.success && taskResult.output) {
          allIssues.push(...taskResult.output.items);
        }
      }

      logger.info('[ReviewAgent] Parallel review completed', {
        successCount: result.successCount,
        errorCount: result.errorCount,
        totalIssues: allIssues.length,
      });
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

    // ✅ 步骤1: 跨维度去重
    const deduplicatedIssues = this.deduplicateIssuesAcrossDimensions(allIssues);
    logger.info('[ReviewAgent] Cross-dimension deduplication completed', {
      before: allIssues.length,
      after: deduplicatedIssues.length,
      removed: allIssues.length - deduplicatedIssues.length,
    });

    // ✅ 步骤2: 过滤低置信度的问题
    const minConfidence = config.minConfidence ?? 0.7;
    const filtered = deduplicatedIssues.filter((issue) => issue.confidence >= minConfidence);

    logger.info('[ReviewAgent] Review completed', {
      totalIssues: allIssues.length,
      deduplicatedIssues: deduplicatedIssues.length,
      filteredIssues: filtered.length,
      minConfidence,
    });

    this.addThought(context, {
      content: `Found ${allIssues.length} issues, ${deduplicatedIssues.length} after deduplication, ${filtered.length} after filtering (min confidence: ${minConfidence})`,
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

  /**
   * 跨维度去重：移除不同维度报告的相同问题
   * 
   * 优化策略：
   * 1. 按文件+代码片段分组（更精确的定位）
   * 2. 对每组内的问题计算综合相似度（message + suggestion）
   * 3. 相似度 > 85% 认为是重复（更严格的阈值）
   * 4. 保留置信度最高的问题
   */
  private deduplicateIssuesAcrossDimensions(issues: Issue[]): Issue[] {
    if (issues.length === 0) return issues;

    // 按文件+代码片段分组
    const groups = new Map<string, Issue[]>();
    
    for (const issue of issues) {
      const location = this.generateIssueLocationKey(issue);
      
      if (!groups.has(location)) {
        groups.set(location, []);
      }
      groups.get(location)!.push(issue);
    }

    const deduplicated: Issue[] = [];

    // 对每组进行去重
    for (const [location, groupIssues] of groups.entries()) {
      if (groupIssues.length === 1) {
        deduplicated.push(groupIssues[0]);
        continue;
      }

      // 多个问题，需要去重
      const processed = new Set<number>();
      
      for (let i = 0; i < groupIssues.length; i++) {
        if (processed.has(i)) continue;
        
        const duplicates: number[] = [i];
        
        // 查找所有与当前问题重复的问题
        for (let j = i + 1; j < groupIssues.length; j++) {
          if (processed.has(j)) continue;
          
          const similarity = this.calculateIssueSimilarity(groupIssues[i], groupIssues[j]);
          
          if (similarity > 0.85) {
            duplicates.push(j);
            processed.add(j);
            
            logger.debug('[ReviewAgent] Found duplicate issue across dimensions', {
              location,
              issue1: { 
                topic: groupIssues[i].topic, 
                message: groupIssues[i].message.substring(0, 50),
                confidence: groupIssues[i].confidence 
              },
              issue2: { 
                topic: groupIssues[j].topic, 
                message: groupIssues[j].message.substring(0, 50),
                confidence: groupIssues[j].confidence
              },
              similarity: similarity.toFixed(3),
            });
          }
        }
        
        // 从重复的问题中选择最佳的（置信度最高）
        const bestIndex = duplicates.reduce((best, idx) => 
          groupIssues[idx].confidence > groupIssues[best].confidence ? idx : best
        , duplicates[0]);
        
        deduplicated.push(groupIssues[bestIndex]);
        processed.add(i);
      }
    }

    return deduplicated;
  }

  /**
   * 生成问题的位置键（用于分组）
   */
  private generateIssueLocationKey(issue: Issue): string {
    if (issue.codeSnippet) {
      const normalizedSnippet = issue.codeSnippet
        .trim()
        .replace(/\s+/g, ' ')
        .substring(0, 100);
      return `${issue.file}:${normalizedSnippet}`;
    }
    
    if (issue.line) {
      return `${issue.file}:${Math.floor(issue.line / 2) * 2}`;
    }
    
    return `${issue.file}:unknown`;
  }

  /**
   * 计算两个问题的相似度（综合考虑 message 和 suggestion）
   */
  private calculateIssueSimilarity(issue1: Issue, issue2: Issue): number {
    const messageCore1 = this.extractIssueCore(issue1.message);
    const messageCore2 = this.extractIssueCore(issue2.message);
    const suggestionCore1 = this.extractIssueCore(issue1.suggestion);
    const suggestionCore2 = this.extractIssueCore(issue2.suggestion);
    
    // 计算 message 相似度
    const messageSimilarity = this.calculateTextSimilarity(messageCore1, messageCore2);
    
    // 计算 suggestion 相似度
    const suggestionSimilarity = this.calculateTextSimilarity(suggestionCore1, suggestionCore2);
    
    // 综合相似度：message 权重 0.6，suggestion 权重 0.4
    return messageSimilarity * 0.6 + suggestionSimilarity * 0.4;
  }

  /**
   * 计算两段文本的相似度（Jaccard 相似度）
   */
  private calculateTextSimilarity(text1: string, text2: string): number {
    const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    
    if (words1.size === 0 && words2.size === 0) return 1.0;
    if (words1.size === 0 || words2.size === 0) return 0.0;
    
    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  /**
   * 提取问题的核心内容（去除格式和元数据）
   */
  private extractIssueCore(text: string): string {
    let core = text;
    
    // 去除 emoji 和格式标记
    core = core.replace(/[🚨⚠️ℹ️💡]/g, '');
    core = core.replace(/\*\*/g, '');
    core = core.replace(/`/g, '');
    
    // 去除等级、置信度、维度等元数据
    core = core.replace(/(?:CRITICAL|HIGH|MEDIUM|LOW):\s*/gi, '');
    core = core.replace(/置信度[:：]\s*\d+%/gi, '');
    core = core.replace(/维度[:：]\s*\S+/gi, '');
    
    // 去除建议前缀
    core = core.replace(/^(?:建议|suggestion)[:：]\s*/gi, '');
    
    return core.trim();
  }
}
