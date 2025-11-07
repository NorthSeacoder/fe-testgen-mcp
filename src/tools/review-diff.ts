import { FetchDiffTool } from './fetch-diff.js';
import { PublishCommentsTool } from './publish-comments.js';
import { StateManager } from '../state/manager.js';
import { TopicIdentifierAgent } from '../agents/topic-identifier.js';
import { BaseAgent } from '../agents/base.js';
import { Workflow } from '../orchestrator/workflow.js';
import { ReactAgent } from '../agents/cr/react.js';
import { TypeScriptAgent } from '../agents/cr/typescript.js';
import { PerformanceAgent } from '../agents/cr/performance.js';
import { AccessibilityAgent } from '../agents/cr/accessibility.js';
import { SecurityAgent } from '../agents/cr/security.js';
import { CSSAgent } from '../agents/cr/css.js';
import { I18nAgent } from '../agents/cr/i18n.js';
import { TestingSuggestionsAgent } from '../agents/cr/testing-suggestions.js';
import { OpenAIClient } from '../clients/openai.js';
import { EmbeddingClient } from '../clients/embedding.js';
import { Orchestrator } from '../orchestrator/pipeline.js';
import type { Config } from '../config/schema.js';
import type { ReviewDiffInput } from '../schemas/tool-io.js';
import type { ReviewResult } from '../schemas/issue.js';
import { logger } from '../utils/logger.js';
import { findNewLineNumber, getReviewableLines } from '../utils/diff-parser.js';
import { getProjectPath } from '../utils/paths.js';
import { loadRepoPrompt, mergePromptConfigs } from '../utils/repo-prompt.js';
import { detectProjectRoot } from '../utils/project-root.js';
import { readFileSync } from 'fs';

export class ReviewDiffTool {
  private workflow: Workflow;
  private testingSuggestionsAgent: TestingSuggestionsAgent;
  private openai: OpenAIClient;
  private mergePrompt: string;
  private manualProjectRoot?: string;
  private globalContextPrompt?: string;
  private currentProjectContext?: string;
  private crAgents: Map<string, BaseAgent<any>>;
  private topicIdentifier: TopicIdentifierAgent;
  private orchestrator: Orchestrator;

  constructor(
    private fetchDiffTool: FetchDiffTool,
    private stateManager: StateManager,
    private publishCommentsTool: PublishCommentsTool,
    openai: OpenAIClient,
    embedding: EmbeddingClient,
    config: Config
  ) {
    this.openai = openai;
    this.manualProjectRoot = config.projectRoot || process.env.PROJECT_ROOT;
    
    try {
      this.mergePrompt = readFileSync(
        getProjectPath('src/prompts/comment-merger.md'),
        'utf-8'
      );
    } catch (error) {
      logger.warn('Failed to load comment merger prompt, will use simple concatenation', { error });
      this.mergePrompt = 'Merge multiple code review comments into one unified comment.';
    }

    // 从配置文件加载全局 prompt（优先级最低）
    let globalContextPrompt: string | undefined;
    if (config.projectContextPrompt) {
      try {
        globalContextPrompt = readFileSync(
          getProjectPath(config.projectContextPrompt),
          'utf-8'
        );
        logger.info('Loaded global project context prompt from config', { 
          path: config.projectContextPrompt 
        });
      } catch (error) {
        logger.warn('Failed to load global project context prompt', { 
          error, 
          path: config.projectContextPrompt 
        });
      }
    }
    
    // 仓库级别的 prompt 会在 review() 时动态加载，这里先记录全局配置
    this.globalContextPrompt = globalContextPrompt;
    this.currentProjectContext = globalContextPrompt;

    // 初始化工作流相关对象
    this.topicIdentifier = new TopicIdentifierAgent(openai);
    this.orchestrator = new Orchestrator(
      {
        parallelAgents: config.orchestrator.parallelAgents,
        maxConcurrency: config.orchestrator.maxConcurrency,
        filter: config.filter,
      },
      embedding
    );

    // 初始化 CR agents（使用全局配置作为默认值）
    this.crAgents = new Map<string, BaseAgent<any>>();
    this.crAgents.set('react', new ReactAgent(this.openai, globalContextPrompt));
    this.crAgents.set('typescript', new TypeScriptAgent(this.openai, globalContextPrompt));
    this.crAgents.set('performance', new PerformanceAgent(this.openai, globalContextPrompt));
    this.crAgents.set('accessibility', new AccessibilityAgent(this.openai, globalContextPrompt));
    this.crAgents.set('security', new SecurityAgent(this.openai, globalContextPrompt));
    this.crAgents.set('css', new CSSAgent(this.openai, globalContextPrompt));
    this.crAgents.set('i18n', new I18nAgent(this.openai, globalContextPrompt));
    this.testingSuggestionsAgent = new TestingSuggestionsAgent(this.openai, globalContextPrompt);
    this.crAgents.set('testing-suggestions', this.testingSuggestionsAgent);

    this.workflow = new Workflow(
      this.topicIdentifier,
      this.orchestrator,
      this.crAgents,
      new Map()
    );

    logger.info('Initialized CR agents', {
      hasGlobalPrompt: !!globalContextPrompt,
      promptLength: globalContextPrompt?.length || 0,
    });
  }

  /**
   * 更新所有 CR agents 的项目上下文 prompt
   */
  private updateAllAgentsContext(projectContextPrompt?: string): void {
    if (this.currentProjectContext === projectContextPrompt) {
      return; // 没有变化，跳过更新
    }

    for (const agent of this.crAgents.values()) {
      agent.updateProjectContext(projectContextPrompt);
    }
    
    this.currentProjectContext = projectContextPrompt;
    
    logger.info('Updated all agents with new project context', {
      hasContext: !!projectContextPrompt,
      contextLength: projectContextPrompt?.length || 0,
    });
  }

  private async mergeComments(messages: string[]): Promise<string> {
    if (messages.length === 1) {
      return messages[0];
    }

    try {
      const userPrompt = `请合并以下针对同一行代码的多个审查评论：\n\n${messages.map((msg, idx) => `${idx + 1}. ${msg}`).join('\n\n')}\n\n请输出合并后的统一评论，保持格式：[LEVEL] message\\n建议: xxx\\n(confidence=x.xx)`;

      const merged = await this.openai.complete(
        [
          { role: 'system', content: this.mergePrompt },
          { role: 'user', content: userPrompt },
        ],
        {
          temperature: 0.3,
          maxTokens: 500,
        }
      );

      return merged.trim();
    } catch (error) {
      logger.warn('Failed to merge comments with AI, falling back to simple concatenation', { error });
      return messages.map((msg, idx) => `${idx + 1}. ${msg}`).join('\n\n');
    }
  }

  async review(input: ReviewDiffInput): Promise<ReviewResult> {
    const startTime = Date.now();
    const mode = input.mode || 'incremental';
    const forceRefresh = input.forceRefresh || false;
    const publish = input.publish || false;

    const diff = await this.fetchDiffTool.fetch({
      revisionId: input.revisionId,
      forceRefresh,
    });

    const frontendDiff = this.fetchDiffTool.filterFrontendFiles(diff);
    const diffFingerprint = this.fetchDiffTool.computeDiffFingerprint(frontendDiff);
    
    // 动态检测项目根目录并加载仓库级别的 prompt 配置
    let repoProjectContextPrompt: string | undefined;
    
    try {
      const filePaths = frontendDiff.files.map(f => f.path);
      const effectiveProjectRoot = input.projectRoot || this.manualProjectRoot;
      const projectRoot = detectProjectRoot(filePaths, effectiveProjectRoot);
      
      logger.info('Project root detected for code review', {
        root: projectRoot.root,
        isMonorepo: projectRoot.isMonorepo,
      });
      
      // 加载仓库级别的 prompt 配置（支持 monorepo 子项目）
      const repoPromptConfig = loadRepoPrompt(
        projectRoot.root,
        frontendDiff.files.map(f => f.path)
      );
      if (repoPromptConfig.found) {
        logger.info('Using repo-level prompt config for code review', {
          source: repoPromptConfig.source,
          length: repoPromptConfig.content.length,
        });
        repoProjectContextPrompt = repoPromptConfig.content;
      } else {
        logger.debug('No repo-level prompt found, using global config if available');
      }
    } catch (error) {
      logger.warn('Failed to detect project root or load repo prompt', { error });
    }
    
    const mergedProjectContextPrompt = mergePromptConfigs(
      this.globalContextPrompt,
      repoProjectContextPrompt,
      undefined
    );
    
    if (mergedProjectContextPrompt !== this.currentProjectContext) {
      logger.info('Prompt config changed, updating agents', {
        previousLength: this.currentProjectContext?.length || 0,
        newLength: mergedProjectContextPrompt?.length || 0,
      });
      this.updateAllAgentsContext(mergedProjectContextPrompt);
    }

    const state = await this.stateManager.initState(
      input.revisionId,
      diff.diffId || '',
      diffFingerprint
    );

    const isIncremental = mode === 'incremental' && state.diffFingerprint === diffFingerprint;
    const existingIssues = isIncremental ? state.issues.map(i => ({
      id: i.id,
      file: i.file,
      line: i.line,
      severity: i.severity as any,
      topic: i.category as any,
      message: i.message,
      suggestion: '',
      confidence: i.confidence,
    })) : undefined;

    const workflowResult = await this.workflow.executeReview({
      diff: frontendDiff,
      mode,
      existingIssues,
    });

    let testingSuggestions = '';
    try {
      const suggestionsResult = await this.testingSuggestionsAgent.execute({
        diff: frontendDiff.raw,
        files: frontendDiff.files.map(f => ({
          path: f.path,
          content: frontendDiff.raw,
        })),
      });
      testingSuggestions = suggestionsResult.items[0] || '';
    } catch (error) {
      logger.warn('Failed to get testing suggestions', { error });
    }

    const allIssues = [
      ...(existingIssues || []),
      ...workflowResult.items,
    ];
    await this.stateManager.updateIssues(input.revisionId, allIssues);

    if (publish) {
      try {
        const fileMap = new Map(frontendDiff.files.map(f => [f.path, f]));
        
        // 构建可评论行的映射（用于验证和调试）
        const reviewableLinesMap = new Map<string, Set<number>>();
        for (const file of frontendDiff.files) {
          reviewableLinesMap.set(file.path, getReviewableLines(file));
        }
        
        const publishableIssues = allIssues
          .filter(issue => issue.confidence >= 0.8)
          .map(issue => {
            const file = fileMap.get(issue.file);
            if (!file) {
              logger.warn('Issue references non-existent file', {
                issueFile: issue.file,
                issueLine: issue.line,
                availableFiles: Array.from(fileMap.keys()),
              });
              return null;
            }
            
            // 首先检查行号是否在可评论行集合中
            const reviewableLines = reviewableLinesMap.get(issue.file);
            if (!reviewableLines || !reviewableLines.has(issue.line)) {
              logger.warn('Issue line is not reviewable (not an added or context line)', {
                file: issue.file,
                line: issue.line,
                message: issue.message,
                reviewableLines: reviewableLines ? Array.from(reviewableLines).sort((a, b) => a - b) : [],
              });
              return null;
            }
            
            // 再使用 findNewLineNumber 进行二次验证
            const newLine = findNewLineNumber(file, issue.line);
            if (newLine === null) {
              logger.error('Line validation failed: findNewLineNumber returned null for reviewable line', {
                file: issue.file,
                line: issue.line,
                message: issue.message,
              });
              return null;
            }
            
            const parts: string[] = [];
            const severityLabel = issue.severity.toUpperCase();
            parts.push(`[${severityLabel}] ${issue.message}`);
            
            if (issue.suggestion) {
              parts.push(`建议: ${issue.suggestion}`);
            }
            
            parts.push(`(confidence=${issue.confidence.toFixed(2)})`);
            
            const message = parts.join('\n');
            
            return {
              file: issue.file,
              line: newLine,
              message,
              issueId: issue.id,
              confidence: issue.confidence,
            };
          })
          .filter((comment): comment is NonNullable<typeof comment> => comment !== null);

        if (publishableIssues.length === 0) {
          logger.info('No issues with confidence >= 0.8 to publish');
        } else {
          const normalizeFilePath = (filePath: string): string => {
            let normalized = filePath.replace(/ \(new\)$/, '');
            if (normalized.startsWith('a/')) {
              normalized = normalized.substring(2);
            } else if (normalized.startsWith('b/')) {
              normalized = normalized.substring(2);
            }
            return normalized;
          };

          const mergedComments = new Map<string, {
            file: string;
            line: number;
            messages: string[];
            issueIds: string[];
          }>();

          for (const issue of publishableIssues) {
            const normalizedFile = normalizeFilePath(issue.file);
            const key = `${normalizedFile}:${issue.line}`;
            
            if (!mergedComments.has(key)) {
              mergedComments.set(key, {
                file: normalizedFile,
                line: issue.line,
                messages: [],
                issueIds: [],
              });
            }
            const merged = mergedComments.get(key)!;
            merged.messages.push(issue.message);
            merged.issueIds.push(issue.issueId);
          }

          logger.info(`Merging comments: ${publishableIssues.length} issues -> ${mergedComments.size} unique locations`);

          const commentsToPublish = await Promise.all(
            Array.from(mergedComments.values()).map(async (merged) => {
              let message: string;
              if (merged.messages.length === 1) {
                message = merged.messages[0];
              } else {
                logger.info(`Merging ${merged.messages.length} comments for ${merged.file}:${merged.line}`);
                message = await this.mergeComments(merged.messages);
              }

              return {
                file: merged.file,
                line: merged.line,
                message,
                issueId: merged.issueIds.join(','),
              };
            })
          );

          const summaryMessage = `## AI代码审查结果\n\n发现 ${publishableIssues.length} 个问题（置信度 >= 0.8），涉及 ${frontendDiff.files.length} 个文件。\n\n${testingSuggestions ? `${testingSuggestions}` : ''}`;

          const publishResult = await this.publishCommentsTool.publish({
            revisionId: input.revisionId,
            comments: commentsToPublish,
            message: summaryMessage,
            incremental: mode === 'incremental',
            fileMap,
          });

          logger.info(`Published ${publishResult.published} comments (${publishableIssues.length} issues merged into ${commentsToPublish.length} comments, confidence >= 0.8), skipped ${publishResult.skipped}, failed ${publishResult.failed}`);
        }
      } catch (error) {
        logger.error('Failed to publish comments', { error });
      }
    }

    const duration = Date.now() - startTime;

    return {
      summary: `Found ${workflowResult.items.length} issues across ${frontendDiff.files.length} files`,
      identifiedTopics: workflowResult.identifiedTopics,
      issues: workflowResult.items,
      testingSuggestions,
      metadata: {
        mode,
        agentsRun: workflowResult.metadata.agentsRun,
        duration,
        cacheHit: !forceRefresh,
      },
    };
  }
}

