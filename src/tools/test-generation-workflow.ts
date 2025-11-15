/**
 * TestGenerationWorkflowTool - 一键式测试生成工作流
 * 
 * 整合完整的测试生成流程：
 * 1. 获取 diff 和项目配置
 * 2. 分析测试矩阵
 * 3. 生成测试用例
 * 4. 写入测试文件
 * 5. 运行测试
 * 6. （可选）自动修复失败的测试
 */

import { z } from 'zod';
import { BaseTool } from '../core/base-tool.js';
import type { ToolMetadata } from '../core/base-tool.js';
import { FetchDiffFromRepoTool } from './fetch-diff-from-repo.js';
import { AnalyzeTestMatrixWorkerTool } from './analyze-test-matrix-worker.js';
import { GenerateTestsWorkerTool } from './generate-tests-worker.js';
import { WriteTestFileTool } from './write-test-file.js';
import { RunTestsTool } from './run-tests.js';
import { FixFailingTestsTool } from './fix-failing-tests.js';
import { getAppContext } from '../core/app-context.js';
import { logger } from '../utils/logger.js';
import type { TestMatrix } from '../schemas/test-matrix.js';
import type { TestCase } from '../schemas/test-plan.js';
import type { TestFix } from '../agents/test-fix-agent.js';
import type { ProjectConfig } from '../orchestrator/project-detector.js';

const ArgsSchema = z.object({
  repoUrl: z.string().describe('Git 仓库 URL 或本地路径'),
  branch: z.string().describe('要分析的分支'),
  baselineBranch: z.string().optional().describe('对比基准分支（默认 origin/HEAD）'),
  scenarios: z.array(z.string()).optional().describe('要生成的测试场景列表'),
  autoFix: z.boolean().optional().default(false).describe('是否自动修复失败的测试'),
  maxFixAttempts: z.number().optional().default(3).describe('最大修复尝试次数'),
  maxTests: z.number().optional().describe('最大测试用例数量'),
  workDir: z.string().optional().describe('可选：指定工作目录'),
});

type WorkflowArgs = z.infer<typeof ArgsSchema>;

interface TestRunResult {
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

interface WorkflowOutput {
  workspaceId: string;
  projectConfig: ProjectConfig;
  matrix: TestMatrix;
  tests: TestCase[];
  filesWritten: string[];
  testResults: TestRunResult;
  fixes?: TestFix[];
  steps: {
    step: string;
    duration: number;
    success: boolean;
    error?: string;
  }[];
  totalDuration: number;
}

export class TestGenerationWorkflowTool extends BaseTool<WorkflowArgs, WorkflowOutput> {
  getMetadata(): ToolMetadata {
    return {
      name: 'test-generation-workflow',
      description: `一键式测试生成工作流。

此工具整合了完整的测试生成流程，从获取代码变更到生成测试、运行测试，可选自动修复失败测试。

**流程步骤**：
1. 获取 diff 和项目配置（fetch-diff-from-repo）
2. 分析测试矩阵（analyze-test-matrix-worker）
3. 生成测试用例（generate-tests-worker）
4. 写入测试文件（write-test-file）
5. 运行测试（run-tests）
6. 自动修复失败测试（fix-failing-tests，可选）

**参数**：
- repoUrl: Git 仓库 URL 或本地路径
- branch: 要分析的分支
- baselineBranch: 对比基准分支（可选）
- scenarios: 要生成的测试场景（可选，如 ['happy-path', 'edge-case']）
- autoFix: 是否自动修复失败的测试（默认 false）
- maxFixAttempts: 最大修复尝试次数（默认 3）
- maxTests: 最大测试用例数量（可选）
- workDir: 指定工作目录（可选）

**返回**：
- workspaceId: 工作区 ID
- projectConfig: 项目配置
- matrix: 测试矩阵
- tests: 生成的测试用例
- filesWritten: 写入的测试文件列表
- testResults: 测试运行结果
- fixes: 应用的修复（如果启用了自动修复）
- steps: 各步骤执行信息
- totalDuration: 总耗时（毫秒）`,
      inputSchema: {},
    };
  }

  getZodSchema() {
    return ArgsSchema;
  }

  async executeImpl(args: WorkflowArgs): Promise<WorkflowOutput> {
    const startTime = Date.now();
    const steps: WorkflowOutput['steps'] = [];

    const recordStep = (step: string, startedAt: number, success: boolean, error?: string) => {
      steps.push({
        step,
        duration: Date.now() - startedAt,
        success,
        error,
      });
    };

    logger.info('[TestGenerationWorkflow] Starting workflow', {
      repoUrl: args.repoUrl,
      branch: args.branch,
      autoFix: args.autoFix,
    });

    const context = getAppContext();
    const { openai, embedding, state, contextStore, workspaceManager } = context;

    if (!openai || !embedding || !state || !contextStore) {
      throw new Error('Required services not initialized');
    }
    if (!workspaceManager) {
      throw new Error('WorkspaceManager not initialized');
    }

    let workspaceId = '';
    let projectConfig: ProjectConfig | undefined;
    let matrix: TestMatrix | undefined;
    let tests: TestCase[] = [];
    let filesWritten: string[] = [];
    let testResults: TestRunResult | undefined;
    let fixes: TestFix[] | undefined;
    let diff = '';

    // Step 1: Fetch diff & project config
    const step1Start = Date.now();
    try {
      const fetchDiffTool = new FetchDiffFromRepoTool();
      const fetchResult = await fetchDiffTool.execute({
        repoUrl: args.repoUrl,
        branch: args.branch,
        baselineBranch: args.baselineBranch,
        workDir: args.workDir,
      });

      if (!fetchResult.success || !fetchResult.data) {
        throw new Error(fetchResult.error || 'Failed to fetch diff');
      }

      workspaceId = fetchResult.data.workspaceId;
      projectConfig = fetchResult.data.projectConfig;
      diff = fetchResult.data.diff;

      recordStep('fetch-diff', step1Start, true);
      logger.info('[TestGenerationWorkflow] Step 1 completed', {
        workspaceId,
        diffLength: diff.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordStep('fetch-diff', step1Start, false, message);
      throw new Error(`Step [fetch-diff] failed: ${message}`);
    }

    if (!workspaceId || !projectConfig) {
      throw new Error('Workspace or project config is not available after fetch step');
    }

    const workspace = workspaceManager.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    const projectRoot = workspace.workDir || projectConfig.projectRoot;

    // Step 2: Analyze test matrix
    const step2Start = Date.now();
    try {
      const analyzeTool = new AnalyzeTestMatrixWorkerTool(openai);
      const analyzeResult = await analyzeTool.execute({
        workspaceId,
        diff,
        projectConfig: projectConfig as any,
      });

      if (!analyzeResult.success || !analyzeResult.data) {
        throw new Error(analyzeResult.error || 'Failed to analyze test matrix');
      }

      matrix = analyzeResult.data;
      recordStep('analyze-matrix', step2Start, true);
      logger.info('[TestGenerationWorkflow] Step 2 completed', {
        featuresCount: matrix.features?.length || 0,
        scenariosCount: matrix.scenarios?.length || 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordStep('analyze-matrix', step2Start, false, message);
      throw new Error(`Step [analyze-matrix] failed: ${message}`);
    }

    if (!matrix) {
      throw new Error('Test matrix not generated');
    }

    // Step 3: Generate tests
    const step3Start = Date.now();
    try {
      const generateTool = new GenerateTestsWorkerTool(openai, embedding, state, contextStore);
      const generateResult = await generateTool.execute({
        workspaceId,
        diff,
        matrix,
        projectConfig: projectConfig as any,
        scenarios: args.scenarios,
        maxTests: args.maxTests,
      });

      if (!generateResult.success || !generateResult.data) {
        throw new Error(generateResult.error || 'Failed to generate tests');
      }

      tests = generateResult.data;
      recordStep('generate-tests', step3Start, true);
      logger.info('[TestGenerationWorkflow] Step 3 completed', {
        testsCount: tests.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordStep('generate-tests', step3Start, false, message);
      throw new Error(`Step [generate-tests] failed: ${message}`);
    }

    // Step 4: Write test files (skip if没有测试生成)
    if (tests.length > 0) {
      const step4Start = Date.now();
      try {
        const writeTool = new WriteTestFileTool();
        const writeResult = await writeTool.execute({
          tests,
          projectRoot,
          overwrite: true,
        });

        if (!writeResult.success || !writeResult.data) {
          throw new Error(writeResult.error || 'Failed to write test files');
        }

        filesWritten = writeResult.data.filesWritten;
        recordStep('write-files', step4Start, true);
        logger.info('[TestGenerationWorkflow] Step 4 completed', {
          filesWritten: filesWritten.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordStep('write-files', step4Start, false, message);
        throw new Error(`Step [write-files] failed: ${message}`);
      }
    } else {
      logger.warn('[TestGenerationWorkflow] No tests generated, skipping write & run steps');
      recordStep('write-files', Date.now(), true);
    }

    // Step 5: Run tests（当写入成功或原本就有测试文件时）
    if (tests.length > 0) {
      const step5Start = Date.now();
      try {
        const runTestsTool = new RunTestsTool();
        const runResult = await runTestsTool.execute({
          projectRoot,
          workspaceId,
          framework: (projectConfig.testFramework as 'vitest' | 'jest') || 'vitest',
          testFiles: filesWritten,
        });

        if (!runResult.success || !runResult.data) {
          throw new Error(runResult.error || 'Failed to run tests');
        }

        testResults = runResult.data;
        recordStep('run-tests', step5Start, true);
        logger.info('[TestGenerationWorkflow] Step 5 completed', {
          total: testResults.summary.total,
          passed: testResults.summary.passed,
          failed: testResults.summary.failed,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordStep('run-tests', step5Start, false, message);
        throw new Error(`Step [run-tests] failed: ${message}`);
      }
    } else {
      // 若没有生成测试，则构造一个默认的测试结果
      testResults = {
        success: true,
        framework: (projectConfig.testFramework as 'vitest' | 'jest') || 'vitest',
        summary: {
          total: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          duration: 0,
        },
        stdout: 'No tests were generated, so no test run was executed.',
        stderr: '',
        exitCode: 0,
      };
      recordStep('run-tests', Date.now(), true);
    }

    // Step 6: Auto fix failing tests (optional)
    if (args.autoFix && testResults && testResults.summary.failed > 0) {
      const step6Start = Date.now();
      try {
        const fixTool = new FixFailingTestsTool();
        const fixResult = await fixTool.execute({
          workspaceId,
          projectRoot,
          testResults,
          maxAttempts: args.maxFixAttempts,
        });

        if (fixResult.success && fixResult.data) {
          fixes = fixResult.data.fixes;
          if (fixResult.data.retriedResults) {
            testResults = fixResult.data.retriedResults;
          }
        }

        recordStep('fix-tests', step6Start, fixResult.success, fixResult.error ?? undefined);
        logger.info('[TestGenerationWorkflow] Step 6 completed', {
          fixesApplied: fixes?.length || 0,
          finalFailed: testResults.summary.failed,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordStep('fix-tests', step6Start, false, message);
        logger.warn('[TestGenerationWorkflow] Step 6 failed', { error: message });
      }
    }

    const totalDuration = Date.now() - startTime;

    logger.info('[TestGenerationWorkflow] Workflow completed successfully', {
      totalDuration,
      testsGenerated: tests.length,
      testsPassed: testResults?.summary.passed || 0,
      testsFailed: testResults?.summary.failed || 0,
    });

    return {
      workspaceId,
      projectConfig,
      matrix,
      tests,
      filesWritten,
      testResults,
      fixes,
      steps,
      totalDuration,
    };
  }
}
