import { PhabricatorClient } from '../clients/phabricator.js';
import { StateManager } from '../state/manager.js';
import type { PublishCommentsInput, PublishCommentsOutput } from '../schemas/tool-io.js';
import type { DiffFile } from '../schemas/diff.js';
import { logger } from '../utils/logger.js';
import { CommentDeduplicator } from '../utils/comment-dedup.js';
import type { EmbeddingClient } from '../clients/embedding.js';

export class PublishCommentsTool {
  constructor(
    private phabClient: PhabricatorClient,
    private stateManager: StateManager,
    private embeddingClient: EmbeddingClient | null = null
  ) {}

  async publish(input: PublishCommentsInput & { fileMap?: Map<string, DiffFile> }): Promise<PublishCommentsOutput> {
    const { revisionId, comments, message, incremental = true, fileMap } = input;

    const details: Array<{ issueId: string; status: 'published' | 'skipped' | 'failed'; error?: string; reason?: string }> = [];
    let published = 0;
    let skipped = 0;
    let failed = 0;

    // ✅ 增量模式：使用混合去重策略
    let commentsToPublish = comments;
    if (incremental) {
      try {
        logger.info('Incremental mode: checking for duplicate comments...');
        
        // 1. 获取 Phabricator 上已有的 inline comments
        const existingInlines = await this.phabClient.getExistingInlines(revisionId);
        logger.info(`Found ${existingInlines.length} existing inline comments on Phabricator`);
        
        if (existingInlines.length > 0) {
          // 2. 转换为统一格式
          const existingComments = existingInlines.map(inline => ({
            file: inline.file || '',
            line: inline.line || 0,
            content: inline.content || '',
          })).filter(c => c.file && c.line);
          
          // 3. 使用去重器过滤
          const deduplicator = new CommentDeduplicator(this.embeddingClient, {
            signaturePrefixLength: 100,
            similarityThreshold: 0.90, // 90% 相似度认为是重复
            enableEmbedding: !!this.embeddingClient, // 只有在提供了 embedding client 时才启用
          });
          
          await deduplicator.loadExisting(existingComments);
          
          const { unique, duplicates } = await deduplicator.filterDuplicates(
            comments.map(c => ({
              file: this.normalizeFilePath(c.file),
              line: c.line,
              message: c.message,
            }))
          );
          
          // 4. 记录跳过的评论
          for (let i = 0; i < comments.length; i++) {
            const comment = comments[i];
            const dup = duplicates.find(d => 
              this.normalizeFilePath(d.file) === this.normalizeFilePath(comment.file) && 
              d.line === comment.line
            );
            
            if (dup) {
              const issueIds = comment.issueId.split(',').map(id => id.trim());
              for (const issueId of issueIds) {
                details.push({
                  issueId,
                  status: 'skipped',
                  reason: dup.reason === 'signature' 
                    ? 'Duplicate (exact match)' 
                    : `Duplicate (${(dup.similarity! * 100).toFixed(1)}% similar)`,
                });
                skipped++;
              }
              
              // 标记为已发布（避免下次再发布）
              for (const issueId of issueIds) {
                await this.stateManager.markIssuePublished(revisionId, issueId);
              }
            }
          }
          
          // 5. 只保留不重复的评论
          commentsToPublish = comments.filter(c => 
            unique.some(u => 
              this.normalizeFilePath(u.file) === this.normalizeFilePath(c.file) && 
              u.line === c.line
            )
          );
          
          logger.info(
            `Deduplication complete: ${commentsToPublish.length} unique, ${duplicates.length} duplicates ` +
            `(${duplicates.filter(d => d.reason === 'signature').length} exact, ` +
            `${duplicates.filter(d => d.reason === 'embedding').length} similar)`
          );
        }
      } catch (error) {
        logger.warn('Failed to check for duplicates, will publish all comments', { error });
        // 失败时继续发布所有评论，不影响主流程
      }
    }

    // 创建 inline comments
    for (const comment of commentsToPublish) {
      // 解析 issueId（可能是逗号分隔的多个 ID）
      const issueIds = comment.issueId.split(',').map(id => id.trim());

      try {
        // 规范化文件路径
        const normalizedPath = this.normalizeFilePath(comment.file);
        
        // ✅ 修复：始终使用新文件的行号（isNewFile=true）
        // 这是正确的做法，因为评论应该标记在修改后的代码上
        // 参考 code_review_agent 的 _extract_line_mapping 函数，优先使用 new line
        const isNewFile = true;

        await this.phabClient.createInline(
          revisionId,
          normalizedPath,
          isNewFile,
          comment.line,
          comment.message,
          0
        );

        // 标记所有 issue 为已发布
        for (const issueId of issueIds) {
          await this.stateManager.markIssuePublished(revisionId, issueId);
          details.push({
            issueId,
            status: 'published',
          });
        }
        published++;
      } catch (error) {
        logger.error(`Failed to publish comment for issues ${comment.issueId}`, { error });
        for (const issueId of issueIds) {
          details.push({
            issueId,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
        failed++;
      }
    }

    // 如果有总体评论，提交
    if (message && published > 0) {
      try {
        await this.phabClient.submitComments(revisionId, message, true);
        logger.info(`Submitted ${published} comments to revision ${revisionId}`);
      } catch (error) {
        logger.error('Failed to submit comments', { error });
      }
    }

    return {
      published,
      skipped,
      failed,
      details,
    };
  }

  /**
   * 规范化文件路径（去除 a/ b/ 前缀和 (new) 标记）
   */
  private normalizeFilePath(filePath: string): string {
    let normalized = filePath.replace(/ \(new\)$/, '');
    if (normalized.startsWith('a/')) {
      normalized = normalized.substring(2);
    } else if (normalized.startsWith('b/')) {
      normalized = normalized.substring(2);
    }
    return normalized;
  }
}

