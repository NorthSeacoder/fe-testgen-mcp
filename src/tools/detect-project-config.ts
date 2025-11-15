/**
 * DetectProjectConfigTool - 检测已存在工作区的项目配置
 */

import { z } from 'zod';
import { BaseTool, ToolMetadata } from '../core/base-tool.js';
import { getAppContext } from '../core/app-context.js';
import type { ProjectConfig } from '../orchestrator/project-detector.js';

const DetectProjectConfigInputSchema = z.object({
  workspaceId: z.string().describe('Workspace ID'),
});

export interface DetectProjectConfigInput {
  workspaceId: string;
}

export class DetectProjectConfigTool extends BaseTool<DetectProjectConfigInput, ProjectConfig> {
  getZodSchema() {
    return DetectProjectConfigInputSchema;
  }

  getMetadata(): ToolMetadata {
    return {
      name: 'detect-project-config',
      description: '检测指定工作区的项目配置（Monorepo、测试框架、已有测试等）',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description: 'Workspace ID',
          },
        },
        required: ['workspaceId'],
      },
      category: 'workspace',
      version: '3.0.0',
    };
  }

  protected async executeImpl(input: DetectProjectConfigInput): Promise<ProjectConfig> {
    const { workspaceManager, projectDetector } = getAppContext();

    if (!workspaceManager) {
      throw new Error('WorkspaceManager not initialized');
    }

    if (!projectDetector) {
      throw new Error('ProjectDetector not initialized');
    }

    const workspace = workspaceManager.getWorkspace(input.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${input.workspaceId}`);
    }

    return projectDetector.detectProject(workspace.workDir);
  }
}
