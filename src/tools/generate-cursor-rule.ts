/**
 * GenerateCursorRuleTool - 生成项目特定的 Cursor 规则配置
 * 
 * 根据项目检测结果，生成适合项目的测试生成规则文件
 */

import { z } from 'zod';
import { BaseTool } from '../core/base-tool.js';
import type { ToolMetadata } from '../core/base-tool.js';
import { getAppContext } from '../core/app-context.js';
import { logger } from '../utils/logger.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ArgsSchema = z.object({
  workspaceId: z.string().describe('工作区 ID'),
  outputPath: z.string().optional().default('.cursor/rule/fe-mcp.md').describe('输出路径（相对于项目根目录）'),
});

type GenerateCursorRuleArgs = z.infer<typeof ArgsSchema>;

interface GenerateCursorRuleOutput {
  filePath: string;
  content: string;
}

export class GenerateCursorRuleTool extends BaseTool<GenerateCursorRuleArgs, GenerateCursorRuleOutput> {
  getMetadata(): ToolMetadata {
    return {
      name: 'generate-cursor-rule',
      description: `生成项目特定的 Cursor 规则配置文件。

此工具会根据项目检测结果自动生成适合该项目的测试生成规则，包括：
- 项目信息（类型、测试框架、Monorepo 配置）
- 测试生成配置（场景优先级、最大测试数）
- 代码规范（React、Mock、断言、异步）
- Monorepo 建议
- 排除规则
- 已有测试处理策略
- 自动修复建议

**参数**：
- workspaceId: 工作区 ID（从 fetch-diff-from-repo 获取）
- outputPath: 输出路径（默认 .cursor/rule/fe-mcp.md）

**返回**：
- filePath: 生成的文件路径
- content: 文件内容`,
      inputSchema: {},
    };
  }

  getZodSchema() {
    return ArgsSchema;
  }

  async executeImpl(args: GenerateCursorRuleArgs): Promise<GenerateCursorRuleOutput> {
    const { workspaceId, outputPath } = args;

    logger.info('[GenerateCursorRule] Generating cursor rule', {
      workspaceId,
      outputPath,
    });

    const context = getAppContext();
    const { workspaceManager, projectDetector } = context;

    if (!workspaceManager) {
      throw new Error('WorkspaceManager not initialized');
    }

    if (!projectDetector) {
      throw new Error('ProjectDetector not initialized');
    }

    // 获取工作区信息
    const workspace = workspaceManager.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    const projectRoot = workspace.workDir;

    // 获取项目配置
    const projectConfig = await projectDetector.detectProject(
      projectRoot,
      workspace.packageRoot,
      []
    );

    logger.info('[GenerateCursorRule] Project config retrieved', {
      isMonorepo: projectConfig.isMonorepo,
      testFramework: projectConfig.testFramework,
    });

    // 读取模板文件
    const templatePath = resolve(__dirname, '../../docs/cursor-rule-template.md');
    let template: string;

    try {
      template = await readFile(templatePath, 'utf-8');
    } catch (error) {
      logger.error('[GenerateCursorRule] Failed to read template', { error });
      throw new Error(`Failed to read template file: ${templatePath}`);
    }

    // 替换模板变量
    const content = this.populateTemplate(template, {
      workspace,
      projectConfig,
    });

    // 写入文件
    const absoluteOutputPath = resolve(projectRoot, outputPath);
    const outputDir = dirname(absoluteOutputPath);

    try {
      if (!existsSync(outputDir)) {
        await mkdir(outputDir, { recursive: true });
      }

      await writeFile(absoluteOutputPath, content, 'utf-8');

      logger.info('[GenerateCursorRule] Cursor rule generated', {
        filePath: absoluteOutputPath,
      });

      return {
        filePath: outputPath,
        content,
      };
    } catch (error) {
      logger.error('[GenerateCursorRule] Failed to write file', { error });
      throw new Error(`Failed to write cursor rule file: ${absoluteOutputPath}`);
    }
  }

  /**
   * 填充模板变量
   */
  private populateTemplate(
    template: string,
    data: {
      workspace: any;
      projectConfig: any;
    }
  ): string {
    const { workspace, projectConfig } = data;

    const replacements: Record<string, string> = {
      '{{PROJECT_NAME}}': this.extractProjectName(workspace.repoUrl),
      '{{GENERATED_AT}}': new Date().toISOString(),
      '{{REPO_URL}}': workspace.repoUrl || 'N/A',
      '{{BRANCH}}': workspace.sourceBranch || workspace.branch || 'N/A',
      '{{BASELINE_BRANCH}}': workspace.baselineBranch || 'main',
      '{{PROJECT_TYPE}}': projectConfig.isMonorepo ? 'Monorepo' : '单仓库',
      '{{MONOREPO_TYPE}}': projectConfig.monorepoType || 'N/A',
      '{{PACKAGE_ROOT}}': projectConfig.packageRoot || workspace.packageRoot || projectConfig.projectRoot,
      '{{AFFECTED_SUBPROJECTS}}': this.formatList(projectConfig.affectedSubProjects || workspace.affectedSubProjects),
      '{{TESTABLE_SUBPROJECTS}}': this.formatList(projectConfig.testableSubProjects || workspace.testableSubProjects),
      '{{TEST_FRAMEWORK}}': projectConfig.testFramework || 'vitest',
      '{{HAS_EXISTING_TESTS}}': projectConfig.hasExistingTests ? '是' : '否',
      '{{TEST_PATTERN}}': projectConfig.testPattern || '**/*.{test,spec}.{ts,tsx,js,jsx}',
      '{{MAX_TESTS}}': process.env.MAX_TESTS || '10',
      '{{MAX_FIX_ATTEMPTS}}': process.env.FIX_MAX_ATTEMPTS || '3',
      '{{FIX_CONFIDENCE_THRESHOLD}}': process.env.FIX_CONFIDENCE_THRESHOLD || '0.5',
    };

    let result = template;
    for (const [key, value] of Object.entries(replacements)) {
      result = result.replace(new RegExp(key, 'g'), value);
    }

    return result;
  }

  /**
   * 从仓库 URL 提取项目名称
   */
  private extractProjectName(repoUrl: string): string {
    if (!repoUrl) {
      return 'Unknown Project';
    }

    // 如果是本地路径
    if (!repoUrl.startsWith('http') && !repoUrl.startsWith('git@')) {
      const parts = repoUrl.split('/');
      return parts[parts.length - 1] || 'Local Project';
    }

    // 如果是 Git URL
    const match = repoUrl.match(/\/([^\/]+?)(\.git)?$/);
    if (match && match[1]) {
      return match[1];
    }

    return 'Unknown Project';
  }

  /**
   * 格式化列表
   */
  private formatList(items?: string[]): string {
    if (!items || items.length === 0) {
      return '  - 无';
    }

    return items.map(item => `  - ${item}`).join('\n');
  }
}
