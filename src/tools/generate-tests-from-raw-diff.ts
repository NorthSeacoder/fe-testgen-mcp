/**
 * 从外部传入的 raw diff 直接生成测试代码（端到端工具）
 * 专为 n8n 等外部工作流设计，一次调用完成分析和生成
 */

import { StateManager } from '../state/manager.js';
import { detectProjectTestStack } from './detect-stack.js';
import { TopicIdentifierAgent } from '../agents/topic-identifier.js';
import { Workflow } from '../orchestrator/workflow.js';
import { HappyPathTestAgent } from '../agents/tests/happy-path.js';
import { EdgeCaseTestAgent } from '../agents/tests/edge-case.js';
import { ErrorPathTestAgent } from '../agents/tests/error-path.js';
import { StateChangeTestAgent } from '../agents/tests/state-change.js';
import { OpenAIClient } from '../clients/openai.js';
import { EmbeddingClient } from '../clients/embedding.js';
import { Orchestrator } from '../orchestrator/pipeline.js';
import { BaseAgent } from '../agents/base.js';
import { parseDiff, generateNumberedDiff } from '../utils/diff-parser.js';
import { isFrontendFile } from '../schemas/diff.js';
import { computeContentHash } from '../utils/fingerprint.js';
import { AnalyzeRawDiffTestMatrixTool } from './analyze-raw-diff-test-matrix.js';
import { ResolvePathTool } from './resolve-path.js';
import { TestMatrixAnalyzer } from '../agents/test-matrix-analyzer.js';
import type { Config } from '../config/schema.js';
import type { TestGenerationResult } from '../schemas/test-plan.js';
import type { Diff } from '../schemas/diff.js';
import { logger } from '../utils/logger.js';
import { detectProjectRoot, getTestStackDetectionPath } from '../utils/project-root.js';
import { loadRepoPrompt, mergePromptConfigs } from '../utils/repo-prompt.js';
import { getProjectPath } from '../utils/paths.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { glob } from 'glob';

export interface GenerateTestsFromRawDiffInput {
  rawDiff: string;
  identifier: string;
  projectRoot: string;
  metadata?: {
    title?: string;
    author?: string;
    mergeRequestId?: string;
    commitHash?: string;
    branch?: string;
  };
  scenarios?: string[];
  mode?: 'incremental' | 'full';
  maxTests?: number;
  analyzeMatrix?: boolean;
  forceRefresh?: boolean;
}

export class GenerateTestsFromRawDiffTool {
  private workflow: Workflow;
  private openai: OpenAIClient;
  private stateManager: StateManager;
  private analyzeRawDiffTool: AnalyzeRawDiffTestMatrixTool;
  private globalContextPrompt?: string;
  private currentProjectContext?: string;
  private testAgents: Map<string, BaseAgent<any>>;
  private topicIdentifier: TopicIdentifierAgent;
  private orchestrator: Orchestrator;

  constructor(
    stateManager: StateManager,
    openai: OpenAIClient,
    embedding: EmbeddingClient,
    config: Config
  ) {
    this.openai = openai;
    this.stateManager = stateManager;

    // 加载全局配置
    let globalContextPrompt: string | undefined;
    if (config.projectContextPrompt) {
      try {
        globalContextPrompt = readFileSync(
          getProjectPath(config.projectContextPrompt),
          'utf-8'
        );
        logger.info('Loaded global project context prompt for raw diff test generation', {
          path: config.projectContextPrompt,
        });
      } catch (error) {
        logger.warn('Failed to load global project context prompt', {
          error,
          path: config.projectContextPrompt,
        });
      }
    }
    this.globalContextPrompt = globalContextPrompt;
    this.currentProjectContext = this.globalContextPrompt;

    // 初始化 analyze 工具
    const resolvePathTool = new ResolvePathTool();
    const testMatrixAnalyzer = new TestMatrixAnalyzer(openai);
    this.analyzeRawDiffTool = new AnalyzeRawDiffTestMatrixTool(
      resolvePathTool,
      stateManager,
      testMatrixAnalyzer
    );

    // 初始化测试生成 agents
    this.topicIdentifier = new TopicIdentifierAgent(openai);
    this.orchestrator = new Orchestrator(
      {
        parallelAgents: config.orchestrator.parallelAgents,
        maxConcurrency: config.orchestrator.maxConcurrency,
        filter: config.filter,
      },
      embedding
    );

    this.testAgents = new Map();
    this.testAgents.set('happy-path', new HappyPathTestAgent(this.openai, globalContextPrompt));
    this.testAgents.set('edge-case', new EdgeCaseTestAgent(this.openai, globalContextPrompt));
    this.testAgents.set('error-path', new ErrorPathTestAgent(this.openai, globalContextPrompt));
    this.testAgents.set('state-change', new StateChangeTestAgent(this.openai, globalContextPrompt));

    this.workflow = new Workflow(
      this.topicIdentifier,
      this.orchestrator,
      new Map(),
      this.testAgents
    );

    logger.info('Initialized raw diff test generation tool', {
      hasGlobalPrompt: !!globalContextPrompt,
      promptLength: globalContextPrompt?.length || 0,
    });
  }

  /**
   * 更新所有 Test agents 的项目上下文 prompt
   */
  private updateTestAgentsContext(projectContextPrompt?: string): void {
    if (this.currentProjectContext === projectContextPrompt) {
      return;
    }

    for (const agent of this.testAgents.values()) {
      agent.updateProjectContext(projectContextPrompt);
    }

    this.currentProjectContext = projectContextPrompt;

    logger.info('Updated test agents with new project context', {
      hasContext: !!projectContextPrompt,
      contextLength: projectContextPrompt?.length || 0,
    });
  }

  async generate(input: GenerateTestsFromRawDiffInput): Promise<TestGenerationResult> {
    const startTime = Date.now();
    const {
      rawDiff,
      identifier,
      projectRoot,
      metadata,
      scenarios,
      mode = 'incremental',
      maxTests,
      analyzeMatrix = true,
      forceRefresh = false,
    } = input;

    logger.info('Generating tests from raw diff', {
      identifier,
      projectRoot,
      diffLength: rawDiff.length,
      mode,
      analyzeMatrix,
    });

    // 1. 解析 diff
    const diff = parseDiff(rawDiff, identifier, {
      diffId: metadata?.mergeRequestId || metadata?.commitHash || 'unknown',
      title: metadata?.title || '',
      summary: `Branch: ${metadata?.branch || 'unknown'}`,
      author: metadata?.author || 'unknown',
    });

    diff.numberedRaw = generateNumberedDiff(diff);

    // 2. 过滤前端文件
    const frontendDiff: Diff = {
      ...diff,
      files: diff.files.filter(file => isFrontendFile(file.path)),
    };

    if (frontendDiff.files.length === 0) {
      throw new Error(
        `No frontend files found. Total files: ${diff.files.length}. ` +
        `Frontend extensions: .js, .jsx, .ts, .tsx, .vue, .css, .scss, .less`
      );
    }

    // 3. 检测项目信息
    const filePaths = frontendDiff.files.map(f => f.path);
    const projectRootInfo = detectProjectRoot(filePaths, projectRoot);

    logger.info('Project root detected', {
      root: projectRootInfo.root,
      isMonorepo: projectRootInfo.isMonorepo,
      workspaceType: projectRootInfo.workspaceType,
    });

    // 4. 加载仓库级 prompt 配置
    let repoProjectContextPrompt: string | undefined;
    try {
      const repoPromptConfig = loadRepoPrompt(
        projectRootInfo.root,
        frontendDiff.files.map(f => f.path)
      );
      if (repoPromptConfig.found) {
        repoProjectContextPrompt = repoPromptConfig.content;
        logger.info('Using repo-level prompt config', {
          source: repoPromptConfig.source,
          length: repoPromptConfig.content.length,
        });
      }
    } catch (error) {
      logger.warn('Failed to load repo prompt config', { error });
    }

    const mergedProjectContextPrompt = mergePromptConfigs(
      this.globalContextPrompt,
      repoProjectContextPrompt,
      undefined
    );

    if (mergedProjectContextPrompt !== this.currentProjectContext) {
      this.updateTestAgentsContext(mergedProjectContextPrompt);
    }

    // 5. 检测测试框架
    const testDetectionPath = getTestStackDetectionPath(projectRootInfo, filePaths[0]);
    const stack = await detectProjectTestStack(testDetectionPath);
    const framework = stack.unit || 'vitest';

    logger.info('Test stack detected', {
      framework,
      detectionPath: testDetectionPath,
    });

    // 6. 分析测试矩阵（如果需要）
    if (analyzeMatrix) {
      logger.info('Analyzing test matrix before generation...');
      await this.analyzeRawDiffTool.analyze({
        rawDiff,
        identifier,
        projectRoot: projectRootInfo.root,
        metadata,
        forceRefresh,
      });
    }

    // 7. 查找现有测试
    const existingTestContext = await this.findExistingTests(frontendDiff, projectRootInfo.root);

    // 8. 初始化状态
    const diffFingerprint = computeContentHash(
      frontendDiff.files.map(f => `${f.path}:${f.additions}:${f.deletions}`).join('|')
    );

    const state = await this.stateManager.initState(
      identifier,
      diff.diffId || '',
      diffFingerprint
    );

    const isIncremental = mode === 'incremental' && state.diffFingerprint === diffFingerprint;
    const existingTests = isIncremental
      ? state.tests.map(t => ({
          id: t.id,
          file: t.file,
          testFile: '',
          testName: t.testName,
          code: '',
          framework: framework,
          scenario: 'happy-path' as any,
          confidence: 0.7,
        }))
      : undefined;

    // 9. 执行测试生成
    const workflowResult = await this.workflow.executeTestGeneration({
      diff: frontendDiff,
      mode,
      existingTests,
      framework,
      existingTestContext,
      scenarios,
    });

    let finalTests = workflowResult.items;
    if (maxTests && finalTests.length > maxTests) {
      finalTests = finalTests
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, maxTests);
    }

    const allTests = [...(existingTests || []), ...finalTests];
    await this.stateManager.updateTests(identifier, allTests);

    const duration = Date.now() - startTime;

    logger.info('Raw diff test generation completed', {
      identifier,
      testsGenerated: finalTests.length,
      duration,
    });

    return {
      identifiedScenarios: workflowResult.identifiedTopics,
      tests: finalTests,
      metadata: {
        stack: { unit: framework },
        embeddingUsed: !!existingTestContext,
        duration,
      },
    };
  }

  private async findExistingTests(
    diff: { files: Array<{ path: string }> },
    projectRoot: string
  ): Promise<string | undefined> {
    try {
      const testFiles: string[] = [];

      for (const file of diff.files) {
        const testPatterns = [
          join(projectRoot, file.path.replace(/\.(ts|tsx|js|jsx)$/, '.test.$1')),
          join(projectRoot, file.path.replace(/\.(ts|tsx|js|jsx)$/, '.spec.$1')),
          join(projectRoot, file.path.replace(/(.*)\/(.*)$/, '$1/__tests__/$2')),
        ];

        for (const pattern of testPatterns) {
          if (existsSync(pattern)) {
            testFiles.push(pattern);
          }
        }
      }

      const globPatterns = ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'];
      for (const pattern of globPatterns) {
        try {
          const files = await glob(pattern, { cwd: projectRoot, ignore: ['node_modules/**'] });
          testFiles.push(...files.slice(0, 3).map(f => join(projectRoot, f)));
        } catch {
          // ignore
        }
      }

      if (testFiles.length === 0) {
        return undefined;
      }

      const contents = testFiles
        .slice(0, 3)
        .map(path => {
          try {
            return readFileSync(path, 'utf-8').substring(0, 2000);
          } catch {
            return '';
          }
        })
        .filter(c => c.length > 0)
        .join('\n\n---\n\n');

      return contents.length > 0 ? contents : undefined;
    } catch (error) {
      logger.warn('Failed to find existing tests', { error });
      return undefined;
    }
  }
}
