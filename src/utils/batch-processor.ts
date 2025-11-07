import { ReviewDiffTool } from '../tools/review-diff.js';
import { GenerateTestsTool } from '../tools/generate-tests.js';
import { logger } from '../utils/logger.js';

export interface BatchProcessOptions {
  revisionIds: string[];
  mode?: 'review' | 'test' | 'both';
  options?: {
    publish?: boolean;
    forceRefresh?: boolean;
  };
}

export interface BatchProcessResult {
  total: number;
  success: number;
  failed: number;
  results: Array<{
    revisionId: string;
    status: 'success' | 'failed';
    error?: string;
    duration?: number;
  }>;
}

export class BatchProcessor {
  constructor(
    private reviewTool: ReviewDiffTool,
    private testTool: GenerateTestsTool
  ) {}

  /**
   * 批量处理多个 revision
   */
  async processBatch(options: BatchProcessOptions): Promise<BatchProcessResult> {
    const { revisionIds, mode = 'both', options: toolOptions = {} } = options;
    const results: BatchProcessResult['results'] = [];
    let success = 0;
    let failed = 0;

    logger.info(`Starting batch process for ${revisionIds.length} revisions (mode: ${mode})`);

    for (let i = 0; i < revisionIds.length; i++) {
      const revisionId = revisionIds[i];
      const startTime = Date.now();

      try {
        logger.info(`Processing revision ${i + 1}/${revisionIds.length}: ${revisionId}`);

        // 根据模式执行不同的操作
        if (mode === 'review' || mode === 'both') {
          await this.reviewTool.review({
            revisionId,
            mode: 'incremental',
            publish: toolOptions.publish ?? false,
            forceRefresh: toolOptions.forceRefresh ?? false,
          });
        }

        if (mode === 'test' || mode === 'both') {
          await this.testTool.generate({
            revisionId,
            mode: 'incremental',
            forceRefresh: toolOptions.forceRefresh ?? false,
          });
        }

        const duration = Date.now() - startTime;
        results.push({
          revisionId,
          status: 'success',
          duration,
        });
        success++;

        logger.info(`✓ Completed revision ${revisionId} in ${duration}ms`);
      } catch (error) {
        const duration = Date.now() - startTime;
        const errorMsg = error instanceof Error ? error.message : String(error);
        results.push({
          revisionId,
          status: 'failed',
          error: errorMsg,
          duration,
        });
        failed++;
        logger.error(`✗ Failed revision ${revisionId}: ${errorMsg}`);
      }

      // 进度报告
      const progress = ((i + 1) / revisionIds.length) * 100;
      logger.info(`Progress: ${progress.toFixed(1)}% (${i + 1}/${revisionIds.length})`);
    }

    logger.info(`Batch process completed: ${success} success, ${failed} failed`);

    return {
      total: revisionIds.length,
      success,
      failed,
      results,
    };
  }

  /**
   * 生成批量处理报告
   */
  generateReport(result: BatchProcessResult): string {
    let report = `## 批量处理报告\n\n`;
    report += `**总计**: ${result.total} 个 revision\n`;
    report += `**成功**: ${result.success} 个\n`;
    report += `**失败**: ${result.failed} 个\n`;
    report += `**成功率**: ${((result.success / result.total) * 100).toFixed(1)}%\n\n`;

    if (result.failed > 0) {
      report += `### 失败详情\n\n`;
      result.results
        .filter(r => r.status === 'failed')
        .forEach(r => {
          report += `- **${r.revisionId}**: ${r.error}\n`;
        });
    }

    const avgDuration = result.results
      .filter(r => r.duration)
      .reduce((sum, r) => sum + (r.duration || 0), 0) / result.success;

    if (avgDuration > 0) {
      report += `\n**平均处理时间**: ${avgDuration.toFixed(0)}ms\n`;
    }

    return report;
  }
}

