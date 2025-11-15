/**
 * FetchDiffFromRepoTool - 从 Git 仓库获取 diff 和项目配置
 */

import { z } from 'zod';
import { BaseTool, ToolMetadata } from '../core/base-tool.js';
import { getAppContext } from '../core/app-context.js';
import type { ProjectConfig } from '../orchestrator/project-detector.js';
import { logger } from '../utils/logger.js';

export const FetchDiffFromRepoInputSchema = z.object({
  repoUrl: z.string().describe('Git 仓库 URL 或本地路径'),
  branch: z.string().describe('要分析的分支'),
  baselineBranch: z.string().optional().describe('对比基准分支（默认 origin/HEAD）'),
  workDir: z.string().optional().describe('可选：指定工作目录'),
});

export interface FetchDiffFromRepoInput {
  repoUrl: string;
  branch: string;
  baselineBranch?: string;
  workDir?: string;
}

export interface FetchDiffFromRepoOutput {
  workspaceId: string;
  diff: string;
  projectConfig: ProjectConfig;
  changedFiles: string[];
}

export class FetchDiffFromRepoTool extends BaseTool<FetchDiffFromRepoInput, FetchDiffFromRepoOutput> {
  getZodSchema() {
    return FetchDiffFromRepoInputSchema;
  }

  getMetadata(): ToolMetadata {
    return {
      name: 'fetch-diff-from-repo',
      description:
        '从 Git 仓库（URL 或本地路径）获取分支差异、项目配置和变更文件列表。支持 Monorepo 检测和子项目识别。',
      inputSchema: {
        type: 'object',
        properties: {
          repoUrl: {
            type: 'string',
            description: 'Git 仓库 URL 或本地路径',
          },
          branch: {
            type: 'string',
            description: '要分析的分支',
          },
          baselineBranch: {
            type: 'string',
            description: '对比基准分支（默认 origin/HEAD）',
          },
          workDir: {
            type: 'string',
            description: '可选：指定工作目录',
          },
        },
        required: ['repoUrl', 'branch'],
      },
      category: 'workspace',
      version: '3.0.0',
    };
  }

  protected async executeImpl(input: FetchDiffFromRepoInput): Promise<FetchDiffFromRepoOutput> {
    const { workspaceManager, projectDetector, gitClient } = getAppContext();

    if (!workspaceManager) {
      throw new Error('WorkspaceManager not initialized');
    }

    if (!projectDetector) {
      throw new Error('ProjectDetector not initialized');
    }

    if (!gitClient) {
      throw new Error('GitClient not initialized');
    }

    logger.info('[FetchDiffFromRepo] Creating workspace', { repoUrl: input.repoUrl, branch: input.branch });

    // 1. 创建工作区
    const workspaceId = await workspaceManager.createWorkspace({
      repoUrl: input.repoUrl,
      branch: input.branch,
      baselineBranch: input.baselineBranch,
      workDir: input.workDir,
    });

    const workspace = workspaceManager.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Failed to create workspace: ${workspaceId}`);
    }

    logger.info('[FetchDiffFromRepo] Workspace created', { workspaceId, workDir: workspace.workDir });

    // 2. 获取变更文件列表
    const changedFiles = await gitClient.getChangedFiles(
      workspace.workDir,
      workspace.baselineBranch,
      workspace.branch
    );

    logger.info('[FetchDiffFromRepo] Changed files retrieved', { count: changedFiles.length });

    // 3. 尝试识别子项目（monorepo 场景）
    let packageRoot = workspace.packageRoot;
    let affectedSubProjects: string[] = [];
    let testableSubProjects: string[] = [];

    if (changedFiles.length > 0) {
      affectedSubProjects = await projectDetector.detectSubProjects(workspace.workDir, changedFiles);
      if (affectedSubProjects.length > 0) {
        testableSubProjects = await projectDetector.filterTestableSubProjects(affectedSubProjects);

        if (!packageRoot) {
          packageRoot = testableSubProjects[0] ?? affectedSubProjects[0];
        }

        logger.info('[FetchDiffFromRepo] Sub-project analysis', {
          affectedCount: affectedSubProjects.length,
          testableCount: testableSubProjects.length,
          primary: packageRoot,
        });
      }
    }

    if (packageRoot) {
      workspace.packageRoot = packageRoot;
    }

    // 4. 检测项目配置（包括所有受影响的子项目和可测试的子项目）
    const projectConfig = await projectDetector.detectProject(
      workspace.workDir,
      packageRoot,
      changedFiles
    );

    // 如果 detectProject 没有返回这些信息，使用上一步的结果补充
    if (!projectConfig.affectedSubProjects && affectedSubProjects.length > 0) {
      projectConfig.affectedSubProjects = affectedSubProjects;
    }
    if (!projectConfig.testableSubProjects && testableSubProjects.length > 0) {
      projectConfig.testableSubProjects = testableSubProjects;
    }

    // 5. 更新 workspace 信息
    if (projectConfig.affectedSubProjects) {
      workspace.affectedSubProjects = projectConfig.affectedSubProjects;
    }
    if (projectConfig.testableSubProjects) {
      workspace.testableSubProjects = projectConfig.testableSubProjects;
    }

    // 6. 获取 diff
    const diff = await workspaceManager.getDiff(workspaceId);

    return {
      workspaceId,
      diff,
      projectConfig,
      changedFiles,
    };
  }
}
