/**
 * PublishPhabricatorCommentsTool - 发布评论到 Phabricator
 *
 * 职责：
 * 1. 将代码审查结果发布为 inline comments
 * 2. 去重已存在的评论
 * 3. 支持批量发布
 */

import { z } from 'zod';
import { BaseTool, ToolMetadata } from '../core/base-tool.js';
import { PhabricatorClient } from '../clients/phabricator.js';
import { logger } from '../utils/logger.js';
import type { Issue } from '../schemas/issue.js';
import { getEnv } from '../config/env.js';

// Zod schema for PublishPhabricatorCommentsInput
export const PublishPhabricatorCommentsInputSchema = z.object({
  revisionId: z.string().describe('REQUIRED. Phabricator Revision ID (e.g., "D551414" or "D12345"). Extract from user message patterns like "publish comments for D12345" or "发布 D12345 的评论". If user provides only numbers, add "D" prefix.'),
  issues: z.array(z.any()).describe('代码审查问题列表'),
  message: z.string().optional().describe('主评论内容（可选，默认自动生成）'),
  dryRun: z.boolean().optional().describe('预览模式，不实际发布（默认 false）'),
});

export interface PublishPhabricatorCommentsInput {
  revisionId: string;
  issues: Issue[];
  message?: string; // 主评论内容（默认自动生成）
  dryRun?: boolean; // 预览模式，不实际发布（默认 false）
}

export interface PublishPhabricatorCommentsOutput {
  revisionId: string;
  published: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  summary: {
    byLevel: Record<string, number>;
    byTopic: Record<string, number>;
  };
}

export class PublishPhabricatorCommentsTool extends BaseTool<
  PublishPhabricatorCommentsInput,
  PublishPhabricatorCommentsOutput
> {
  constructor(private phabricator: PhabricatorClient) {
    super();
  }

  // Expose Zod schema for FastMCP
  getZodSchema() {
    return PublishPhabricatorCommentsInputSchema;
  }

  getMetadata(): ToolMetadata {
    return {
      name: 'publish-phabricator-comments',
      description:
        '将代码审查问题发布为 Phabricator inline comments。\n\n' +
        '💡 特性：\n' +
        '• 自动去重已存在的评论\n' +
        '• 支持批量发布\n' +
        '• 支持预览模式（dryRun）\n' +
        '• 自动生成汇总评论\n\n' +
        '⚠️ 注意：\n' +
        '• 需要设置 ALLOW_PUBLISH_COMMENTS=true 才能实际发布\n' +
        '• 默认为预览模式，设置 dryRun=false 才会实际发布',
      inputSchema: {
        type: 'object',
        properties: {
          revisionId: {
            type: 'string',
            description: 'Phabricator Revision ID，必须以 D 开头后跟数字（如 D551414 或 D12345）。如果用户只提供数字（如 12345），请自动添加 D 前缀。支持从用户消息中提取，例如"publish comments for D12345"或"发布 D12345 的评论"',
          },
          issues: {
            type: 'array',
            items: { type: 'object' },
            description: '代码审查问题列表',
          },
          message: {
            type: 'string',
            description: '主评论内容（可选，默认自动生成）',
          },
          dryRun: {
            type: 'boolean',
            description: '预览模式，不实际发布（默认 false）',
          },
        },
        required: ['revisionId', 'issues'],
      },
      category: 'phabricator',
      version: '3.0.0',
    };
  }

  protected async executeImpl(
    input: PublishPhabricatorCommentsInput
  ): Promise<PublishPhabricatorCommentsOutput> {
    const { revisionId, issues, message, dryRun = false } = input;

    // 检查安全开关
    const allowPublishEnv = getEnv().ALLOW_PUBLISH_COMMENTS;
    const normalizedAllowPublish = allowPublishEnv?.trim().toLowerCase() ?? 'false';
    const allowPublish = normalizedAllowPublish === 'true' || normalizedAllowPublish === '1';
    const actualDryRun = dryRun || !allowPublish;

    logger.info('[PublishPhabricatorCommentsTool] Publishing configuration', {
      allowPublishEnv,
      normalizedAllowPublish,
      allowPublish,
      dryRunInput: dryRun,
      actualDryRun,
      issuesCount: issues.length,
    });

    if (!allowPublish && !dryRun) {
      logger.warn(
        '[PublishPhabricatorCommentsTool] ALLOW_PUBLISH_COMMENTS is not enabled, falling back to dry-run mode',
        { envValue: allowPublishEnv }
      );
    }

    if (actualDryRun) {
      logger.info('[PublishPhabricatorCommentsTool] Running in dry-run mode, no comments will be published');
    }

    // 统计信息
    let published = 0;
    let skipped = 0;
    let failed = 0;
    const byLevel: Record<string, number> = {};
    const byTopic: Record<string, number> = {};

    // 获取已存在的评论（用于去重）
    let existingComments: Array<{ file: string; line: number; content: string }> = [];
    try {
      const inlines = await this.phabricator.getExistingInlines(revisionId);
      existingComments = inlines.map((c) => ({
        file: c.file,
        line: c.line,
        content: c.content,
      }));
      logger.info('[PublishPhabricatorCommentsTool] Found existing comments', {
        count: existingComments.length,
      });
    } catch (error) {
      logger.warn('[PublishPhabricatorCommentsTool] Failed to get existing comments', { error });
    }

    // 发布每个问题
    for (const issue of issues) {
      // 统计
      byLevel[issue.severity] = (byLevel[issue.severity] || 0) + 1;
      byTopic[issue.topic] = (byTopic[issue.topic] || 0) + 1;

      // 检查是否已存在相同评论（去重）
      if (issue.line) {
        const isDuplicate = existingComments.some(
          (c) => c.file === issue.file && c.line === issue.line && c.content.includes(issue.message)
        );

        if (isDuplicate) {
          logger.debug('[PublishPhabricatorCommentsTool] Skipping duplicate comment', {
            file: issue.file,
            line: issue.line,
          });
          skipped++;
          continue;
        }
      }

      // 格式化评论内容
      const commentContent = this.formatIssueComment(issue);

      // 实际发布或预览
      if (!actualDryRun && issue.line) {
        try {
          logger.debug('[PublishPhabricatorCommentsTool] Publishing inline comment', {
            revisionId,
            file: issue.file,
            line: issue.line,
            severity: issue.severity,
          });
          
          await this.phabricator.createInline(
            revisionId,
            issue.file,
            true, // isNewFile
            issue.line,
            commentContent
          );
          published++;
          logger.info('[PublishPhabricatorCommentsTool] Successfully published comment', {
            file: issue.file,
            line: issue.line,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorStack = error instanceof Error ? error.stack : undefined;
          logger.error('[PublishPhabricatorCommentsTool] Failed to publish comment', {
            file: issue.file,
            line: issue.line,
            error: errorMessage,
            stack: errorStack,
          });
          failed++;
        }
      } else if (!issue.line) {
        logger.warn('[PublishPhabricatorCommentsTool] Skipping issue without line number', {
          file: issue.file,
          message: issue.message.substring(0, 100),
        });
        skipped++;
      } else {
        // 预览模式
        logger.info('[PublishPhabricatorCommentsTool] [DRY-RUN] Would publish comment', {
          file: issue.file,
          line: issue.line,
          content: commentContent.substring(0, 100),
        });
        published++;
      }
    }

    // 提交主评论（包含汇总）
    if (!actualDryRun && published > 0) {
      const summaryMessage = message || this.generateSummaryMessage(issues, published, skipped, failed);
      try {
        await this.phabricator.submitComments(revisionId, summaryMessage, true);
        logger.info('[PublishPhabricatorCommentsTool] Published summary comment');
      } catch (error) {
        logger.error('[PublishPhabricatorCommentsTool] Failed to publish summary comment', { error });
      }
    }

    logger.info('[PublishPhabricatorCommentsTool] Publishing completed', {
      published,
      skipped,
      failed,
      dryRun: actualDryRun,
    });

    return {
      revisionId,
      published,
      skipped,
      failed,
      dryRun: actualDryRun,
      summary: {
        byLevel,
        byTopic,
      },
    };
  }

  private formatIssueComment(issue: Issue): string {
    const severityEmoji = {
      critical: '🚨',
      high: '⚠️',
      medium: 'ℹ️',
      low: '💡',
    }[issue.severity] || 'ℹ️';

    return (
      `${severityEmoji} **${issue.severity.toUpperCase()}**: ${issue.message}\n\n` +
      `**建议**: ${issue.suggestion}\n\n` +
      `**置信度**: ${(issue.confidence * 100).toFixed(0)}%\n` +
      `**维度**: ${issue.topic}`
    );
  }

  private generateSummaryMessage(
    issues: Issue[],
    published: number,
    skipped: number,
    failed: number
  ): string {
    const criticalCount = issues.filter((i) => i.severity === 'critical').length;
    const highCount = issues.filter((i) => i.severity === 'high').length;
    const mediumCount = issues.filter((i) => i.severity === 'medium').length;
    const lowCount = issues.filter((i) => i.severity === 'low').length;

    let summary = '## 🤖 AI 代码审查报告\n\n';
    summary += `共发现 **${issues.length}** 个问题：\n\n`;

    if (criticalCount > 0) summary += `- 🚨 严重: ${criticalCount}\n`;
    if (highCount > 0) summary += `- ⚠️ 高: ${highCount}\n`;
    if (mediumCount > 0) summary += `- ℹ️ 中: ${mediumCount}\n`;
    if (lowCount > 0) summary += `- 💡 低: ${lowCount}\n`;

    summary += `\n发布状态：${published} 已发布`;
    if (skipped > 0) summary += `, ${skipped} 已跳过`;
    if (failed > 0) summary += `, ${failed} 失败`;

    summary += '\n\n请查看上方的 inline comments 了解详情。';

    return summary;
  }
}
