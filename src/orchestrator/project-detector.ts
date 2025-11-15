/**
 * ProjectDetector - 检测项目配置（Monorepo、测试框架、已有测试等）
 */

import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';
import { logger } from '../utils/logger.js';

export interface ProjectConfig {
  projectRoot: string;
  packageRoot?: string; // Monorepo 子项目根目录
  isMonorepo: boolean;
  monorepoType?: 'pnpm' | 'yarn' | 'npm' | 'lerna' | 'nx' | 'rush';
  testFramework?: 'vitest' | 'jest' | 'none';
  hasExistingTests: boolean;
  testPattern?: string;
  customRules?: string; // 从 .cursor/rule/fe-mcp.md 读取
}

export class ProjectDetector {
  /**
   * 检测项目配置
   */
  async detectProject(workDir: string, packageRoot?: string): Promise<ProjectConfig> {
    logger.info('[ProjectDetector] Detecting project', { workDir, packageRoot });

    const isMonorepo = await this.detectMonorepo(workDir);
    const monorepoType = isMonorepo ? await this.detectMonorepoType(workDir) : undefined;
    
    // 加载自定义规则（优先从 packageRoot 加载，如果是 monorepo）
    const effectiveRoot = packageRoot || workDir;
    const customRules = await this.loadCustomRules(effectiveRoot, workDir);
    
    // 从自定义规则中解析测试框架
    const frameworkFromRules = customRules ? this.parseTestFrameworkFromRules(customRules) : undefined;
    
    // 如果规则中有指定测试框架，就使用；否则自动检测
    const testFramework = frameworkFromRules || await this.detectTestFramework(effectiveRoot);
    
    const hasExistingTests = await this.detectExistingTests(effectiveRoot);
    const testPattern = this.getTestPattern(testFramework);

    const config: ProjectConfig = {
      projectRoot: workDir,
      packageRoot,
      isMonorepo,
      monorepoType,
      testFramework,
      hasExistingTests,
      testPattern,
      customRules,
    };

    logger.info('[ProjectDetector] Project detected', {
      projectRoot: config.projectRoot,
      isMonorepo: config.isMonorepo,
      monorepoType: config.monorepoType,
      testFramework: config.testFramework,
      hasExistingTests: config.hasExistingTests,
      packageRoot: config.packageRoot,
      customRulesLoaded: Boolean(config.customRules),
      frameworkFromRules: Boolean(frameworkFromRules),
    });

    return config;
  }

  /**
   * 检测 Monorepo 子项目（根据变更文件）
   */
  async detectSubProject(workDir: string, changedFiles: string[]): Promise<string | undefined> {
    if (changedFiles.length === 0) {
      return undefined;
    }

    // 查找 packages/ 或 apps/ 目录
    const packagesDir = path.join(workDir, 'packages');
    const appsDir = path.join(workDir, 'apps');

    let subDirs: string[] = [];

    if (existsSync(packagesDir)) {
      const entries = await fs.readdir(packagesDir, { withFileTypes: true });
      subDirs.push(...entries.filter((e) => e.isDirectory()).map((e) => path.join('packages', e.name)));
    }

    if (existsSync(appsDir)) {
      const entries = await fs.readdir(appsDir, { withFileTypes: true });
      subDirs.push(...entries.filter((e) => e.isDirectory()).map((e) => path.join('apps', e.name)));
    }

    if (subDirs.length === 0) {
      return undefined;
    }

    // 统计每个子项目的变更文件数
    const subProjectCounts = new Map<string, number>();
    for (const file of changedFiles) {
      for (const subDir of subDirs) {
        if (file.startsWith(subDir + '/')) {
          subProjectCounts.set(subDir, (subProjectCounts.get(subDir) || 0) + 1);
        }
      }
    }

    if (subProjectCounts.size === 0) {
      return undefined;
    }

    // 返回变更最多的子项目
    let maxCount = 0;
    let maxSubProject: string | undefined;
    for (const [subProject, count] of subProjectCounts) {
      if (count > maxCount) {
        maxCount = count;
        maxSubProject = subProject;
      }
    }

    if (maxSubProject) {
      logger.info('[ProjectDetector] Sub-project detected', { subProject: maxSubProject, changedFiles: maxCount });
      return path.join(workDir, maxSubProject);
    }

    return undefined;
  }

  /**
   * 检测是否为 Monorepo
   */
  private async detectMonorepo(workDir: string): Promise<boolean> {
    const indicators = [
      'pnpm-workspace.yaml',
      'lerna.json',
      'nx.json',
      'rush.json',
    ];

    for (const indicator of indicators) {
      if (existsSync(path.join(workDir, indicator))) {
        return true;
      }
    }

    // 检查 package.json 的 workspaces 字段
    const packageJsonPath = path.join(workDir, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const content = await fs.readFile(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(content);
        if (packageJson.workspaces) {
          return true;
        }
      } catch (error) {
        logger.warn('[ProjectDetector] Failed to parse package.json', { workDir, error });
      }
    }

    return false;
  }

  /**
   * 检测 Monorepo 类型
   */
  private async detectMonorepoType(workDir: string): Promise<'pnpm' | 'yarn' | 'npm' | 'lerna' | 'nx' | 'rush'> {
    if (existsSync(path.join(workDir, 'pnpm-workspace.yaml'))) {
      return 'pnpm';
    }
    if (existsSync(path.join(workDir, 'lerna.json'))) {
      return 'lerna';
    }
    if (existsSync(path.join(workDir, 'nx.json'))) {
      return 'nx';
    }
    if (existsSync(path.join(workDir, 'rush.json'))) {
      return 'rush';
    }
    if (existsSync(path.join(workDir, 'yarn.lock'))) {
      return 'yarn';
    }
    if (existsSync(path.join(workDir, 'package-lock.json'))) {
      return 'npm';
    }
    return 'npm';
  }

  /**
   * 检测测试框架
   */
  private async detectTestFramework(workDir: string): Promise<'vitest' | 'jest' | 'none'> {
    const packageJsonPath = path.join(workDir, 'package.json');
    if (!existsSync(packageJsonPath)) {
      return 'none';
    }

    try {
      const content = await fs.readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(content);
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

      if (deps['vitest'] || deps['@vitest/ui']) {
        return 'vitest';
      }
      if (deps['jest'] || deps['@types/jest']) {
        return 'jest';
      }
    } catch (error) {
      logger.warn('[ProjectDetector] Failed to parse package.json', { workDir, error });
    }

    return 'none';
  }

  /**
   * 检测是否已有测试文件
   */
  private async detectExistingTests(workDir: string): Promise<boolean> {
    const testPatterns = [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.test.js',
      '**/*.test.jsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/*.spec.js',
      '**/*.spec.jsx',
    ];

    // 简单递归查找（最多 2 层）
    return this.hasFilesWithExtension(workDir, testPatterns, 2);
  }

  /**
   * 递归查找文件（深度限制）
   */
  private async hasFilesWithExtension(
    dir: string,
    patterns: string[],
    maxDepth: number,
    currentDepth: number = 0
  ): Promise<boolean> {
    if (currentDepth > maxDepth) {
      return false;
    }

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        // 跳过 node_modules, .git 等
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build') {
          continue;
        }

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          const found = await this.hasFilesWithExtension(fullPath, patterns, maxDepth, currentDepth + 1);
          if (found) {
            return true;
          }
        } else if (entry.isFile()) {
          for (const pattern of patterns) {
            const ext = pattern.replace('**/*', '');
            if (entry.name.endsWith(ext)) {
              return true;
            }
          }
        }
      }
    } catch (error) {
      logger.warn('[ProjectDetector] Failed to read directory', { dir, error });
    }

    return false;
  }

  /**
   * 获取测试文件模式
   */
  private getTestPattern(framework?: string): string {
    if (framework === 'vitest') {
      return '**/*.{test,spec}.{ts,tsx,js,jsx}';
    }
    if (framework === 'jest') {
      return '**/*.{test,spec}.{ts,tsx,js,jsx}';
    }
    return '**/*.{test,spec}.{ts,tsx,js,jsx}';
  }

  /**
   * 加载自定义规则
   * 只读取 .cursor/rules/test-strategy.md
   * 如果是 monorepo，优先从子项目根目录查找
   */
  private async loadCustomRules(primaryRoot: string, projectRoot?: string): Promise<string | undefined> {
    const ruleFileName = '.cursor/rules/test-strategy.md';

    // 1. 优先从 primaryRoot（可能是子项目根目录）查找
    const primaryPath = path.join(primaryRoot, ruleFileName);
    if (existsSync(primaryPath)) {
      try {
        const content = await fs.readFile(primaryPath, 'utf-8');
        logger.info('[ProjectDetector] Custom rules loaded', { path: primaryPath });
        return content;
      } catch (error) {
        logger.warn('[ProjectDetector] Failed to load custom rules', { path: primaryPath, error });
      }
    }

    // 2. 如果 primaryRoot 与 projectRoot 不同（monorepo场景），再尝试从项目根目录查找
    if (projectRoot && projectRoot !== primaryRoot) {
      const fallbackPath = path.join(projectRoot, ruleFileName);
      if (existsSync(fallbackPath)) {
        try {
          const content = await fs.readFile(fallbackPath, 'utf-8');
          logger.info('[ProjectDetector] Custom rules loaded from project root', { path: fallbackPath });
          return content;
        } catch (error) {
          logger.warn('[ProjectDetector] Failed to load custom rules from project root', { path: fallbackPath, error });
        }
      }
    }

    logger.debug('[ProjectDetector] No custom rules found', { primaryRoot, projectRoot });
    return undefined;
  }

  /**
   * 从自定义规则中解析测试框架
   * 查找类似 "测试框架: vitest" 或 "framework: jest" 的配置
   */
  private parseTestFrameworkFromRules(rules: string): 'vitest' | 'jest' | undefined {
    // 匹配模式：测试框架: vitest, framework: jest, test framework: vitest等
    const patterns = [
      /测试框架[：:]\s*(vitest|jest)/i,
      /framework[：:]\s*(vitest|jest)/i,
      /test\s+framework[：:]\s*(vitest|jest)/i,
    ];

    for (const pattern of patterns) {
      const match = rules.match(pattern);
      if (match) {
        const framework = match[1].toLowerCase();
        if (framework === 'vitest' || framework === 'jest') {
          logger.info('[ProjectDetector] Test framework found in rules', { framework });
          return framework;
        }
      }
    }

    return undefined;
  }
}
