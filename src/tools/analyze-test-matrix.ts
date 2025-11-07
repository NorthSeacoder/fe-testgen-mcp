import { FetchDiffTool } from './fetch-diff.js';
import { ResolvePathTool } from './resolve-path.js';
import { TestMatrixAnalyzer } from '../agents/test-matrix-analyzer.js';
import { StateManager } from '../state/manager.js';
import { BaseAnalyzeTestMatrix } from './base-analyze-test-matrix.js';
import type { TestMatrixAnalysis } from '../schemas/test-matrix.js';

export interface AnalyzeTestMatrixInput {
  revisionId: string;
  projectRoot?: string;
  forceRefresh?: boolean;
}

export class AnalyzeTestMatrixTool {
  private baseAnalyzer: BaseAnalyzeTestMatrix;

  constructor(
    private fetchDiffTool: FetchDiffTool,
    resolvePathTool: ResolvePathTool,
    stateManager: StateManager,
    analyzer: TestMatrixAnalyzer
  ) {
    this.baseAnalyzer = new BaseAnalyzeTestMatrix(resolvePathTool, stateManager, analyzer);
  }

  async analyze(input: AnalyzeTestMatrixInput): Promise<TestMatrixAnalysis> {
    // 1. 获取 diff
    const diff = await this.fetchDiffTool.fetch({
      revisionId: input.revisionId,
      forceRefresh: input.forceRefresh || false,
    });

    // 2. 过滤前端文件
    const frontendDiff = this.fetchDiffTool.filterFrontendFiles(diff);

    if (frontendDiff.files.length === 0) {
      throw new Error(`没有前端文件变更。总文件数: ${diff.files.length}`);
    }

    // 3. 使用基类分析
    return this.baseAnalyzer.analyze({
      diff: frontendDiff,
      revisionId: input.revisionId,
      projectRoot: input.projectRoot,
    });
  }
}

