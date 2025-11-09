/**
 * WriteTestFileTool - 写入测试文件到磁盘
 *
 * 职责：
 * 1. 将生成的测试代码写入文件
 * 2. 创建必要的目录结构
 * 3. 支持预览模式
 */

import { BaseTool, ToolMetadata } from '../core/base-tool.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import type { TestCase } from '../schemas/test-plan.js';

export interface WriteTestFileInput {
  tests: TestCase[];
  projectRoot?: string; // 项目根目录（必需，用于解析相对路径）
  dryRun?: boolean; // 预览模式，不实际写入（默认 false）
  overwrite?: boolean; // 是否覆盖已存在的文件（默认 false）
}

export interface WriteTestFileOutput {
  filesWritten: string[];
  filesSkipped: string[];
  filesFailed: string[];
  dryRun: boolean;
  summary: {
    totalFiles: number;
    totalTests: number;
    byFramework: Record<string, number>;
  };
}

export class WriteTestFileTool extends BaseTool<WriteTestFileInput, WriteTestFileOutput> {
  getMetadata(): ToolMetadata {
    return {
      name: 'write-test-file',
      description:
        '将生成的测试代码写入文件到磁盘。\n\n' +
        '💡 特性：\n' +
        '• 自动创建目录结构\n' +
        '• 支持预览模式（dryRun）\n' +
        '• 防止覆盖已存在文件（可配置）\n' +
        '• 按测试文件分组写入\n\n' +
        '📁 文件路径：\n' +
        '• 使用 TestCase 中的 testFile 字段\n' +
        '• 必须提供 projectRoot 进行路径解析\n\n' +
        '⚠️ 注意：\n' +
        '• 默认不覆盖已存在的测试文件\n' +
        '• 设置 overwrite=true 以允许覆盖',
      inputSchema: {
        type: 'object',
        properties: {
          tests: {
            type: 'array',
            items: { type: 'object' },
            description: '测试用例列表',
          },
          projectRoot: {
            type: 'string',
            description: '项目根目录绝对路径（必需）',
          },
          dryRun: {
            type: 'boolean',
            description: '预览模式，不实际写入（默认 false）',
          },
          overwrite: {
            type: 'boolean',
            description: '是否覆盖已存在的文件（默认 false）',
          },
        },
        required: ['tests'],
      },
      category: 'file-operations',
      version: '3.0.0',
    };
  }

  protected async executeImpl(input: WriteTestFileInput): Promise<WriteTestFileOutput> {
    const { tests, projectRoot = process.cwd(), dryRun = false, overwrite = false } = input;

    const filesWritten: string[] = [];
    const filesSkipped: string[] = [];
    const filesFailed: string[] = [];
    const byFramework: Record<string, number> = {};

    // 按测试文件分组
    const testsByFile = new Map<string, TestCase[]>();
    for (const test of tests) {
      const testFile = test.testFile;
      if (!testsByFile.has(testFile)) {
        testsByFile.set(testFile, []);
      }
      testsByFile.get(testFile)!.push(test);

      // 统计框架
      byFramework[test.framework] = (byFramework[test.framework] || 0) + 1;
    }

    logger.info('[WriteTestFileTool] Writing tests to files', {
      totalTests: tests.length,
      totalFiles: testsByFile.size,
      dryRun,
      overwrite,
    });

    // 写入每个测试文件
    for (const [testFile, testCases] of testsByFile.entries()) {
      const absolutePath = join(projectRoot, testFile);

      // 检查文件是否已存在
      if (!overwrite && existsSync(absolutePath)) {
        logger.warn('[WriteTestFileTool] File already exists, skipping', {
          file: testFile,
        });
        filesSkipped.push(testFile);
        continue;
      }

      // 生成测试文件内容
      const fileContent = this.generateTestFileContent(testCases);

      if (dryRun) {
        logger.info('[WriteTestFileTool] [DRY-RUN] Would write file', {
          file: testFile,
          tests: testCases.length,
          preview: fileContent.substring(0, 200),
        });
        filesWritten.push(testFile);
      } else {
        try {
          // 创建目录
          const dir = dirname(absolutePath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }

          // 写入文件
          writeFileSync(absolutePath, fileContent, 'utf-8');
          filesWritten.push(testFile);

          logger.info('[WriteTestFileTool] File written successfully', {
            file: testFile,
            tests: testCases.length,
          });
        } catch (error) {
          logger.error('[WriteTestFileTool] Failed to write file', {
            file: testFile,
            error,
          });
          filesFailed.push(testFile);
        }
      }
    }

    logger.info('[WriteTestFileTool] Writing completed', {
      written: filesWritten.length,
      skipped: filesSkipped.length,
      failed: filesFailed.length,
      dryRun,
    });

    return {
      filesWritten,
      filesSkipped,
      filesFailed,
      dryRun,
      summary: {
        totalFiles: testsByFile.size,
        totalTests: tests.length,
        byFramework,
      },
    };
  }

  protected async beforeExecute(input: WriteTestFileInput): Promise<void> {
    if (!input.tests || input.tests.length === 0) {
      throw new Error('No tests provided');
    }

    if (!input.projectRoot) {
      logger.warn('[WriteTestFileTool] projectRoot not provided, using current directory');
    }
  }

  private generateTestFileContent(tests: TestCase[]): string {
    if (tests.length === 0) {
      return '';
    }

    // 使用第一个测试的框架
    const framework = tests[0].framework || 'vitest';
    const isVitest = framework === 'vitest';

    // 生成导入语句
    let content = isVitest
      ? "import { describe, it, expect, vi } from 'vitest';\n\n"
      : "import { describe, it, expect, jest } from '@jest/globals';\n\n";

    // 添加文件头注释
    content += '/**\n';
    content += ` * Auto-generated test file\n`;
    content += ` * Framework: ${framework}\n`;
    content += ` * Tests: ${tests.length}\n`;
    content += ' */\n\n';

    // 按文件分组测试
    const testsBySourceFile = new Map<string, TestCase[]>();
    for (const test of tests) {
      const sourceFile = test.file;
      if (!testsBySourceFile.has(sourceFile)) {
        testsBySourceFile.set(sourceFile, []);
      }
      testsBySourceFile.get(sourceFile)!.push(test);
    }

    // 生成测试代码
    for (const [sourceFile, sourceTests] of testsBySourceFile.entries()) {
      content += `// Tests for ${sourceFile}\n`;
      content += `describe('${sourceFile}', () => {\n`;

      for (const test of sourceTests) {
        // 添加测试描述注释
        if (test.description) {
          content += `  // ${test.description}\n`;
        }
        content += `  // Scenario: ${test.scenario}\n`;
        content += `  // Priority: ${test.priority || 'medium'}\n`;
        content += `  // Confidence: ${(test.confidence * 100).toFixed(0)}%\n`;

        // 添加测试代码
        content += test.code;
        content += '\n\n';
      }

      content += '});\n\n';
    }

    return content;
  }
}
