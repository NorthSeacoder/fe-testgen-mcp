/**
 * RunTestsTool - 执行测试命令
 *
 * 职责：
 * 1. 执行测试框架命令
 * 2. 解析测试结果
 * 3. 返回结构化的测试报告
 */

import { z } from 'zod';
import { BaseTool, ToolMetadata } from '../core/base-tool.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../utils/logger.js';

const execAsync = promisify(exec);

// Zod schema for RunTestsInput
export const RunTestsInputSchema = z.object({
  testFiles: z.array(z.string()).optional().describe('要运行的测试文件路径（相对于 projectRoot）'),
  projectRoot: z.string().optional().describe('项目根目录绝对路径（默认当前目录）'),
  framework: z.enum(['vitest', 'jest']).optional().describe('测试框架（可选，自动检测）'),
  watch: z.boolean().optional().describe('监听模式（默认 false）'),
  coverage: z.boolean().optional().describe('生成覆盖率报告（默认 false）'),
  timeout: z.number().optional().describe('超时时间（毫秒，默认 30000）'),
});

export interface RunTestsInput {
  testFiles?: string[]; // 要运行的测试文件（可选，默认运行所有测试）
  projectRoot?: string; // 项目根目录（默认当前目录）
  framework?: 'vitest' | 'jest'; // 测试框架（可选，自动检测）
  watch?: boolean; // 监听模式（默认 false）
  coverage?: boolean; // 生成覆盖率报告（默认 false）
  timeout?: number; // 超时时间（毫秒，默认 30000）
}

export interface RunTestsOutput {
  success: boolean;
  framework: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    duration: number;
  };
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class RunTestsTool extends BaseTool<RunTestsInput, RunTestsOutput> {
  // Expose Zod schema for FastMCP
  getZodSchema() {
    return RunTestsInputSchema;
  }

  getMetadata(): ToolMetadata {
    return {
      name: 'run-tests',
      description:
        '执行测试命令并返回结果。\n\n' +
        '💡 特性：\n' +
        '• 支持 Vitest 和 Jest\n' +
        '• 可指定测试文件或运行全部\n' +
        '• 支持监听模式\n' +
        '• 支持覆盖率报告\n' +
        '• 解析测试结果统计\n\n' +
        '⚠️ 注意：\n' +
        '• 需要项目中已安装测试框架\n' +
        '• 测试文件路径相对于 projectRoot\n' +
        '• 监听模式不会自动返回（不推荐在自动化中使用）',
      inputSchema: {
        type: 'object',
        properties: {
          testFiles: {
            type: 'array',
            items: { type: 'string' },
            description: '要运行的测试文件路径（相对于 projectRoot）',
          },
          projectRoot: {
            type: 'string',
            description: '项目根目录绝对路径（默认当前目录）',
          },
          framework: {
            type: 'string',
            enum: ['vitest', 'jest'],
            description: '测试框架（可选，自动检测）',
          },
          watch: {
            type: 'boolean',
            description: '监听模式（默认 false）',
          },
          coverage: {
            type: 'boolean',
            description: '生成覆盖率报告（默认 false）',
          },
          timeout: {
            type: 'number',
            description: '超时时间（毫秒，默认 30000）',
          },
        },
      },
      category: 'test-operations',
      version: '3.0.0',
    };
  }

  protected async executeImpl(input: RunTestsInput): Promise<RunTestsOutput> {
    const {
      testFiles,
      projectRoot = process.cwd(),
      framework,
      watch = false,
      coverage = false,
      timeout = 30000,
    } = input;

    // 自动检测测试框架
    const detectedFramework = framework || (await this.detectFramework(projectRoot));

    logger.info('[RunTestsTool] Running tests', {
      framework: detectedFramework,
      testFiles: testFiles?.length || 'all',
      projectRoot,
      watch,
      coverage,
    });

    // 构建测试命令
    const command = this.buildTestCommand(detectedFramework, {
      testFiles,
      watch,
      coverage,
    });

    logger.debug('[RunTestsTool] Executing command', { command });

    // 执行测试
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    let success = false;

    try {
      const result = await execAsync(command, {
        cwd: projectRoot,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      stdout = result.stdout;
      stderr = result.stderr;
      success = true;
      logger.info('[RunTestsTool] Tests passed');
    } catch (error: any) {
      stdout = error.stdout || '';
      stderr = error.stderr || '';
      exitCode = error.code || 1;
      success = false;
      logger.warn('[RunTestsTool] Tests failed', { exitCode });
    }

    const duration = Date.now() - startTime;

    // 解析测试结果
    const summary = this.parseTestResults(stdout, stderr, detectedFramework);
    summary.duration = duration;

    logger.info('[RunTestsTool] Test execution completed', {
      success,
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      duration,
    });

    return {
      success,
      framework: detectedFramework,
      summary,
      stdout,
      stderr,
      exitCode,
    };
  }

  private async detectFramework(projectRoot: string): Promise<'vitest' | 'jest'> {
    try {
      const { detectProjectTestStack } = await import('./detect-stack.js');
      const stack = await detectProjectTestStack(projectRoot);
      return stack.unit === 'jest' ? 'jest' : 'vitest';
    } catch (error) {
      logger.warn('[RunTestsTool] Failed to detect framework, defaulting to vitest', { error });
      return 'vitest';
    }
  }

  private buildTestCommand(
    framework: string,
    options: {
      testFiles?: string[];
      watch: boolean;
      coverage: boolean;
    }
  ): string {
    const { testFiles, watch, coverage } = options;

    let command: string;

    if (framework === 'jest') {
      command = 'npx jest';
      if (watch) command += ' --watch';
      if (coverage) command += ' --coverage';
      if (testFiles && testFiles.length > 0) {
        command += ` ${testFiles.join(' ')}`;
      }
    } else {
      // vitest
      command = 'npx vitest run';
      if (watch) command = 'npx vitest'; // vitest watch mode doesn't need 'run'
      if (coverage) command += ' --coverage';
      if (testFiles && testFiles.length > 0) {
        command += ` ${testFiles.join(' ')}`;
      }
    }

    return command;
  }

  private parseTestResults(
    stdout: string,
    stderr: string,
    framework: string
  ): {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    duration: number;
  } {
    const combined = stdout + stderr;

    // Vitest 输出格式：
    // Test Files  1 passed (1)
    // Tests  3 passed (3)
    // Duration  123ms

    // Jest 输出格式：
    // Tests:       3 passed, 3 total
    // Snapshots:   0 total
    // Time:        0.123 s

    let total = 0;
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    if (framework === 'vitest') {
      // 解析 Vitest 输出
      const testMatch = combined.match(/Tests\s+(\d+)\s+passed[^(]*\((\d+)\)/i);
      if (testMatch) {
        passed = parseInt(testMatch[1], 10);
        total = parseInt(testMatch[2], 10);
      }

      const failMatch = combined.match(/Tests\s+(\d+)\s+failed/i);
      if (failMatch) {
        failed = parseInt(failMatch[1], 10);
      }

      const skipMatch = combined.match(/Tests\s+(\d+)\s+skipped/i);
      if (skipMatch) {
        skipped = parseInt(skipMatch[1], 10);
      }
    } else {
      // 解析 Jest 输出
      const testMatch = combined.match(/Tests:\s+(?:(\d+)\s+failed,\s*)?(\d+)\s+passed,\s*(\d+)\s+total/i);
      if (testMatch) {
        failed = parseInt(testMatch[1] || '0', 10);
        passed = parseInt(testMatch[2], 10);
        total = parseInt(testMatch[3], 10);
      }

      const skipMatch = combined.match(/(\d+)\s+skipped/i);
      if (skipMatch) {
        skipped = parseInt(skipMatch[1], 10);
      }
    }

    return {
      total,
      passed,
      failed,
      skipped,
      duration: 0, // Will be set by caller
    };
  }
}
