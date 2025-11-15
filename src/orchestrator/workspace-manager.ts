/**
 * WorkspaceManager - 管理 Git 工作区（支持本地路径与远程仓库）
 */

import fs from 'fs/promises';
import path from 'path';

import { GitClient } from '../clients/git-client.js';
import { logger } from '../utils/logger.js';

export interface WorkspaceConfig {
  repoUrl: string; // Git 仓库 URL 或本地路径
  branch: string; // 要分析的分支
  baselineBranch?: string; // 对比基准分支
  workDir?: string; // 可选：指定工作目录
}

export interface Workspace {
  id: string;
  repoUrl: string;
  branch: string;           // 当前工作分支（可能是测试分支）
  sourceBranch: string;     // 原始特性分支
  testBranch?: string;      // 如果创建了测试分支，记录名称
  baselineBranch: string;
  workDir: string;
  createdAt: number;
  isTemporary: boolean;
  packageRoot?: string;     // 识别到的子项目根目录（monorepo）
}

interface WorkspaceManagerOptions {
  baseDir?: string;
  ttlMs?: number; // 工作区有效期，默认 1 小时
}

function randomString(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export class WorkspaceManager {
  private gitClient: GitClient;
  private workspaces = new Map<string, Workspace>();
  private baseDir: string;
  private ttlMs: number;

  constructor(gitClient: GitClient, options: WorkspaceManagerOptions = {}) {
    this.gitClient = gitClient;
    this.baseDir = options.baseDir || '/tmp/mcp-workspace';
    this.ttlMs = options.ttlMs || 60 * 60 * 1000; // 1 小时
  }

  /**
   * 创建工作区
   * 自动创建或切换到 <feature>-test 分支
   */
  async createWorkspace(config: WorkspaceConfig): Promise<string> {
    const workspaceId = `ws-${Date.now()}-${randomString(6)}`;
    const baselineRef = config.baselineBranch?.trim() || 'origin/HEAD';
    const sourceBranch = config.branch;
    
    // 生成测试分支名：feature/xxx -> feature/xxx-test
    const testBranch = this.generateTestBranchName(sourceBranch);

    const isLocalPath = !config.repoUrl.startsWith('http://') && !config.repoUrl.startsWith('https://') && !config.repoUrl.startsWith('git@');
    let workDir: string;
    let isTemporary = false;
    let actualBranch = sourceBranch;

    if (config.workDir) {
      workDir = config.workDir;
      isTemporary = false;
      
      // 本地工作目录：尝试切换到测试分支或创建
      actualBranch = await this.setupTestBranch(workDir, sourceBranch, testBranch);
    } else if (isLocalPath) {
      workDir = path.resolve(config.repoUrl);
      isTemporary = false;
      
      // 本地路径：尝试切换到测试分支或创建
      actualBranch = await this.setupTestBranch(workDir, sourceBranch, testBranch);
    } else {
      await fs.mkdir(this.baseDir, { recursive: true });
      workDir = path.join(this.baseDir, workspaceId);
      
      // 克隆远程仓库，先克隆源分支
      await this.gitClient.clone(config.repoUrl, workDir, sourceBranch);
      isTemporary = true;

      const fetchTarget = baselineRef.startsWith('origin/') ? baselineRef.slice('origin/'.length) : baselineRef;
      try {
        if (fetchTarget && fetchTarget !== 'HEAD') {
          await this.gitClient.fetch(workDir, 'origin', fetchTarget);
        } else {
          await this.gitClient.fetch(workDir);
        }
      } catch (error) {
        logger.warn('[WorkspaceManager] Failed to fetch baseline branch', {
          workspaceId,
          baselineRef,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // 设置测试分支
      actualBranch = await this.setupTestBranch(workDir, sourceBranch, testBranch);
    }

    const workspace: Workspace = {
      id: workspaceId,
      repoUrl: config.repoUrl,
      branch: actualBranch,
      sourceBranch,
      testBranch: actualBranch === testBranch ? testBranch : undefined,
      baselineBranch: baselineRef,
      workDir,
      createdAt: Date.now(),
      isTemporary,
    };

    this.workspaces.set(workspaceId, workspace);

    logger.info('[WorkspaceManager] Workspace created', {
      workspaceId,
      workDir,
      repoUrl: config.repoUrl,
      sourceBranch,
      actualBranch,
      testBranch: workspace.testBranch,
    });

    return workspaceId;
  }

  /**
   * 生成测试分支名
   * feature/xxx -> feature/xxx-test
   * bugfix/xxx -> bugfix/xxx-test
   */
  private generateTestBranchName(sourceBranch: string): string {
    if (sourceBranch.endsWith('-test')) {
      return sourceBranch;
    }
    return `${sourceBranch}-test`;
  }

  /**
   * 设置测试分支：检查是否存在，存在则切换，不存在则创建
   */
  private async setupTestBranch(workDir: string, sourceBranch: string, testBranch: string): Promise<string> {
    if (testBranch === sourceBranch) {
      // 原始分支已经是测试分支，直接切换
      try {
        await this.gitClient.checkout(workDir, sourceBranch);
      } catch (error) {
        logger.warn('[WorkspaceManager] Failed to checkout source branch', {
          sourceBranch,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return sourceBranch;
    }

    const remoteSourceRef = `origin/${sourceBranch}`;

    const resetToSource = async () => {
      // 优先尝试重置到远程源分支，如果不可用，再退回到本地源分支
      try {
        const remoteSourceExists = await this.gitClient.remoteBranchExists(workDir, sourceBranch);
        if (remoteSourceExists) {
          await this.gitClient.fetch(workDir, 'origin', sourceBranch).catch(() => void 0);
          await this.gitClient.resetHard(workDir, remoteSourceRef);
          logger.info('[WorkspaceManager] Test branch reset to remote source branch', {
            sourceBranch,
            ref: remoteSourceRef,
          });
          return;
        }
      } catch (error) {
        logger.warn('[WorkspaceManager] Failed to reset to remote source branch, trying local branch', {
          sourceBranch,
          error,
        });
      }

      try {
        await this.gitClient.resetHard(workDir, sourceBranch);
        logger.info('[WorkspaceManager] Test branch reset to local source branch', { sourceBranch });
      } catch (error) {
        logger.warn('[WorkspaceManager] Failed to reset test branch to source branch', { error });
      }
    };

    try {
      // 检查本地/远程是否已有测试分支
      const [localExists, remoteExists] = await Promise.all([
        this.gitClient.branchExists(workDir, testBranch),
        this.gitClient.remoteBranchExists(workDir, testBranch),
      ]);

      if (remoteExists) {
        logger.info('[WorkspaceManager] Test branch exists remotely, preparing local branch', { testBranch });
        await this.gitClient.fetch(workDir, 'origin', testBranch).catch(() => void 0);

        if (!localExists) {
          await this.gitClient.createBranch(workDir, testBranch, `origin/${testBranch}`);
        } else {
          await this.gitClient.checkout(workDir, testBranch);
        }

        await resetToSource();
        return testBranch;
      }

      if (localExists) {
        logger.info('[WorkspaceManager] Test branch exists locally, switching', { testBranch });
        await this.gitClient.checkout(workDir, testBranch);
        await resetToSource();
        return testBranch;
      }

      // 本地和远程都不存在，基于源分支创建新的测试分支
      logger.info('[WorkspaceManager] Creating new test branch', { testBranch, sourceBranch });

      const remoteSourceExists = await this.gitClient.remoteBranchExists(workDir, sourceBranch);
      if (remoteSourceExists) {
        await this.gitClient.fetch(workDir, 'origin', sourceBranch).catch(() => void 0);
        await this.gitClient.createBranch(workDir, testBranch, remoteSourceRef);
      } else {
        await this.gitClient.createBranch(workDir, testBranch, sourceBranch);
      }
      return testBranch;
    } catch (error) {
      logger.error('[WorkspaceManager] Failed to setup test branch, using source branch', {
        sourceBranch,
        testBranch,
        error: error instanceof Error ? error.message : String(error),
      });
      return sourceBranch;
    }
  }

  /**
   * 获取工作区信息
   */
  getWorkspace(workspaceId: string): Workspace | undefined {
    return this.workspaces.get(workspaceId);
  }

  /**
   * 获取工作区差异
   */
  async getDiff(workspaceId: string): Promise<string> {
    const workspace = this.getWorkspaceOrThrow(workspaceId);
    const baseline = workspace.baselineBranch || 'origin/HEAD';
    return this.gitClient.diff(workspace.workDir, baseline, workspace.branch);
  }

  /**
   * 清理指定工作区
   */
  async cleanup(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      return;
    }

    if (workspace.isTemporary) {
      try {
        await fs.rm(workspace.workDir, { recursive: true, force: true });
        logger.info('[WorkspaceManager] Temporary workspace removed', { workspaceId });
      } catch (error) {
        logger.warn('[WorkspaceManager] Failed to remove workspace directory', {
          workspaceId,
          error,
        });
      }
    }

    this.workspaces.delete(workspaceId);
  }

  /**
   * 清理超时工作区（超过 ttlMs）
   */
  async cleanupExpired(): Promise<void> {
    const now = Date.now();
    const expired = Array.from(this.workspaces.values()).filter((ws) => now - ws.createdAt > this.ttlMs);

    if (expired.length === 0) {
      return;
    }

    logger.info('[WorkspaceManager] Cleaning up expired workspaces', { count: expired.length });

    await Promise.all(expired.map((ws) => this.cleanup(ws.id)));
  }

  async cleanupAll(): Promise<void> {
    const workspaceIds = Array.from(this.workspaces.keys());
    await Promise.all(workspaceIds.map((id) => this.cleanup(id)));
  }

  private getWorkspaceOrThrow(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    return workspace;
  }
}
