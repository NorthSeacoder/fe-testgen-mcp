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
import { EmbeddingClient } from '../clients/embedding.js';
import { logger } from '../utils/logger.js';
import type { Issue } from '../schemas/issue.js';
import { getEnv } from '../config/env.js';
import { CommentDeduplicator } from '../utils/comment-dedup.js';
import { parseDiff, findLineNumberByCodeSnippet } from '../utils/diff-parser.js';

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
  private deduplicator: CommentDeduplicator | null = null;

  constructor(
    private phabricator: PhabricatorClient,
    private embedding?: EmbeddingClient | null
  ) {
    super();
    // 初始化去重器（如果 embedding 可用）
    if (this.embedding) {
      this.deduplicator = new CommentDeduplicator(this.embedding, {
        signaturePrefixLength: 100,
        similarityThreshold: 0.90,
        enableEmbedding: true,
      });
    }
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

    // 获取 diff 数据（用于 codeSnippet 解析）
    let diffData: ReturnType<typeof parseDiff> | null = null;
    try {
      const diffResult = await this.phabricator.getDiffWithContext(revisionId, 5);
      diffData = parseDiff(diffResult.raw, revisionId);
      logger.info('[PublishPhabricatorCommentsTool] Loaded diff for code snippet matching', {
        filesCount: diffData.files.length,
      });
    } catch (error) {
      logger.warn('[PublishPhabricatorCommentsTool] Failed to load diff for code snippet matching', { error });
    }

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

    // 初始化去重器并加载已有评论
    if (this.deduplicator && existingComments.length > 0) {
      try {
        await this.deduplicator.loadExisting(existingComments);
        logger.info('[PublishPhabricatorCommentsTool] Loaded existing comments into deduplicator', {
          count: existingComments.length,
        });
      } catch (error) {
        logger.warn('[PublishPhabricatorCommentsTool] Failed to load existing comments into deduplicator', { error });
      }
    }

    // 发布每个问题
    for (const issue of issues) {
      // 统计
      byLevel[issue.severity] = (byLevel[issue.severity] || 0) + 1;
      byTopic[issue.topic] = (byTopic[issue.topic] || 0) + 1;

      // 🔧 解析行号和文件定位：优先使用 issue.line，如果没有则从 codeSnippet 解析
      let lineNumber = issue.line;
      let isNewFile = true; // 默认评论在新文件上
      let isDeletedLine = false; // 标记是否是删除的行
      
      if (!lineNumber && issue.codeSnippet && diffData) {
        const file = diffData.files.find(f => f.path === issue.file);
        if (file) {
          const resolvedLine = findLineNumberByCodeSnippet(file, issue.codeSnippet, {
            fuzzyMatch: true,
            preferAddedLines: true,
          });
          if (resolvedLine) {
            lineNumber = resolvedLine;
            logger.info('[PublishPhabricatorCommentsTool] Resolved line number from code snippet', {
              file: issue.file,
              codeSnippet: issue.codeSnippet.substring(0, 50),
              resolvedLine,
            });
          } else {
            logger.warn('[PublishPhabricatorCommentsTool] Failed to resolve line number from code snippet', {
              file: issue.file,
              codeSnippet: issue.codeSnippet.substring(0, 50),
            });
          }
        } else {
          logger.warn('[PublishPhabricatorCommentsTool] File not found in diff for code snippet matching', {
            file: issue.file,
            availableFiles: diffData.files.map(f => f.path),
          });
        }
      }
      
      // 🔧 检测是否是删除的行（通过 codeSnippet 判断）
      if (issue.codeSnippet && diffData) {
        const file = diffData.files.find(f => f.path === issue.file);
        if (file) {
          // 检查 codeSnippet 是否只出现在删除的行中
          isDeletedLine = this.isCodeSnippetInDeletedLines(file, issue.codeSnippet);
          if (isDeletedLine) {
            isNewFile = false; // 如果是删除的行，评论应该在旧文件上
            logger.info('[PublishPhabricatorCommentsTool] Detected deleted line, will comment on old file', {
              file: issue.file,
              codeSnippet: issue.codeSnippet.substring(0, 50),
            });
            
            // 对于删除的行，需要找到旧文件中的行号
            const oldLineNumber = this.findOldLineNumber(file, issue.codeSnippet);
            if (oldLineNumber) {
              lineNumber = oldLineNumber;
              logger.info('[PublishPhabricatorCommentsTool] Resolved old line number for deleted line', {
                file: issue.file,
                oldLineNumber,
              });
            }
          }
        }
      }

      // 如果还是没有行号，跳过
      if (!lineNumber) {
        logger.warn('[PublishPhabricatorCommentsTool] Skipping issue without line number', {
          file: issue.file,
          message: issue.message.substring(0, 100),
          hasCodeSnippet: !!issue.codeSnippet,
          codeSnippet: issue.codeSnippet?.substring(0, 50),
          hasDiffData: !!diffData,
        });
        skipped++;
        continue;
      }

      // 检查是否已存在相同评论（去重）
      if (lineNumber) {
        let isDuplicate = false;
        let duplicateReason: string | undefined;

        if (this.deduplicator) {
          // 使用 CommentDeduplicator 进行智能去重
          try {
            const result = await this.deduplicator.isDuplicate({
              file: issue.file,
              line: lineNumber,
              message: issue.message,
            });
            isDuplicate = result.isDuplicate;
            duplicateReason = result.reason;
          } catch (error) {
            logger.warn('[PublishPhabricatorCommentsTool] Failed to check duplicate using deduplicator', {
              file: issue.file,
              line: lineNumber,
              error,
            });
            // 降级到简单检查
            isDuplicate = existingComments.some(
              (c) => c.file === issue.file && c.line === lineNumber && c.content.includes(issue.message)
            );
          }
        } else {
          // 降级到简单检查（如果没有 embedding 客户端）
          isDuplicate = existingComments.some(
            (c) => c.file === issue.file && c.line === lineNumber && c.content.includes(issue.message)
          );
        }

        if (isDuplicate) {
          logger.debug('[PublishPhabricatorCommentsTool] Skipping duplicate comment', {
            file: issue.file,
            line: lineNumber,
            reason: duplicateReason || 'simple-check',
          });
          skipped++;
          continue;
        }
      }

      // 格式化评论内容
      const commentContent = this.formatIssueComment(issue);

      // 实际发布或预览
      if (!actualDryRun) {
        try {
          logger.debug('[PublishPhabricatorCommentsTool] Publishing inline comment', {
            revisionId,
            file: issue.file,
            line: lineNumber,
            severity: issue.severity,
          });
          
          await this.phabricator.createInline(
            revisionId,
            issue.file,
            isNewFile, // 动态判断是新文件还是旧文件
            lineNumber,
            commentContent
          );
          published++;
          logger.info('[PublishPhabricatorCommentsTool] Successfully published comment', {
            file: issue.file,
            line: lineNumber,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorStack = error instanceof Error ? error.stack : undefined;
          logger.error('[PublishPhabricatorCommentsTool] Failed to publish comment', {
            file: issue.file,
            line: lineNumber,
            error: errorMessage,
            stack: errorStack,
          });
          failed++;
        }
      } else {
        // 预览模式
        logger.info('[PublishPhabricatorCommentsTool] [DRY-RUN] Would publish comment', {
          file: issue.file,
          line: lineNumber,
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

  /**
   * 检测代码片段是否只出现在删除的行中
   */
  private isCodeSnippetInDeletedLines(file: ReturnType<typeof parseDiff>['files'][0], codeSnippet: string): boolean {
    const normalized = codeSnippet.trim();
    if (!normalized) return false;
    
    let foundInDeleted = false;
    let foundInAddedOrContext = false;
    
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        const lineContent = line.replace(/^[+\-\s]/, '').trim();
        
        if (line.startsWith('-') && !line.startsWith('---')) {
          // 删除的行
          if (lineContent.includes(normalized) || normalized.includes(lineContent)) {
            foundInDeleted = true;
          }
        } else if ((line.startsWith('+') && !line.startsWith('+++')) || 
                   (!line.startsWith('-') && !line.startsWith('+') && !line.startsWith('@') && !line.startsWith('\\'))) {
          // 新增的行或上下文行
          if (lineContent.includes(normalized) || normalized.includes(lineContent)) {
            foundInAddedOrContext = true;
          }
        }
      }
    }
    
    // 只有在删除的行中找到，且没有在新增或上下文行中找到时，才认为是删除的行
    return foundInDeleted && !foundInAddedOrContext;
  }
  
  /**
   * 查找代码片段在旧文件中的行号
   */
  private findOldLineNumber(file: ReturnType<typeof parseDiff>['files'][0], codeSnippet: string): number | null {
    const normalized = codeSnippet.trim();
    if (!normalized) return null;
    
    for (const hunk of file.hunks) {
      let oldLineNum = hunk.oldStart;
      
      for (const line of hunk.lines) {
        const lineContent = line.replace(/^[+\-\s]/, '').trim();
        
        if (line.startsWith('-') && !line.startsWith('---')) {
          // 删除的行
          if (lineContent.includes(normalized) || normalized.includes(lineContent)) {
            return oldLineNum;
          }
          oldLineNum++;
        } else if (!line.startsWith('+') && !line.startsWith('@') && !line.startsWith('\\')) {
          // 上下文行（两边都有）
          oldLineNum++;
        }
      }
    }
    
    return null;
  }
}
