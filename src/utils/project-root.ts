import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { logger } from './logger.js';

/**
 * 项目根目录检测结果
 */
export interface ProjectRoot {
  /** 项目根目录路径 */
  root: string;
  /** 是否为 monorepo */
  isMonorepo: boolean;
  /** 如果是 monorepo，返回子包根目录（相对于 monorepo 根） */
  packageRoot?: string;
  /** 检测到的 workspace 类型 */
  workspaceType?: 'pnpm' | 'yarn' | 'npm' | 'lerna' | 'rush';
}

/**
 * 通过验证相对路径来确认候选目录是否为项目根目录
 * 
 * 策略：
 * 1. 检查候选目录是否包含项目标识文件（.cursorrules 或 package.json）
 * 2. 验证相对路径的目录结构是否存在（至少第一级目录应该存在）
 * 
 * @param candidateRoot - 候选根目录
 * @param relativePaths - 相对路径列表
 * @returns 如果验证通过返回项目根目录，否则返回 null
 */
function verifyProjectRootByRelativePaths(
  candidateRoot: string,
  relativePaths: string[]
): string | null {
  // 1. 检查是否包含项目标识文件
  const hasCursorRules = existsSync(join(candidateRoot, '.cursorrules'));
  const hasPackageJson = existsSync(join(candidateRoot, 'package.json'));
  
  if (!hasCursorRules && !hasPackageJson) {
    return null;
  }
  
  // 2. 验证相对路径的目录结构
  // 至少要有一个路径的第一级目录存在（新文件可能不存在，但目录结构应该存在）
  let validPathCount = 0;
  
  for (const relativePath of relativePaths) {
    // 提取第一级目录
    const firstSegment = relativePath.split('/')[0];
    if (!firstSegment) continue;
    
    const firstSegmentPath = join(candidateRoot, firstSegment);
    if (existsSync(firstSegmentPath)) {
      validPathCount++;
      // 找到一个匹配就够了
      if (validPathCount >= 1) {
        logger.info(`Verified project root by relative paths`, {
          candidateRoot,
          validPaths: validPathCount,
          totalPaths: relativePaths.length,
          hasCursorRules,
          hasPackageJson,
        });
        return candidateRoot;
      }
    }
  }
  
  return null;
}

/**
 * 检测当前工作目录是否在项目内
 * 
 * 检测优先级：
 * 1. .cursorrules 文件（Cursor 项目标识）
 * 2. package.json 文件（Node.js 项目标识）
 * 
 * @returns 如果当前工作目录在项目内，返回项目根目录；否则返回 null
 */
export function findProjectRootFromCwd(): string | null {
  const cwd = process.cwd();
  let currentPath = cwd;
  let depth = 0;
  const maxDepth = 10;
  
  while (depth < maxDepth) {
    // 优先检查 .cursorrules（Cursor 项目标识）
    const cursorRulesPath = join(currentPath, '.cursorrules');
    if (existsSync(cursorRulesPath)) {
      logger.info(`Found project root via .cursorrules: ${currentPath}`);
      return currentPath;
    }
    
    // 检查 package.json
    const packageJsonPath = join(currentPath, 'package.json');
    if (existsSync(packageJsonPath)) {
      return currentPath;
    }
    
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
    depth++;
  }
  
  return null;
}

/**
 * 从 diff 文件路径自动检测项目根目录
 * 
 * **重要**：MCP 服务器是独立进程，process.cwd() 指向服务器启动时的目录，
 * 而不是客户端的工作目录。因此优先从 diff 文件路径推断项目根目录。
 * 
 * @param diffFilePaths - diff 中的文件路径列表（通常是相对路径，相对于项目根目录）
 * @param manualRoot - 手动指定的根目录（可选，用于覆盖自动检测）
 * @returns 项目根目录信息
 * @throws 如果无法检测到项目根目录，抛出错误
 */
export function detectProjectRoot(
  diffFilePaths: string[],
  manualRoot?: string
): ProjectRoot {
  // 1. 如果手动指定了根目录，直接使用
  // 优先级：manualRoot 参数 > 环境变量 PROJECT_ROOT
  const effectiveRoot = manualRoot || process.env.PROJECT_ROOT;
  if (effectiveRoot) {
    logger.info(`Using project root: ${effectiveRoot} (${manualRoot ? 'from config' : 'from env'})`);
    // 验证手动指定的根目录是否有效
    const packageJsonPath = join(effectiveRoot, 'package.json');
    if (!existsSync(packageJsonPath)) {
      throw new Error(
        `指定的项目根目录无效：${effectiveRoot}\n` +
        `原因：该目录下不存在 package.json 文件。\n` +
        `请确保指定的目录是正确的项目根目录。`
      );
    }
    const result = analyzeProjectRoot(effectiveRoot);
    return {
      root: effectiveRoot,
      ...result,
    };
  }

  // 2. 最直接的策略：如果 MCP 在项目根目录启动，直接从当前目录验证相对路径
  // 这是最简单的情况：当前工作目录就是项目根目录
  if (diffFilePaths.length > 0) {
    const cwdRoot = verifyProjectRootByRelativePaths(process.cwd(), diffFilePaths);
    if (cwdRoot) {
      logger.info(`Project root verified from current directory: ${cwdRoot}`);
      const result = analyzeProjectRoot(cwdRoot);
      return {
        root: cwdRoot,
        ...result,
      };
    }
  }

  // 3. 备用策略：从 diff 文件路径推断项目根目录
  // 这对于 MCP 服务器在非项目目录启动的情况
  if (diffFilePaths.length > 0) {
    const inferredRoot = findProjectRootFromDiffPaths(diffFilePaths);
    if (inferredRoot) {
      logger.info(`Project root inferred from diff file paths: ${inferredRoot}`);
      const result = analyzeProjectRoot(inferredRoot);
      return {
        root: inferredRoot,
        ...result,
      };
    }
  }

  // 4. 再备用策略：从当前工作目录向上查找项目根目录
  // 这适用于服务器在项目子目录内启动的情况
  const cwdProjectRoot = findProjectRootFromCwd();
  
  if (cwdProjectRoot) {
    logger.info(`Project root detected from current working directory: ${cwdProjectRoot}`);
    
    // 验证：如果有 diff 文件路径，检查它们是否与检测到的项目根目录兼容
    if (diffFilePaths.length > 0) {
      // 对于相对路径，验证它们是否可能存在于项目根目录下
      // 注意：新文件可能不存在，所以只做基本验证
      const isValid = diffFilePaths.every(filePath => {
        // 如果路径是绝对路径，检查是否在项目根目录下
        if (filePath.startsWith('/')) {
          return filePath.startsWith(cwdProjectRoot);
        }
        // 相对路径应该总是有效的（相对于项目根目录）
        return true;
      });
      
      if (!isValid) {
        logger.warn(
          `检测到的项目根目录与 diff 文件路径不兼容。` +
          `项目根目录: ${cwdProjectRoot}, ` +
          `文件路径: ${diffFilePaths.join(', ')}`
        );
      }
    }
    
    const result = analyzeProjectRoot(cwdProjectRoot);
    return {
      root: cwdProjectRoot,
      ...result,
    };
  }

  // 5. 如果都无法检测到，抛出明确的错误
  const cwd = process.cwd();
  throw new Error(
    `无法检测到项目根目录。\n` +
    `当前工作目录: ${cwd}\n` +
    `diff 文件路径: ${diffFilePaths.length > 0 ? diffFilePaths.join(', ') : '无'}\n\n` +
    `可能原因：\n` +
    `1. diff 中没有文件路径信息\n` +
    `2. 项目根目录不在常见位置（从当前目录向上查找未找到 package.json）\n\n` +
    `解决方案：\n` +
    `1. 通过环境变量 PROJECT_ROOT 手动指定项目根目录\n` +
    `2. 或在 MCP 配置的 env 字段中设置 PROJECT_ROOT\n\n` +
    `提示：diff 中的文件路径是相对路径（相对于项目根目录），` +
    `因此需要确定项目根目录才能正确解析文件路径。`
  );
}

/**
 * 从 diff 文件路径列表查找项目根目录
 * 
 * 核心思路：对于相对路径（如 `spa/overseas-oa/src/components/Button.tsx`），
 * 我们需要在文件系统中搜索包含这个目录结构的项目根目录。
 * 
 * @param diffFilePaths - diff 中的文件路径列表（通常是相对路径）
 * @returns 项目根目录，如果找不到返回 null
 */
function findProjectRootFromDiffPaths(diffFilePaths: string[]): string | null {
  if (diffFilePaths.length === 0) {
    return null;
  }

  // 策略 1: 如果文件路径是绝对路径，直接从其路径向上查找
  for (const filePath of diffFilePaths) {
    if (filePath.startsWith('/')) {
      const root = findProjectRootFromFilePath(filePath);
      if (root) {
        logger.info(`Found project root from absolute path: ${root}`);
        return root;
      }
    }
  }
  
  // 策略 2: 对于相对路径，通过查找包含该路径结构的目录来定位项目根目录
  // 例如：`spa/overseas-oa/src/components/Button.tsx` -> 搜索包含 `spa/overseas-oa` 目录结构的项目根目录
  
  // 提取路径的前几个段作为搜索线索（通常前 1-2 段就足够）
  const pathSegments = diffFilePaths[0]?.split('/').filter(Boolean) || [];
  if (pathSegments.length === 0) {
    return null;
  }
  
  // 使用前 2 个路径段作为搜索线索（对于 monorepo，通常是 `spa/overseas-oa`）
  const searchKey = pathSegments.slice(0, 2).join('/');
  const firstSegment = pathSegments[0];
  
  logger.info(`Searching for project root using path segments: ${searchKey} (first: ${firstSegment})`);
  
  // 策略 2a: 从当前工作目录开始，向上查找包含该路径结构的目录
  const cwd = process.cwd();
  let searchPath = cwd;
  let depth = 0;
  const maxDepth = 15;
  
  while (depth < maxDepth) {
    // 检查当前目录是否包含该路径结构
    const segmentPath = join(searchPath, firstSegment);
    if (existsSync(segmentPath)) {
      // 对于多段路径，检查更深层的结构
      if (pathSegments.length > 1) {
        const deeperPath = join(searchPath, pathSegments[0], pathSegments[1]);
        if (!existsSync(deeperPath)) {
          // 如果深层路径不存在，继续向上查找
          const parentPath = dirname(searchPath);
          if (parentPath === searchPath) {
            break;
          }
          searchPath = parentPath;
          depth++;
          continue;
        }
      }
      
      // 找到包含该路径结构的目录，向上查找项目根目录（通过 .cursorrules 或 package.json）
      const root = findProjectRootFromFilePath(searchPath);
      if (root) {
        // 验证：检查该根目录下是否真的包含 diff 文件路径的目录结构
        const verifyPath = join(root, firstSegment);
        if (existsSync(verifyPath)) {
          logger.info(`Found project root by path structure: ${root}`);
          return root;
        }
      }
    }
    
    // 继续向上查找
    const parentPath = dirname(searchPath);
    if (parentPath === searchPath) {
      break;
    }
    searchPath = parentPath;
    depth++;
  }
  
  // 策略 2b: 尝试从常见项目目录位置搜索
  // 例如：~/web, ~/projects, ~/work 等
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) {
    const commonDirs = [
      join(homeDir, 'web'),
      join(homeDir, 'projects'),
      join(homeDir, 'work'),
      join(homeDir, 'code'),
      join(homeDir, 'dev'),
    ];
    
    for (const commonDir of commonDirs) {
      if (existsSync(commonDir)) {
        const root = searchProjectRootInDirectory(commonDir, firstSegment);
        if (root) {
          logger.info(`Found project root in common directory: ${root}`);
          return root;
        }
      }
    }
  }
  
  return null;
}

/**
 * 在指定目录及其子目录中搜索项目根目录
 * 
 * @param searchDir - 搜索起始目录
 * @param pathSegment - 路径段（如 "spa"）
 * @returns 项目根目录，如果找不到返回 null
 */
function searchProjectRootInDirectory(searchDir: string, pathSegment: string): string | null {
  try {
    // 检查当前目录是否包含该路径段
    const segmentPath = join(searchDir, pathSegment);
    if (existsSync(segmentPath)) {
      // 向上查找 package.json
      const root = findProjectRootFromFilePath(searchDir);
      if (root) {
        const packageJsonPath = join(root, 'package.json');
        if (existsSync(packageJsonPath)) {
          return root;
        }
      }
    }
    
    // 递归搜索子目录（限制深度，避免搜索 node_modules）
    const entries = readdirSync(searchDir, { withFileTypes: true });
    
    for (const entry of entries) {
      // 跳过隐藏目录和 node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      
      if (entry.isDirectory()) {
        const subDir = join(searchDir, entry.name);
        const result = searchProjectRootInDirectory(subDir, pathSegment);
        if (result) {
          return result;
        }
      }
    }
  } catch (error) {
    // 忽略权限错误等
  }
  
  return null;
}

/**
 * 从文件路径向上查找项目根目录
 * 
 * 检测优先级：
 * 1. .cursorrules 文件（Cursor 项目标识）
 * 2. package.json 文件（Node.js 项目标识）
 * 
 * @param filePath - 文件路径（可以是绝对路径或相对路径）
 * @returns 项目根目录，如果找不到返回 null
 */
function findProjectRootFromFilePath(filePath: string): string | null {
  // 如果是绝对路径，直接使用
  let currentPath = filePath.startsWith('/') 
    ? dirname(filePath) 
    : resolve(process.cwd(), dirname(filePath));

  // 如果文件路径本身就是一个文件（不是目录），先获取其目录
  if (existsSync(currentPath)) {
    try {
      const stats = statSync(currentPath);
      if (!stats.isDirectory()) {
        currentPath = dirname(currentPath);
      }
    } catch {
      // 忽略错误，继续处理
    }
  }

  // 向上查找项目根目录标识文件
  let depth = 0;
  const maxDepth = 10;

  while (depth < maxDepth) {
    // 优先检查 .cursorrules（Cursor 项目标识）
    const cursorRulesPath = join(currentPath, '.cursorrules');
    if (existsSync(cursorRulesPath)) {
      return currentPath;
    }
    
    // 检查 package.json
    const packageJsonPath = join(currentPath, 'package.json');
    if (existsSync(packageJsonPath)) {
      return currentPath;
    }

    // 到达根目录
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }

    currentPath = parentPath;
    depth++;
  }

  return null;
}

/**
 * 分析项目根目录，判断是否为 monorepo
 * 
 * @param rootPath - 项目根目录
 * @returns 分析结果
 */
function analyzeProjectRoot(rootPath: string): Omit<ProjectRoot, 'root'> {
  // 检查是否为 monorepo
  const monorepoIndicators = [
    { file: 'pnpm-workspace.yaml', type: 'pnpm' as const },
    { file: 'lerna.json', type: 'lerna' as const },
    { file: 'rush.json', type: 'rush' as const },
  ];

  for (const { file, type } of monorepoIndicators) {
    if (existsSync(join(rootPath, file))) {
      logger.info(`Detected ${type} monorepo`);
      return {
        isMonorepo: true,
        workspaceType: type,
      };
    }
  }

  // 检查 package.json 中的 workspaces 字段
  const packageJsonPath = join(rootPath, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      
      if (packageJson.workspaces) {
        // Yarn/NPM workspaces
        const workspaceType = existsSync(join(rootPath, 'yarn.lock')) ? 'yarn' : 'npm';
        logger.info(`Detected ${workspaceType} monorepo (via package.json workspaces)`);
        return {
          isMonorepo: true,
          workspaceType,
        };
      }
    } catch (error) {
      logger.warn('Failed to parse package.json', { error });
    }
  }

  // 不是 monorepo
  return {
    isMonorepo: false,
  };
}

/**
 * 根据 monorepo 结构找到子包的根目录
 * 
 * @param monorepoRoot - monorepo 根目录
 * @param filePath - 文件路径
 * @returns 子包根目录，如果找不到返回 monorepo 根目录
 */
export function findPackageRootInMonorepo(
  monorepoRoot: string,
  filePath: string
): string {
  // 从文件路径向上查找最近的 package.json
  let currentPath = filePath.startsWith('/')
    ? dirname(filePath)
    : resolve(monorepoRoot, dirname(filePath));

  while (currentPath.startsWith(monorepoRoot) && currentPath !== monorepoRoot) {
    const packageJsonPath = join(currentPath, 'package.json');
    
    if (existsSync(packageJsonPath)) {
      // 确认这个 package.json 不是 monorepo 根的 package.json
      if (currentPath !== monorepoRoot) {
        return currentPath;
      }
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }

  return monorepoRoot;
}

/**
 * 检测侧车项目目录（.local-tests）
 * 
 * 侧车项目是 monorepo 中的一种特殊模式，测试配置在子包根目录下的 `.local-tests` 目录中。
 * 
 * @param packageRoot - 子包根目录
 * @returns 如果存在侧车项目目录，返回其路径；否则返回 null
 */
function findSidecarTestDir(packageRoot: string): string | null {
  const sidecarDir = join(packageRoot, '.local-tests');
  if (existsSync(sidecarDir)) {
    try {
      const stats = statSync(sidecarDir);
      if (stats.isDirectory()) {
        logger.info(`Found sidecar test directory: ${sidecarDir}`);
        return sidecarDir;
      }
    } catch {
      // 忽略错误
    }
  }
  return null;
}

/**
 * 获取测试框架检测的目标目录
 * 
 * 检测优先级：
 * 1. 对于 monorepo：优先检测侧车项目目录（.local-tests）
 * 2. 如果不存在侧车项目，检测子包的测试框架配置
 * 3. 如果子包没有，回退到 monorepo 根目录
 * 4. 对于普通项目：直接使用项目根目录
 * 
 * @param projectRoot - 项目根目录信息
 * @param sampleFilePath - 示例文件路径（用于定位子包）
 * @returns 用于检测测试框架的目录
 */
export function getTestStackDetectionPath(
  projectRoot: ProjectRoot,
  sampleFilePath?: string
): string {
  // 普通项目：直接使用项目根目录
  if (!projectRoot.isMonorepo || !sampleFilePath) {
    // 即使不是 monorepo，也检查是否有侧车项目目录
    const sidecarDir = findSidecarTestDir(projectRoot.root);
    if (sidecarDir) {
      logger.info(`Test stack detection path: ${sidecarDir} (sidecar project)`);
      return sidecarDir;
    }
    return projectRoot.root;
  }

  // Monorepo：先找到子包根目录
  const packageRoot = findPackageRootInMonorepo(projectRoot.root, sampleFilePath);
  
  // 检查是否存在侧车项目目录（.local-tests）
  const sidecarDir = findSidecarTestDir(packageRoot);
  if (sidecarDir) {
    logger.info(`Test stack detection path: ${sidecarDir} (sidecar project in monorepo)`);
    return sidecarDir;
  }
  
  // 如果没有侧车项目，使用子包根目录
  logger.info(`Test stack detection path: ${packageRoot} (monorepo package)`);
  return packageRoot;
}

