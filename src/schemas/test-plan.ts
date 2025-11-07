import { z } from 'zod';
import { TestScenario } from './topic.js';

// 测试用例
export const TestCase = z.object({
  id: z.string(), // 稳定指纹
  file: z.string(), // 变更文件路径
  testFile: z.string(), // 建议的测试文件路径
  testName: z.string(), // 测试用例名称
  code: z.string(), // 测试代码块
  framework: z.string(), // vitest/jest
  scenario: TestScenario,
  confidence: z.number().min(0).max(1),
  description: z.string().optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
});
export type TestCase = z.infer<typeof TestCase>;

// 测试生成结果
export const TestGenerationResult = z.object({
  identifiedScenarios: z.array(z.string()),
  tests: z.array(TestCase),
  metadata: z.object({
    stack: z.object({
      unit: z.string().nullable(),
    }),
    embeddingUsed: z.boolean(),
    duration: z.number(),
  }),
});
export type TestGenerationResult = z.infer<typeof TestGenerationResult>;

// 测试栈信息
export const TestStack = z.object({
  unit: z.enum(['vitest', 'jest']).nullable(),
});
export type TestStack = z.infer<typeof TestStack>;

