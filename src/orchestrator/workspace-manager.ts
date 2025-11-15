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
  branch: string;
  baselineBranch: string;
  workDir: string;
  createdAt: number;
  isTemporary: boolean;
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
   */
  async createWorkspace(config: WorkspaceConfig): Promise<string> {
    const workspaceId = `ws-${Date.now()}-${randomString(6)}`;
    const baselineRef = config.baselineBranch?.trim() || 'origin/HEAD';

    const isLocalPath = !config.repoUrl.startsWith('http://') && !config.repoUrl.startsWith('https://') && !config.repoUrl.startsWith('git@');
    let workDir: string;
    let isTemporary = false;

    if (config.workDir) {
      workDir = config.workDir;
      isTemporary = false;
    } else if (isLocalPath) {
      workDir = path.resolve(config.repoUrl);
      isTemporary = false;
    } else {
      await fs.mkdir(this.baseDir, { recursive: true });
      workDir = path.join(this.baseDir, workspaceId);
      await this.gitClient.clone(config.repoUrl, workDir, config.branch);
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
    }

    const workspace: Workspace = {
      id: workspaceId,
      repoUrl: config.repoUrl,
      branch: config.branch,
      baselineBranch: baselineRef,
      workDir,
      createdAt: Date.now(),
      isTemporary,
    };

    this.workspaces.set(workspaceId, workspace);

    logger.info('[WorkspaceManager] Workspace created', { workspaceId, workDir, repoUrl: config.repoUrl });

    return workspaceId;
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
