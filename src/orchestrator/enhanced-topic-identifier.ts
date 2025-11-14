import { TopicIdentifierAgent } from '../agents/topic-identifier.js';
import { EmbeddingClient } from '../clients/embedding.js';
import { OpenAIClient } from '../clients/openai.js';
import type { Diff } from '../schemas/diff.js';
import { logger } from '../utils/logger.js';

/**
 * 增强版 Topic Identifier，使用 Embedding 辅助识别
 */
export class EnhancedTopicIdentifier extends TopicIdentifierAgent {
  constructor(
    openai: OpenAIClient,
    private embedding: EmbeddingClient
  ) {
    super(openai);
  }

  /**
   * 使用 Embedding 增强的主题识别
   */
  async identifyTopicsWithEmbedding(
    diff: Diff,
    commitMessage?: string
  ): Promise<{ testScenarios: string[] }> {
    // 1. 先使用基础 LLM 识别
    const basicResult = await this.identifyTopics(diff.raw, commitMessage);

    // 2. 使用 Embedding 分析文件路径和变更内容
    const filePaths = diff.files.map(f => f.path);
    const changeDescriptions = diff.files.map(f => {
      const changeType = f.changeType === 'added' ? '新增' : f.changeType === 'modified' ? '修改' : '删除';
      return `${changeType}文件: ${f.path} (+${f.additions} -${f.deletions})`;
    });

    try {
      // 3. 为文件和变更生成 Embedding
      await this.embedding.encode([
        filePaths.join(' '),
        changeDescriptions.join(' '),
      ]);

      // 4. 定义测试场景关键词（预计算或从缓存获取）
      const scenarioKeywords: Record<string, string[]> = {
        'happy-path': ['happy path', 'default', 'nominal'],
        'edge-case': ['edge case', 'boundary', 'corner'],
        'error-path': ['error', 'exception', 'fail'],
        'state-change': ['state', 'transition', 'toggle'],
      };

      // 5. 基于关键词增强测试场景识别
      const enhancedScenarios: string[] = [...basicResult.testScenarios];
      const combinedText = `${filePaths.join(' ')} ${changeDescriptions.join(' ')}`.toLowerCase();
      for (const [scenario, keywords] of Object.entries(scenarioKeywords)) {
        if (keywords.some(kw => combinedText.includes(kw.toLowerCase()))) {
          if (!enhancedScenarios.includes(scenario)) {
            enhancedScenarios.push(scenario);
          }
        }
      }

      logger.info(`Enhanced test scenario identification: ${enhancedScenarios.join(', ')}`);
      
      return {
        testScenarios: enhancedScenarios,
      };
    } catch (error) {
      logger.warn('Embedding enhancement failed, fallback to basic', { error });
      return basicResult;
    }
  }
}

