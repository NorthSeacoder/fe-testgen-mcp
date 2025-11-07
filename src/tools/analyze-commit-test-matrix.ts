import { FetchCommitChangesTool } from './fetch-commit-changes.js';
import { ResolvePathTool } from './resolve-path.js';
import { TestMatrixAnalyzer } from '../agents/test-matrix-analyzer.js';
import { StateManager } from '../state/manager.js';
import { BaseAnalyzeTestMatrix } from './base-analyze-test-matrix.js';
import { isFrontendFile } from '../schemas/diff.js';
import type { TestMatrixAnalysis } from '../schemas/test-matrix.js';
import { logger } from '../utils/logger.js';

export interface AnalyzeCommitTestMatrixInput {
  commitHash: string;
  repoPath?: string;
  projectRoot?: string;
}

export class AnalyzeCommitTestMatrixTool {
  private baseAnalyzer: BaseAnalyzeTestMatrix;

  constructor(
    private fetchCommitTool: FetchCommitChangesTool,
    resolvePathTool: ResolvePathTool,
    stateManager: StateManager,
    analyzer: TestMatrixAnalyzer
  ) {
    this.baseAnalyzer = new BaseAnalyzeTestMatrix(resolvePathTool, stateManager, analyzer);
  }

  async analyze(input: AnalyzeCommitTestMatrixInput): Promise<TestMatrixAnalysis> {
    // 1. 获取 commit 的变更
    const { diff, commitInfo } = await this.fetchCommitTool.fetch({
      commitHash: input.commitHash,
      repoPath: input.repoPath,
    });

    logger.info(`Analyzing test matrix for commit ${commitInfo.hash.substring(0, 7)}`, {
      message: commitInfo.message,
      author: commitInfo.author,
      filesCount: diff.files.length,
    });

    // 2. 过滤前端文件
    const frontendFiles = diff.files.filter(file => isFrontendFile(file.path));

    if (frontendFiles.length === 0) {
      throw new Error(
        `No frontend files found in commit ${input.commitHash}. Total files: ${diff.files.length}`
      );
    }

    const frontendDiff = {
      ...diff,
      files: frontendFiles,
    };

    // 3. 使用基类分析
    const stateKey = `commit:${input.commitHash}`;
    const result = await this.baseAnalyzer.analyze({
      diff: frontendDiff,
      revisionId: stateKey,
      projectRoot: input.projectRoot,
      metadata: {
        commitInfo,
      },
    });

    return {
      ...result,
      metadata: {
        ...result.metadata,
        revisionId: `commit:${commitInfo.hash}`,
      },
    };
  }
}
