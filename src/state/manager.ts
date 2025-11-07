import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import type { Issue } from '../schemas/issue.js';
import type { TestCase } from '../schemas/test-plan.js';
import type { TestMatrix } from '../schemas/test-matrix.js';

export interface RevisionState {
  revisionId: string;
  diffId: string;
  diffFingerprint: string; // 基于 diff 内容的 hash
  lastReviewAt?: string;
  lastTestGenAt?: string;
  lastMatrixAnalysisAt?: string;
  issues: Array<{
    id: string;
    file: string;
    line: number;
    severity: string;
    category: string;
    message: string;
    confidence: number;
    createdAt: string;
    publishedAt?: string;
  }>;
  tests: Array<{
    id: string;
    file: string;
    testName: string;
    createdAt: string;
  }>;
  testMatrix?: TestMatrix; // 测试矩阵（功能清单 + 测试场景）
}

export interface StateManagerConfig {
  dir: string;
}

export class StateManager {
  private config: StateManagerConfig;

  constructor(config: StateManagerConfig) {
    this.config = config;

    // 确保状态目录存在
    try {
      mkdirSync(config.dir, { recursive: true });
    } catch {
      // 忽略错误
    }
  }

  /**
   * 获取状态文件路径
   */
  private getStatePath(revisionId: string): string {
    const cleanId = revisionId.replace(/^D/i, '').replace(/[^a-zA-Z0-9]/g, '_');
    return join(this.config.dir, `${cleanId}.json`);
  }

  /**
   * 读取状态
   */
  async getState(revisionId: string): Promise<RevisionState | null> {
    try {
      const path = this.getStatePath(revisionId);
      const content = readFileSync(path, 'utf-8');
      return JSON.parse(content) as RevisionState;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        return null;
      }
      logger.warn(`Failed to read state for revision ${revisionId}`, { error });
      return null;
    }
  }

  /**
   * 保存状态
   */
  async saveState(state: RevisionState): Promise<void> {
    try {
      const path = this.getStatePath(state.revisionId);
      writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
    } catch (error) {
      logger.error(`Failed to save state for revision ${state.revisionId}`, { error });
      throw error;
    }
  }

  /**
   * 更新状态中的问题列表
   */
  async updateIssues(revisionId: string, issues: Issue[]): Promise<void> {
    const state = await this.getState(revisionId);
    if (!state) {
      logger.warn(`State not found for revision ${revisionId}, cannot update issues`);
      return;
    }

    state.issues = issues.map(issue => ({
      id: issue.id,
      file: issue.file,
      line: issue.line,
      severity: issue.severity,
      category: issue.topic,
      message: issue.message,
      confidence: issue.confidence,
      createdAt: issue.createdAt || new Date().toISOString(),
      publishedAt: issue.publishedAt,
    }));

    state.lastReviewAt = new Date().toISOString();
    await this.saveState(state);
  }

  /**
   * 更新状态中的测试列表
   */
  async updateTests(revisionId: string, tests: TestCase[]): Promise<void> {
    const state = await this.getState(revisionId);
    if (!state) {
      logger.warn(`State not found for revision ${revisionId}, cannot update tests`);
      return;
    }

    state.tests = tests.map(test => ({
      id: test.id,
      file: test.file,
      testName: test.testName,
      createdAt: new Date().toISOString(),
    }));

    state.lastTestGenAt = new Date().toISOString();
    await this.saveState(state);
  }

  /**
   * 标记问题已发布
   */
  async markIssuePublished(revisionId: string, issueId: string): Promise<void> {
    const state = await this.getState(revisionId);
    if (!state) {
      return;
    }

    const issue = state.issues.find(i => i.id === issueId);
    if (issue) {
      issue.publishedAt = new Date().toISOString();
      await this.saveState(state);
    }
  }

  /**
   * 保存测试矩阵
   */
  async saveTestMatrix(revisionId: string, matrix: TestMatrix): Promise<void> {
    const state = await this.getState(revisionId);
    if (!state) {
      logger.warn(`State not found for revision ${revisionId}, cannot save test matrix`);
      return;
    }

    state.testMatrix = matrix;
    state.lastMatrixAnalysisAt = new Date().toISOString();
    await this.saveState(state);
  }

  /**
   * 获取测试矩阵
   */
  async getTestMatrix(revisionId: string): Promise<TestMatrix | null> {
    const state = await this.getState(revisionId);
    return state?.testMatrix || null;
  }

  /**
   * 初始化状态（如果不存在）
   */
  async initState(
    revisionId: string,
    diffId: string,
    diffFingerprint: string
  ): Promise<RevisionState> {
    let state = await this.getState(revisionId);
    if (!state) {
      state = {
        revisionId,
        diffId,
        diffFingerprint,
        issues: [],
        tests: [],
      };
      await this.saveState(state);
    } else {
      // 更新 diff 信息
      state.diffId = diffId;
      state.diffFingerprint = diffFingerprint;
      await this.saveState(state);
    }
    return state;
  }
}

