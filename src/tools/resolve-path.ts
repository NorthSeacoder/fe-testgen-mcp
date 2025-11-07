import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { detectProjectRoot } from '../utils/project-root.js';
import { logger } from '../utils/logger.js';

export interface ResolvePathInput {
  /** 相对路径或相对路径数组（相对于项目根目录/子包） */
  paths: string[];
  /** 手动指定项目根目录（可选，优先级高于自动检测） */
  projectRoot?: string;
}

export interface ResolvedPathItem {
  relativePath: string;
  absolutePath: string;
  /** 目标文件是否存在（新增文件可能为 false） */
  exists: boolean;
  /** 从目标路径向上查找到的最近存在的目录 */
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
  // 如果传入的是文件路径且文件不存在，从其父目录开始回退
  // 无论文件是否存在，这个函数都会返回最接近的存在的目录
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export class ResolvePathTool {
  async resolve(input: ResolvePathInput): Promise<ResolvePathResult> {
    const uniquePaths = Array.from(new Set(input.paths || []));
    if (uniquePaths.length === 0) {
      throw new Error('paths 不能为空');
    }

    // 基于相对路径（以及可选的手动根目录）自动定位项目根目录
    const project = detectProjectRoot(uniquePaths, input.projectRoot);

    logger.info('Resolving absolute paths', {
      root: project.root,
      isMonorepo: project.isMonorepo,
      workspaceType: project.workspaceType,
      pathsCount: uniquePaths.length,
    });

    const resolved: ResolvedPathItem[] = uniquePaths.map((p) => {
      const absolutePath = join(project.root, p);
      const exists = existsSync(absolutePath);
      const closestExistingDir = findClosestExistingDir(exists ? dirname(absolutePath) : dirname(absolutePath));
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
}


