/**
 * ProjectDetector - 检测项目配置（Monorepo、测试框架、已有测试等）
 */

import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';
import { logger } from '../utils/logger.js';

export interface ProjectConfig {
  projectRoot: string;
  packageRoot?: string; // Monorepo 子项目根目录（主要的）
  isMonorepo: boolean;
  monorepoType?: 'pnpm' | 'yarn' | 'npm' | 'lerna' | 'nx' | 'rush';
  testFramework?: 'vitest' | 'jest' | 'none';
  hasExistingTests: boolean;
  testPattern?: string;
  customRules?: string; // 从 .cursor/rules/test-strategy.md 读取
  affectedSubProjects?: string[]; // 所有受影响的子项目
  testableSubProjects?: string[]; // 需要生成测试的子项目（有测试框架的）
}

export class ProjectDetector {
  /**
   * 检测项目配置
   * @param workDir 项目根目录
   * @param packageRoot 主要子项目根目录（可选）
   * @param changedFiles 变更文件列表（可选，用于 monorepo 分析）
   */
  async detectProject(
    workDir: string,
    packageRoot?: string,
    changedFiles?: string[]
  ): Promise<ProjectConfig> {
    logger.info('[ProjectDetector] Detecting project', { workDir, packageRoot, changedFilesCount: changedFiles?.length });

    const isMonorepo = await this.detectMonorepo(workDir);
    const monorepoType = isMonorepo ? await this.detectMonorepoType(workDir) : undefined;
    
    // 分析 Monorepo 子项目（如果提供了变更文件）
    let affectedSubProjects: string[] | undefined;
    let testableSubProjects: string[] | undefined;
    
    if (isMonorepo && changedFiles && changedFiles.length > 0) {
      affectedSubProjects = await this.detectSubProjects(workDir, changedFiles);
      if (affectedSubProjects.length > 0) {
        testableSubProjects = await this.filterTestableSubProjects(affectedSubProjects);
        logger.info('[ProjectDetector] Monorepo analysis', {
          affected: affectedSubProjects.length,
          testable: testableSubProjects.length,
          affectedList: affectedSubProjects,
          testableList: testableSubProjects,
        });
      }
    }
    
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
      affectedSubProjects,
      testableSubProjects,
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
      affectedSubProjects: config.affectedSubProjects?.length || 0,
      testableSubProjects: config.testableSubProjects?.length || 0,
    });

    return config;
  }

  /**
   * 检测 Monorepo 子项目（根据变更文件）
   */
  async detectSubProject(workDir: string, changedFiles: string[]): Promise<string | undefined> {
    const candidates = await this.detectSubProjects(workDir, changedFiles);
    return candidates.length > 0 ? candidates[0] : undefined;
  }

  /**
   * 检测所有受影响的子项目
   * 返回按变更文件数量排序的列表
   */
  async detectSubProjects(workDir: string, changedFiles: string[]): Promise<string[]> {
    if (changedFiles.length === 0) {
      return [];
    }

    const subDirs = await this.findMonorepoSubDirs(workDir);
    if (subDirs.length === 0) {
      return [];
    }

    const subProjectCounts = new Map<string, { count: number; files: string[] }>();
    for (const file of changedFiles) {
      for (const subDir of subDirs) {
        if (file.startsWith(subDir + '/')) {
          const record = subProjectCounts.get(subDir) || { count: 0, files: [] };
          record.count += 1;
          record.files.push(file);
          subProjectCounts.set(subDir, record);
        }
      }
    }

    const sorted = Array.from(subProjectCounts.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .map(([subProject]) => path.join(workDir, subProject));

    if (sorted.length > 0) {
      logger.info('[ProjectDetector] Sub-projects detected', {
        candidates: sorted,
        details: Array.from(subProjectCounts.entries()),
      });
    }

    return sorted;
  }

  /**
   * 查找 Monorepo 子项目目录（packages/*, apps/*, libs/* 等）
   */
  private async findMonorepoSubDirs(workDir: string): Promise<string[]> {
    const potentialDirs = [
      'packages',
      'apps',
      'libs',
      'services',
      'modules',
      'packages/*', // pnpm workspace 可在 pnpm-workspace.yaml 中定义
    ];

    const result = new Set<string>();

    for (const dir of potentialDirs) {
      if (dir === 'packages/*') {
        continue; // 先跳过，需要根据 pnpm-workspace.yaml 等配置具体解析
      }

      const fullPath = path.join(workDir, dir);
      if (!existsSync(fullPath)) {
        continue;
      }

      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      entries
        .filter((entry) => entry.isDirectory())
        .forEach((entry) => {
          result.add(path.join(dir, entry.name));
        });
    }

    return Array.from(result);
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
   * 检查子项目是否应该生成测试
   * 条件：1) 有测试框架  2) 不是纯类型/工具包
   */
  async shouldGenerateTests(subProjectPath: string): Promise<boolean> {
    const framework = await this.detectTestFramework(subProjectPath);
    
    // 没有测试框架，不生成测试
    if (framework === 'none') {
      logger.info('[ProjectDetector] No test framework, skipping', { path: subProjectPath });
      return false;
    }

    // 检查是否是纯类型包或工具包（通常不需要测试）
    const packageJsonPath = path.join(subProjectPath, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const content = await fs.readFile(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(content);
        
        // 检查包名，如果是 types, constants, interfaces 等纯定义包，可能不需要测试
        const name = packageJson.name || '';
        const lowercaseName = name.toLowerCase();
        
        // 如果明确标记为类型包
        if (packageJson.types && !packageJson.main && !packageJson.module) {
          logger.info('[ProjectDetector] Pure types package, skipping', { name, path: subProjectPath });
          return false;
        }

        // 常见的不需要测试的包名模式
        const skipPatterns = [
          /^@.*\/types$/,         // @xxx/types
          /^.*-types$/,           // xxx-types
          /^types-/,              // types-xxx
          /^@.*\/constants$/,     // @xxx/constants
          /^.*-constants$/,       // xxx-constants
        ];

        if (skipPatterns.some(pattern => pattern.test(lowercaseName))) {
          logger.info('[ProjectDetector] Utility/types package, skipping', { name, path: subProjectPath });
          return false;
        }
      } catch (error) {
        logger.warn('[ProjectDetector] Failed to check package.json', { path: subProjectPath, error });
      }
    }

    // 有测试框架且不是工具包，应该生成测试
    logger.info('[ProjectDetector] Should generate tests', { path: subProjectPath, framework });
    return true;
  }

  /**
   * 筛选需要生成测试的子项目
   */
  async filterTestableSubProjects(subProjects: string[]): Promise<string[]> {
    const results = await Promise.all(
      subProjects.map(async (subProject) => {
        const shouldGenerate = await this.shouldGenerateTests(subProject);
        return { subProject, shouldGenerate };
      })
    );

    const testable = results
      .filter((r) => r.shouldGenerate)
      .map((r) => r.subProject);

    logger.info('[ProjectDetector] Testable sub-projects', {
      total: subProjects.length,
      testable: testable.length,
      skipped: subProjects.length - testable.length,
      testableList: testable,
    });

    return testable;
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
