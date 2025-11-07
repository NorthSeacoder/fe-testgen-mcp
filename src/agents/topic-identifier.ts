import { getProjectPath } from '../utils/paths.js';
import { BaseAgent } from './base.js';
import { OpenAIClient } from '../clients/openai.js';
import { logger } from '../utils/logger.js';

export interface TopicIdentifierResult {
  crTopics: string[];
  testScenarios: string[];
}

export class TopicIdentifierAgent extends BaseAgent<TopicIdentifierResult> {
  constructor(openai: OpenAIClient) {
    super(openai, {
      name: 'topic-identifier',
      promptPath: getProjectPath('src/prompts/topic-identifier.md'),
      description: '识别代码变更涉及的主题和测试场景',
    });
  }

  async execute(context: {
    diff: string;
    files: Array<{ path: string; content: string }>;
    metadata?: Record<string, unknown>;
  }): Promise<{ items: TopicIdentifierResult[]; confidence: number }> {
    const prompt = this.buildPrompt(context.diff, context.metadata?.commitMessage as string | undefined);

    try {
      const response = await this.callLLM(this.prompt, prompt);
      const result = this.parseResponse(response);

      return {
        items: [result],
        confidence: 1.0, // Topic Identifier 置信度固定为 1.0
      };
    } catch (error) {
      logger.error('TopicIdentifier failed', { error });
      // 返回默认值
      return {
        items: [{
          crTopics: ['testing-suggestions'],
          testScenarios: ['happy-path'],
        }],
        confidence: 0.5,
      };
    }
  }

  private buildPrompt(diff: string, commitMessage?: string): string {
    const commitBlock = commitMessage ? `\nCommit Message:\n${commitMessage}\n` : '';
    
    return `分析以下代码变更，识别涉及的主题和测试场景：

${commitBlock}
代码变更（diff）：
\`\`\`
${diff}
\`\`\`

仅返回 JSON 格式，包含两个数组：
- crTopics: CR 主题列表
- testScenarios: 测试场景列表

示例：
\`\`\`json
{
  "crTopics": ["react", "typescript"],
  "testScenarios": ["happy-path", "edge-case"]
}
\`\`\`

只返回 JSON，不要其他文本。`;
  }

  private parseResponse(response: string): TopicIdentifierResult {
    try {
      // 尝试提取 JSON
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const jsonStr = jsonMatch[1] || jsonMatch[0];
        const parsed = JSON.parse(jsonStr);
        
        return {
          crTopics: Array.isArray(parsed.crTopics) ? parsed.crTopics : [],
          testScenarios: Array.isArray(parsed.testScenarios) ? parsed.testScenarios : [],
        };
      }

      // 如果没有 JSON，尝试直接解析
      const parsed = JSON.parse(response);
      return {
        crTopics: Array.isArray(parsed.crTopics) ? parsed.crTopics : [],
        testScenarios: Array.isArray(parsed.testScenarios) ? parsed.testScenarios : [],
      };
    } catch (error) {
      logger.warn('Failed to parse TopicIdentifier response', { response, error });
      // 返回默认值
      return {
        crTopics: ['testing-suggestions'],
        testScenarios: ['happy-path'],
      };
    }
  }

  /**
   * 识别主题（便捷方法）
   */
  async identifyTopics(
    diff: string,
    commitMessage?: string
  ): Promise<{ crTopics: string[]; testScenarios: string[] }> {
    const result = await this.execute({
      diff,
      files: [],
      metadata: { commitMessage },
    });

    return result.items[0] || {
      crTopics: ['testing-suggestions'],
      testScenarios: ['happy-path'],
    };
  }
}

