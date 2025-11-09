/**
 * ReviewFrontendDiffTool - 封装 ReviewAgent 为 MCP 工具
 *
 * 职责：
 * 1. 从 Phabricator 获取 diff
 * 2. 调用 ReviewAgent 执行多维度代码审查
 * 3. 可选发布评论到 Phabricator
 */

import { BaseTool, ToolMetadata } from '../core/base-tool.js';
import { ReviewAgent, ReviewAgentConfig } from '../agents/review-agent.js';
import { FetchDiffTool } from './fetch-diff.js';
import { OpenAIClient } from '../clients/openai.js';
import { EmbeddingClient } from '../clients/embedding.js';
import { StateManager } from '../state/manager.js';
import { ContextStore } from '../core/context.js';
import { logger } from '../utils/logger.js';
import type { Issue } from '../schemas/issue.js';

export interface ReviewFrontendDiffInput {
  revisionId: string;
  dimensions?: string[]; // 手动指定审查维度（可选）
  mode?: 'incremental' | 'full'; // 增量或全量模式（默认 incremental）
  publish?: boolean; // 是否发布评论到 Phabricator（默认 false）
  forceRefresh?: boolean; // 强制刷新缓存（默认 false）
  minConfidence?: number; // 最小置信度阈值（默认 0.7）
  projectRoot?: string; // 项目根目录（用于加载项目 prompt）
}

export interface ReviewFrontendDiffOutput {
  revisionId: string;
  dimensions: string[];
  issues: Issue[];
  publishedToPhab: boolean;
  summary: {
    totalIssues: number;
    byLevel: Record<string, number>;
    byTopic: Record<string, number>;
  };
}

export class ReviewFrontendDiffTool extends BaseTool<ReviewFrontendDiffInput, ReviewFrontendDiffOutput> {
  constructor(
    private openai: OpenAIClient,
    private embedding: EmbeddingClient,
    private stateManager: StateManager,
    private contextStore: ContextStore,
    private fetchDiffTool: FetchDiffTool
  ) {
    super();
  }

  getMetadata(): ToolMetadata {
    return {
      name: 'review-frontend-diff',
      description:
        '对前端代码变更进行多维度智能审查，支持自动识别审查主题并生成评论。\n\n' +
        '🔍 审查维度：\n' +
        '• React 最佳实践\n' +
        '• TypeScript 类型安全\n' +
        '• 性能优化\n' +
        '• 安全性检查\n' +
        '• 可访问性（a11y）\n' +
        '• CSS/样式规范\n' +
        '• 国际化（i18n）\n' +
        '• 测试建议\n\n' +
        '💡 特性：\n' +
        '• 自动识别需要审查的主题\n' +
        '• 多 Agent 并行执行\n' +
        '• 增量去重，避免重复评论\n' +
        '• 智能合并同行评论\n' +
        '• 可选自动发布到 Phabricator\n\n' +
        '📝 行号说明：\n' +
        '• diff 中所有新行都以 NEW_LINE_XX 开头\n' +
        '• 删除的行标记为 DELETED (was line XX)\n' +
        '• 发布评论时使用 NEW_LINE_XX 对应的新文件行号',
      inputSchema: {
        type: 'object',
        properties: {
          revisionId: {
            type: 'string',
            description: 'Revision ID（如 D551414）',
          },
          dimensions: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['react', 'typescript', 'performance', 'security', 'accessibility', 'css', 'i18n'],
            },
            description: '手动指定审查维度（可选）',
          },
          mode: {
            type: 'string',
            enum: ['incremental', 'full'],
            description: '增量或全量模式（默认 incremental）',
          },
          publish: {
            type: 'boolean',
            description: '是否发布评论到 Phabricator（默认 false）',
          },
          forceRefresh: {
            type: 'boolean',
            description: '强制刷新缓存（默认 false）',
          },
          minConfidence: {
            type: 'number',
            description: '最小置信度阈值，范围 0-1（默认 0.7）',
          },
          projectRoot: {
            type: 'string',
            description: '项目根目录绝对路径（用于加载项目特定的审查规则）',
          },
        },
        required: ['revisionId'],
      },
      category: 'code-review',
      version: '3.0.0',
    };
  }

  protected async executeImpl(input: ReviewFrontendDiffInput): Promise<ReviewFrontendDiffOutput> {
    const {
      revisionId,
      dimensions,
      mode = 'incremental',
      publish = false,
      forceRefresh = false,
      minConfidence = 0.7,
      projectRoot,
    } = input;

    // 1. 获取 diff
    logger.info(`[ReviewFrontendDiffTool] Fetching diff for ${revisionId}...`);
    const diffResult = await this.fetchDiffTool.fetch({ revisionId, forceRefresh });
    const diff = this.fetchDiffTool.filterFrontendFiles(diffResult);

    if (diff.files.length === 0) {
      logger.info(`[ReviewFrontendDiffTool] No frontend files in ${revisionId}`);
      return {
        revisionId,
        dimensions: [],
        issues: [],
        publishedToPhab: false,
        summary: {
          totalIssues: 0,
          byLevel: {},
          byTopic: {},
        },
      };
    }

    // 2. 创建 ReviewAgent
    const reviewAgent = new ReviewAgent(
      this.openai,
      this.embedding,
      this.stateManager,
      this.contextStore
    );

    // 3. 执行审查
    logger.info(`[ReviewFrontendDiffTool] Starting review...`, {
      mode,
      dimensions: dimensions || 'auto',
      minConfidence,
      projectRoot,
    });

    // 3.1 如果提供了项目根目录，加载项目特定的 prompt
    if (projectRoot) {
      // TODO: 从 projectRoot 加载项目特定的审查规则
      // 可以使用 loadRepoPrompt 工具
    }

    const config: ReviewAgentConfig = {
      maxSteps: 10,
      mode,
      dimensions,
      minConfidence,
      autoPublish: publish,
      parallelReview: true,
      maxConcurrency: 3,
    };

    const result = await reviewAgent.review(diff, config);

    if (!result.success) {
      throw new Error(`Review failed`);
    }

    // 4. 生成统计摘要
    const summary = this.generateSummary(result.issues);

    logger.info(`[ReviewFrontendDiffTool] Review completed`, {
      totalIssues: result.issues.length,
      dimensions: result.dimensions,
      published: result.published,
    });

    return {
      revisionId,
      dimensions: result.dimensions,
      issues: result.issues,
      publishedToPhab: result.published ?? false,
      summary,
    };
  }

  protected async beforeExecute(input: ReviewFrontendDiffInput): Promise<void> {
    // 验证输入
    if (!input.revisionId || !input.revisionId.match(/^D\d+$/i)) {
      throw new Error(`Invalid revision ID: ${input.revisionId}`);
    }

    if (input.minConfidence !== undefined && (input.minConfidence < 0 || input.minConfidence > 1)) {
      throw new Error(`minConfidence must be between 0 and 1, got: ${input.minConfidence}`);
    }

    if (input.publish) {
      logger.warn('[ReviewFrontendDiffTool] Auto-publish is enabled, comments will be posted to Phabricator');
    }
  }

  private generateSummary(issues: Issue[]): {
    totalIssues: number;
    byLevel: Record<string, number>;
    byTopic: Record<string, number>;
  } {
    const byLevel: Record<string, number> = {};
    const byTopic: Record<string, number> = {};

    for (const issue of issues) {
      // 按严重程度统计
      byLevel[issue.severity] = (byLevel[issue.severity] || 0) + 1;

      // 按主题统计
      const topic = issue.topic || (issue as any).metadata?.topic;
      if (topic) {
        byTopic[topic] = (byTopic[topic] || 0) + 1;
      }
    }

    return {
      totalIssues: issues.length,
      byLevel,
      byTopic,
    };
  }
}
