/**
 * FetchCommitChangesTool - 获取 Git commit 变更内容
 */

import { z } from 'zod';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { BaseTool, ToolMetadata } from '../core/base-tool.js';
import { parseDiff, generateNumberedDiff } from '../utils/diff-parser.js';
import type { Diff } from '../schemas/diff.js';

// Zod schema for FetchCommitChangesInput
export const FetchCommitChangesInputSchema = z.object({
  commitHash: z.string().describe('Git commit hash（支持短 hash）'),
  repoPath: z.string().optional().describe('本地仓库路径，默认为当前工作目录'),
});

export interface FetchCommitChangesInput {
  commitHash: string;
  repoPath?: string;
}

export interface FetchCommitChangesOutput {
  diff: Diff;
  commitInfo: {
    hash: string;
    author: string;
    date: string;
    message: string;
  };
}

export class FetchCommitChangesTool extends BaseTool<FetchCommitChangesInput, FetchCommitChangesOutput> {
  // Expose Zod schema for FastMCP
  getZodSchema() {
    return FetchCommitChangesInputSchema;
  }

  getMetadata(): ToolMetadata {
    return {
      name: 'fetch-commit-changes',
      description:
        '从本地 Git 仓库中获取指定 commit 的变更内容，包含带行号的 diff 以及 commit 元信息。',
      inputSchema: {
        type: 'object',
        properties: {
          commitHash: {
            type: 'string',
            description: 'Git commit hash（支持短 hash）',
          },
          repoPath: {
            type: 'string',
            description: '本地仓库路径，默认为当前工作目录',
          },
        },
        required: ['commitHash'],
      },
      category: 'code-retrieval',
      version: '3.0.0',
    };
  }

  protected async executeImpl(input: FetchCommitChangesInput): Promise<FetchCommitChangesOutput> {
    const { commitHash, repoPath = process.cwd() } = input;

    if (!existsSync(repoPath)) {
      throw new Error(`Repository path does not exist: ${repoPath}`);
    }

    try {
      execSync('git rev-parse --git-dir', {
        cwd: repoPath,
        stdio: 'pipe',
      });
    } catch {
      throw new Error(`Not a git repository: ${repoPath}`);
    }

    const commitInfoRaw = execSync(
      `git show --no-patch --format="%H%n%an%n%ai%n%s" ${commitHash}`,
      {
        cwd: repoPath,
        encoding: 'utf-8',
      }
    );

    const [hash, author, date, message] = commitInfoRaw.trim().split('\n');

    const diffRaw = execSync(`git show ${commitHash}`, {
      cwd: repoPath,
      encoding: 'utf-8',
    });

    const diff = parseDiff(diffRaw, `commit:${commitHash}`, {
      title: message,
      summary: `Commit by ${author} on ${date}`,
      author,
    });

    diff.numberedRaw = generateNumberedDiff(diff);

    return {
      diff,
      commitInfo: {
        hash,
        author,
        date,
        message,
      },
    };
  }
}
