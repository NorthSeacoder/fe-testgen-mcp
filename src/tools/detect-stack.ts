import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { logger } from '../utils/logger.js';
import type { TestStack } from '../schemas/test-plan.js';

/**
 * 探测项目测试栈
 * 
 * 支持侧车项目（.local-tests）：
 * - 如果检测路径是 `.local-tests` 目录，优先在该目录中查找配置文件
 * - 如果 `.local-tests` 中没有 package.json，会查找父目录的 package.json
 */
export async function detectProjectTestStack(repoRoot: string = process.cwd()): Promise<TestStack> {
  // 首先检查当前目录的 package.json
  let packageJsonPath = join(repoRoot, 'package.json');
  let packageJson: any = null;
  let packageRoot = repoRoot;
  
  // 如果当前目录没有 package.json，且是 .local-tests 目录，尝试查找父目录
  if (!existsSync(packageJsonPath)) {
    const parentPath = dirname(repoRoot);
    const parentPackageJsonPath = join(parentPath, 'package.json');
    
    if (existsSync(parentPackageJsonPath)) {
      logger.info(`package.json not found in ${repoRoot}, using parent directory: ${parentPath}`);
      packageJsonPath = parentPackageJsonPath;
      packageRoot = parentPath;
    } else {
      logger.warn(`package.json not found in ${repoRoot} or parent directory`);
      return { unit: null };
    }
  }

  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

    // 检查配置文件：优先在检测路径（可能是 .local-tests）中查找
    const vitestConfigs = [
      'vitest.config.ts',
      'vitest.config.js',
      'vitest.config.mts',
      'vitest.config.mjs',
    ];
    
    const jestConfigs = [
      'jest.config.ts',
      'jest.config.js',
      'jest.config.mts',
      'jest.config.mjs',
      'jest.config.json',
    ];

    // 检查 vitest
    if (deps.vitest || deps['@vitest/ui']) {
      // 优先在检测路径中查找配置文件
      for (const config of vitestConfigs) {
        const configPath = join(repoRoot, config);
        if (existsSync(configPath)) {
          logger.info(`Detected Vitest from ${configPath}`);
          return { unit: 'vitest' };
        }
      }
      
      // 如果检测路径中没有，尝试在父目录（packageRoot）中查找
      if (repoRoot !== packageRoot) {
        for (const config of vitestConfigs) {
          const configPath = join(packageRoot, config);
          if (existsSync(configPath)) {
            logger.info(`Detected Vitest from ${configPath} (parent directory)`);
            return { unit: 'vitest' };
          }
        }
      }

      // 即使没有配置文件，如果有依赖也返回 vitest
      logger.info('Detected Vitest from dependencies');
      return { unit: 'vitest' };
    }

    // 检查 jest
    if (deps.jest || deps['@jest/globals']) {
      // 优先在检测路径中查找配置文件
      for (const config of jestConfigs) {
        const configPath = join(repoRoot, config);
        if (existsSync(configPath)) {
          logger.info(`Detected Jest from ${configPath}`);
          return { unit: 'jest' };
        }
      }
      
      // 如果检测路径中没有，尝试在父目录（packageRoot）中查找
      if (repoRoot !== packageRoot) {
        for (const config of jestConfigs) {
          const configPath = join(packageRoot, config);
          if (existsSync(configPath)) {
            logger.info(`Detected Jest from ${configPath} (parent directory)`);
            return { unit: 'jest' };
          }
        }
      }

      logger.info('Detected Jest from dependencies');
      return { unit: 'jest' };
    }

    logger.info('No test framework detected');
    return { unit: null };
  } catch (error) {
    logger.error('Failed to detect test stack', { error });
    return { unit: null };
  }
}

