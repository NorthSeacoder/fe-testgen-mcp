import { getProjectPath } from '../../utils/paths.js';
import { BaseAgent } from '../base.js';
import { OpenAIClient } from '../../clients/openai.js';
import type { TestCase } from '../../schemas/test-plan.js';
import { generateTestFingerprint } from '../../utils/fingerprint.js';
import { TestScenario } from '../../schemas/topic.js';
import { logger } from '../../utils/logger.js';

export class HappyPathTestAgent extends BaseAgent<TestCase> {
  constructor(openai: OpenAIClient) {
    super(openai, {
      name: 'happy-path',
      promptPath: getProjectPath('src/prompts/tests/happy-path.md'),
      description: '生成正常路径的单元测试用例',
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
        : 0.8;

      return {
        items: tests,
        confidence: avgConfidence,
      };
    } catch (error) {
      logger.error('HappyPathTestAgent failed', { error });
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
    const existingTests = metadata?.existingTests ? `\n相关现有测试示例：\n${metadata.existingTests}` : '';
    
    return `根据以下代码变更，生成正常路径的单元测试用例：

代码变更（diff）：
\`\`\`
${diff.substring(0, 5000)}
\`\`\`

相关文件：
${fileList}
${existingTests}

测试框架：${framework}

返回 JSON 格式的测试用例列表，每个测试用例包含：
- file: 变更文件路径
- testFile: 建议的测试文件路径
- testName: 测试用例名称
- code: 完整的测试代码
- framework: 测试框架名称
- scenario: "happy-path"
- confidence: 置信度 (0-1)
- description: 测试描述（可选）

示例：
\`\`\`json
[
  {
    "file": "src/utils/calculator.ts",
    "testFile": "src/utils/calculator.test.ts",
    "testName": "calculateDiscount should return correct discount",
    "code": "import { describe, it, expect } from 'vitest';\n\ndescribe('calculateDiscount', () => {\n  it('should return correct discount', () => {\n    // test code\n  });\n});",
    "framework": "vitest",
    "scenario": "happy-path",
    "confidence": 0.9,
    "description": "测试正常折扣计算"
  }
]
\`\`\``;
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
            'happy-path'
          ),
          file: item.file || files[0]?.path || '',
          testFile: testFile,
          testName: item.testName || 'test',
          code: item.code || '',
          framework: item.framework || framework,
          scenario: TestScenario.parse('happy-path'),
          confidence: Math.max(0, Math.min(1, item.confidence || 0.7)),
          description: item.description,
        };
        return test;
      }).filter((test: TestCase) => test.file && test.code);
    } catch (error) {
      logger.warn('Failed to parse HappyPathTestAgent response', { response, error });
      return [];
    }
  }
}

