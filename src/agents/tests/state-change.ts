import { getProjectPath } from '../../utils/paths.js';
import { BaseAgent } from '../base.js';
import { OpenAIClient } from '../../clients/openai.js';
import type { TestCase } from '../../schemas/test-plan.js';
import { generateTestFingerprint } from '../../utils/fingerprint.js';
import { TestScenario } from '../../schemas/topic.js';
import { logger } from '../../utils/logger.js';

export class StateChangeTestAgent extends BaseAgent<TestCase> {
  constructor(openai: OpenAIClient) {
    super(openai, {
      name: 'state-change',
      promptPath: getProjectPath('src/prompts/tests/state-change.md'),
      description: '生成状态变更测试用例',
    });
  }

  async execute(context: {
    diff: string;
    files: Array<{ path: string; content: string }>;
    metadata?: {
      framework?: string;
      existingTests?: string;
    };
  }): Promise<{ items: TestCase[]; confidence: number }> {
    const prompt = this.buildPrompt(context.diff, context.files, context.metadata);

    try {
      const response = await this.callLLM(this.prompt, prompt);
      const tests = this.parseResponse(response, context.files, context.metadata?.framework || 'vitest');

      const avgConfidence = tests.length > 0
        ? tests.reduce((sum, test) => sum + test.confidence, 0) / tests.length
        : 0.7;

      return {
        items: tests,
        confidence: avgConfidence,
      };
    } catch (error) {
      logger.error('StateChangeTestAgent failed', { error });
      return { items: [], confidence: 0 };
    }
  }

  private buildPrompt(
    diff: string,
    files: Array<{ path: string; content: string }>,
    metadata?: { framework?: string; existingTests?: string }
  ): string {
    const fileList = files.map(f => `文件: ${f.path}\n内容:\n${f.content.substring(0, 2000)}`).join('\n\n');
    const framework = metadata?.framework || 'vitest';
    
    return `根据以下代码变更，生成状态变更测试用例：

代码变更（diff）：
\`\`\`
${diff.substring(0, 5000)}
\`\`\`

相关文件：
${fileList}

测试框架：${framework}

返回 JSON 格式的测试用例列表，scenario 应为 "state-change"。`;
  }

  private parseResponse(
    response: string,
    files: Array<{ path: string; content: string }>,
    framework: string
  ): TestCase[] {
    try {
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || response.match(/\[[\s\S]*\]/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : response;
      const parsed = JSON.parse(jsonStr);

      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.map((item: any) => {
        const testFile = item.testFile || item.file?.replace(/\.(ts|tsx|js|jsx)$/, '.test.$1');
        const test: TestCase = {
          id: generateTestFingerprint(
            item.file || files[0]?.path || '',
            item.testName || 'test',
            'state-change'
          ),
          file: item.file || files[0]?.path || '',
          testFile: testFile,
          testName: item.testName || 'test',
          code: item.code || '',
          framework: item.framework || framework,
          scenario: TestScenario.parse('state-change'),
          confidence: Math.max(0, Math.min(1, item.confidence || 0.7)),
          description: item.description,
        };
        return test;
      }).filter((test: TestCase) => test.file && test.code);
    } catch (error) {
      logger.warn('Failed to parse StateChangeTestAgent response', { response, error });
      return [];
    }
  }
}

