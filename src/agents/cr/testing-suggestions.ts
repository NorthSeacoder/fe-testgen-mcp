import { getProjectPath } from '../../utils/paths.js';
import { BaseAgent } from '../base.js';
import { OpenAIClient } from '../../clients/openai.js';
import { logger } from '../../utils/logger.js';

export class TestingSuggestionsAgent extends BaseAgent<string> {
  constructor(openai: OpenAIClient, projectContextPrompt?: string) {
    super(openai, {
      name: 'testing-suggestions',
      promptPath: getProjectPath('src/prompts/cr/testing-suggestions.md'),
      description: '提出宏观的测试用例增删改建议',
      projectContextPrompt,
    });
  }

  async execute(context: {
    diff: string;
    files: Array<{ path: string; content: string }>;
    metadata?: Record<string, unknown>;
  }): Promise<{ items: string[]; confidence: number }> {
    const prompt = this.buildPrompt(context.diff, context.files);

    try {
      const response = await this.callLLM(this.prompt, prompt);
      return {
        items: [response],
        confidence: 0.8,
      };
    } catch (error) {
      logger.error('TestingSuggestionsAgent failed', { error });
      return { items: [], confidence: 0 };
    }
  }

  private buildPrompt(diff: string, files: Array<{ path: string; content: string }>): string {
    // ✅ 增加上下文长度，提供更全面的测试建议
    const fileList = files.map(f => `文件: ${f.path}\n内容:\n${f.content.substring(0, 8000)}`).join('\n\n');
    
    return `分析以下代码变更，提出测试用例增删改建议：

**重要说明**：
1. 下面的内容是 git diff 格式，带有行号标记
2. diff 中只显示了变更的行及其上下文，未显示的行不代表不存在
3. 请基于完整的文件内容提供测试建议，不要仅根据 diff 片段判断

代码变更（diff）：
\`\`\`
${diff.substring(0, 15000)}
\`\`\`

相关文件的完整 diff：
${fileList}

请以 Markdown 格式输出测试建议。`;
  }
}

