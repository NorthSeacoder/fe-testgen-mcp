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
  ): Promise<{ crTopics: string[]; testScenarios: string[] }> {
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

      // 4. 定义主题关键词的 Embedding（预计算或从缓存获取）
      const topicKeywords: Record<string, string[]> = {
        react: ['react', 'component', 'hook', 'useState', 'useEffect', 'jsx', 'tsx'],
        typescript: ['typescript', 'type', 'interface', 'any', 'unknown'],
        performance: ['performance', 'memo', 'useMemo', 'useCallback', 'optimization'],
        accessibility: ['accessibility', 'a11y', 'aria', 'semantic', 'keyboard'],
        security: ['security', 'xss', 'csrf', 'dangerous', 'vulnerability'],
        css: ['css', 'style', 'scss', 'less', 'styling'],
        i18n: ['i18n', 'internationalization', 'locale', 'translation', 'hardcoded'],
      };

      // 5. 计算相似度，增强识别结果
      const enhancedTopics: string[] = [...basicResult.crTopics];
      
      // 简单的关键词匹配增强（实际可以更复杂）
      const combinedText = `${filePaths.join(' ')} ${changeDescriptions.join(' ')}`.toLowerCase();
      for (const [topic, keywords] of Object.entries(topicKeywords)) {
        if (keywords.some(kw => combinedText.includes(kw.toLowerCase()))) {
          if (!enhancedTopics.includes(topic)) {
            enhancedTopics.push(topic);
          }
        }
      }

      logger.info(`Enhanced topic identification: ${enhancedTopics.join(', ')}`);
      
      return {
        crTopics: enhancedTopics,
        testScenarios: basicResult.testScenarios,
      };
    } catch (error) {
      logger.warn('Embedding enhancement failed, fallback to basic', { error });
      return basicResult;
    }
  }
}

