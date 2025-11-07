import { FetchDiffTool } from './fetch-diff.js';
import { PublishCommentsTool } from './publish-comments.js';
import { StateManager } from '../state/manager.js';
import { TopicIdentifierAgent } from '../agents/topic-identifier.js';
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
import { findNewLineNumber } from '../utils/diff-parser.js';
import { getProjectPath } from '../utils/paths.js';
import { readFileSync } from 'fs';

export class ReviewDiffTool {
  private workflow: Workflow;
  private testingSuggestionsAgent: TestingSuggestionsAgent;
  private openai: OpenAIClient;
  private mergePrompt: string;

  constructor(
    private fetchDiffTool: FetchDiffTool,
    private stateManager: StateManager,
    private publishCommentsTool: PublishCommentsTool,
    openai: OpenAIClient,
    embedding: EmbeddingClient,
    config: Config
  ) {
    this.openai = openai;
    try {
      this.mergePrompt = readFileSync(
        getProjectPath('src/prompts/comment-merger.md'),
        'utf-8'
      );
    } catch (error) {
      logger.warn('Failed to load comment merger prompt, will use simple concatenation', { error });
      this.mergePrompt = 'Merge multiple code review comments into one unified comment.';
    }

    let projectContextPrompt: string | undefined;
    if (config.projectContextPrompt) {
      try {
        projectContextPrompt = readFileSync(
          getProjectPath(config.projectContextPrompt),
          'utf-8'
        );
      } catch (error) {
        logger.warn('Failed to load project context prompt', { error, path: config.projectContextPrompt });
      }
    }

    const crAgents = new Map();
    crAgents.set('react', new ReactAgent(openai, projectContextPrompt));
    crAgents.set('typescript', new TypeScriptAgent(openai, projectContextPrompt));
    crAgents.set('performance', new PerformanceAgent(openai, projectContextPrompt));
    crAgents.set('accessibility', new AccessibilityAgent(openai, projectContextPrompt));
    crAgents.set('security', new SecurityAgent(openai, projectContextPrompt));
    crAgents.set('css', new CSSAgent(openai, projectContextPrompt));
    crAgents.set('i18n', new I18nAgent(openai, projectContextPrompt));
    crAgents.set('testing-suggestions', new TestingSuggestionsAgent(openai, projectContextPrompt));

    const orchestrator = new Orchestrator(
      {
        parallelAgents: config.orchestrator.parallelAgents,
        maxConcurrency: config.orchestrator.maxConcurrency,
        filter: config.filter,
      },
      embedding
    );

    const topicIdentifier = new TopicIdentifierAgent(openai);
    this.workflow = new Workflow(
      topicIdentifier,
      orchestrator,
      crAgents,
      new Map()
    );

    this.testingSuggestionsAgent = new TestingSuggestionsAgent(openai, projectContextPrompt);
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
        
        const publishableIssues = allIssues
          .filter(issue => issue.confidence >= 0.8)
          .map(issue => {
            const file = fileMap.get(issue.file);
            if (!file) {
              return null;
            }
            
            const newLine = findNewLineNumber(file, issue.line);
            if (newLine === null) {
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

