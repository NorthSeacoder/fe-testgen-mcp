/**
 * GitClient - Git 操作客户端
 * 提供 clone、diff、branch 等常用 Git 操作
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';

const execAsync = promisify(exec);

export interface GitClientOptions {
  timeout?: number; // 超时时间（毫秒），默认 60s
}

export class GitClient {
  private timeout: number;

  constructor(options: GitClientOptions = {}) {
    this.timeout = options.timeout || 60000;
  }

  /**
   * Clone 远程仓库
   * @param repoUrl 仓库 URL
   * @param targetDir 目标目录
   * @param branch 分支名（可选）
   * @param shallow 是否浅克隆（默认 true）
   */
  async clone(
    repoUrl: string,
    targetDir: string,
    branch?: string,
    shallow: boolean = true
  ): Promise<void> {
    const depthArg = shallow ? '--depth=1' : '';
    const branchArg = branch ? `-b ${branch}` : '';
    const command = `git clone ${depthArg} ${branchArg} ${repoUrl} ${targetDir}`.trim();

    logger.info('[GitClient] Cloning repository', { repoUrl, targetDir, branch, shallow });

    try {
      const { stderr } = await execAsync(command, {
        timeout: this.timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      if (stderr && !stderr.includes('Cloning into')) {
        logger.warn('[GitClient] Clone stderr', { stderr });
      }

      logger.info('[GitClient] Clone completed', { targetDir });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[GitClient] Clone failed', { repoUrl, targetDir, error: message });
      throw new Error(`Failed to clone repository: ${message}`);
    }
  }

  /**
   * 获取 diff
   * @param workDir 工作目录
   * @param baseRef 基准引用（commit/branch/tag）
   * @param targetRef 目标引用（可选，默认为当前工作区）
   */
  async diff(workDir: string, baseRef: string, targetRef?: string): Promise<string> {
    const target = targetRef || 'HEAD';
    const command = `git diff ${baseRef}...${target}`;

    logger.info('[GitClient] Getting diff', { workDir, baseRef, targetRef });

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: workDir,
        timeout: this.timeout,
        maxBuffer: 50 * 1024 * 1024, // 50MB
      });

      if (stderr) {
        logger.warn('[GitClient] Diff stderr', { stderr });
      }

      logger.info('[GitClient] Diff completed', { workDir, lines: stdout.split('\n').length });
      return stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[GitClient] Diff failed', { workDir, baseRef, targetRef, error: message });
      throw new Error(`Failed to get diff: ${message}`);
    }
  }

  /**
   * 获取变更文件列表
   * @param workDir 工作目录
   * @param baseRef 基准引用
   * @param targetRef 目标引用（可选，默认为当前工作区）
   */
  async getChangedFiles(
    workDir: string,
    baseRef: string,
    targetRef?: string
  ): Promise<string[]> {
    const target = targetRef || 'HEAD';
    const command = `git diff --name-only ${baseRef}...${target}`;

    logger.info('[GitClient] Getting changed files', { workDir, baseRef, targetRef });

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: workDir,
        timeout: this.timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      if (stderr) {
        logger.warn('[GitClient] Changed files stderr', { stderr });
      }

      const files = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      logger.info('[GitClient] Changed files retrieved', { workDir, count: files.length });
      return files;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[GitClient] Get changed files failed', { workDir, baseRef, targetRef, error: message });
      throw new Error(`Failed to get changed files: ${message}`);
    }
  }

  /**
   * 检查分支是否存在
   * @param workDir 工作目录
   * @param branch 分支名
   */
  async branchExists(workDir: string, branch: string): Promise<boolean> {
    const command = `git show-ref --verify --quiet refs/heads/${branch}`;

    logger.debug('[GitClient] Checking branch existence', { workDir, branch });

    try {
      await execAsync(command, {
        cwd: workDir,
        timeout: this.timeout,
      });
      logger.debug('[GitClient] Branch exists', { workDir, branch });
      return true;
    } catch (error) {
      logger.debug('[GitClient] Branch does not exist', { workDir, branch });
      return false;
    }
  }

  /**
   * 获取当前分支名
   * @param workDir 工作目录
   */
  async getCurrentBranch(workDir: string): Promise<string> {
    const command = 'git branch --show-current';

    logger.debug('[GitClient] Getting current branch', { workDir });

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: workDir,
        timeout: this.timeout,
      });

      if (stderr) {
        logger.warn('[GitClient] Get current branch stderr', { stderr });
      }

      const branch = stdout.trim();
      logger.debug('[GitClient] Current branch retrieved', { workDir, branch });
      return branch;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[GitClient] Get current branch failed', { workDir, error: message });
      throw new Error(`Failed to get current branch: ${message}`);
    }
  }

  /**
   * Fetch 远程分支
   * @param workDir 工作目录
   * @param remote 远程名（默认 origin）
   * @param branch 分支名（可选）
   */
  async fetch(workDir: string, remote: string = 'origin', branch?: string): Promise<void> {
    const branchArg = branch ? branch : '';
    const command = `git fetch ${remote} ${branchArg}`.trim();

    logger.info('[GitClient] Fetching', { workDir, remote, branch });

    try {
      const { stderr } = await execAsync(command, {
        cwd: workDir,
        timeout: this.timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      if (stderr && !stderr.includes('From')) {
        logger.warn('[GitClient] Fetch stderr', { stderr });
      }

      logger.info('[GitClient] Fetch completed', { workDir, remote, branch });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[GitClient] Fetch failed', { workDir, remote, branch, error: message });
      throw new Error(`Failed to fetch: ${message}`);
    }
  }

  /**
   * 创建新分支
   * @param workDir 工作目录
   * @param newBranch 新分支名
   * @param baseBranch 基于哪个分支创建（可选，默认当前分支）
   */
  async createBranch(workDir: string, newBranch: string, baseBranch?: string): Promise<void> {
    const baseArg = baseBranch ? baseBranch : '';
    const command = `git checkout -b ${newBranch} ${baseArg}`.trim();

    logger.info('[GitClient] Creating branch', { workDir, newBranch, baseBranch });

    try {
      const { stderr } = await execAsync(command, {
        cwd: workDir,
        timeout: this.timeout,
      });

      if (stderr && !stderr.includes('Switched to a new branch')) {
        logger.warn('[GitClient] Create branch stderr', { stderr });
      }

      logger.info('[GitClient] Branch created', { workDir, newBranch });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[GitClient] Create branch failed', { workDir, newBranch, error: message });
      throw new Error(`Failed to create branch: ${message}`);
    }
  }

  /**
   * 切换分支
   * @param workDir 工作目录
   * @param branch 分支名
   */
  async checkout(workDir: string, branch: string): Promise<void> {
    const command = `git checkout ${branch}`;

    logger.info('[GitClient] Checking out branch', { workDir, branch });

    try {
      const { stderr } = await execAsync(command, {
        cwd: workDir,
        timeout: this.timeout,
      });

      if (stderr && !stderr.includes('Switched to branch') && !stderr.includes('Already on')) {
        logger.warn('[GitClient] Checkout stderr', { stderr });
      }

      logger.info('[GitClient] Checkout completed', { workDir, branch });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[GitClient] Checkout failed', { workDir, branch, error: message });
      throw new Error(`Failed to checkout branch: ${message}`);
    }
  }

  /**
   * 强制重置到指定引用
   */
  async resetHard(workDir: string, ref: string): Promise<void> {
    const command = `git reset --hard ${ref}`;

    logger.info('[GitClient] Resetting branch', { workDir, ref });

    try {
      const { stderr } = await execAsync(command, {
        cwd: workDir,
        timeout: this.timeout,
      });

      if (stderr && !stderr.includes('HEAD is now at')) {
        logger.warn('[GitClient] Reset stderr', { stderr });
      }

      logger.info('[GitClient] Reset completed', { workDir, ref });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[GitClient] Reset failed', { workDir, ref, error: message });
      throw new Error(`Failed to reset branch: ${message}`);
    }
  }

  /**
   * 检查远程分支是否存在
   * @param workDir 工作目录
   * @param branch 分支名
   * @param remote 远程名（默认 origin）
   */
  async remoteBranchExists(workDir: string, branch: string, remote: string = 'origin'): Promise<boolean> {
    const command = `git ls-remote --heads ${remote} ${branch}`;

    logger.debug('[GitClient] Checking remote branch existence', { workDir, branch, remote });

    try {
      const { stdout } = await execAsync(command, {
        cwd: workDir,
        timeout: this.timeout,
      });

      const exists = stdout.trim().length > 0;
      logger.debug('[GitClient] Remote branch check result', { workDir, branch, remote, exists });
      return exists;
    } catch (error) {
      logger.debug('[GitClient] Remote branch check failed', { workDir, branch, remote });
      return false;
    }
  }
}
