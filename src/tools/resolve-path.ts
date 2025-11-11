import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { BaseTool, ToolMetadata } from '../core/base-tool.js';
import { detectProjectRoot } from '../utils/project-root.js';
import { logger } from '../utils/logger.js';

export const ResolvePathInputSchema = z.object({
  paths: z.array(z.string()).describe('相对路径数组（相对于项目根目录/子包）'),
  projectRoot: z.string().optional().describe('手动指定项目根目录（可选，优先级高于自动检测）'),
});

export interface ResolvePathInput {
  paths: string[];
  projectRoot?: string;
}

export interface ResolvedPathItem {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
  closestExistingDir: string;
}

export interface ResolvePathResult {
  root: string;
  isMonorepo: boolean;
  workspaceType?: 'pnpm' | 'yarn' | 'npm' | 'lerna' | 'rush';
  resolved: ResolvedPathItem[];
}

function findClosestExistingDir(targetPath: string): string {
  let current = targetPath;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export class ResolvePathTool extends BaseTool<ResolvePathInput, ResolvePathResult> {
  getZodSchema() {
    return ResolvePathInputSchema;
  }

  getMetadata(): ToolMetadata {
    return {
      name: 'resolve-path',
      description: '将相对路径转换为绝对路径，自动检测项目根目录和 Monorepo 结构',
      inputSchema: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: '相对路径数组（相对于项目根目录/子包）',
          },
          projectRoot: {
            type: 'string',
            description: '手动指定项目根目录（可选，优先级高于自动检测）',
          },
        },
        required: ['paths'],
      },
      category: 'utility',
      version: '3.0.0',
    };
  }

  protected async executeImpl(input: ResolvePathInput): Promise<ResolvePathResult> {
    const uniquePaths = Array.from(new Set(input.paths || []));
    if (uniquePaths.length === 0) {
      throw new Error('paths cannot be empty');
    }

    const project = detectProjectRoot(uniquePaths, input.projectRoot);

    logger.info('[ResolvePathTool] Resolving absolute paths', {
      root: project.root,
      isMonorepo: project.isMonorepo,
      workspaceType: project.workspaceType,
      pathsCount: uniquePaths.length,
    });

    const resolved: ResolvedPathItem[] = uniquePaths.map((p) => {
      const absolutePath = join(project.root, p);
      const exists = existsSync(absolutePath);
      const searchTarget = exists ? dirname(absolutePath) : absolutePath;
      const closestExistingDir = findClosestExistingDir(searchTarget);
      return {
        relativePath: p,
        absolutePath,
        exists,
        closestExistingDir,
      };
    });

    return {
      root: project.root,
      isMonorepo: project.isMonorepo,
      workspaceType: project.workspaceType,
      resolved,
    };
  }

  async resolve(input: ResolvePathInput): Promise<ResolvePathResult> {
    const result = await this.execute(input);
    if (!result.success || !result.data) {
      throw new Error(result.error || 'Failed to resolve paths');
    }
    return result.data;
  }
}


