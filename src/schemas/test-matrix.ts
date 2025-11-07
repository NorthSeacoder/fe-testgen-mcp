import { z } from 'zod';

/**
 * 功能项（从 diff 中分析出的变更功能）
 */
export const FeatureItem = z.object({
  id: z.string(), // 功能唯一标识
  file: z.string(), // 文件路径
  name: z.string(), // 函数/组件/模块名称
  type: z.enum(['function', 'component', 'hook', 'class', 'module']),
  description: z.string(), // 功能描述
  changeType: z.enum(['added', 'modified', 'deleted']), // 变更类型
  complexity: z.enum(['low', 'medium', 'high']), // 复杂度
  lineRange: z.object({
    start: z.number(),
    end: z.number(),
  }).optional(),
});
export type FeatureItem = z.infer<typeof FeatureItem>;

/**
 * 测试场景（针对某个功能的测试点）
 */
export const TestScenarioItem = z.object({
  id: z.string(), // 场景唯一标识
  featureId: z.string(), // 关联的功能 ID
  scenario: z.enum(['happy-path', 'edge-case', 'error-path', 'state-change', 'integration']),
  description: z.string(), // 场景描述
  priority: z.enum(['high', 'medium', 'low']),
  testCases: z.array(z.string()), // 具体测试用例描述
  suggestedApproach: z.string().optional(), // 建议的测试方法
});
export type TestScenarioItem = z.infer<typeof TestScenarioItem>;

/**
 * 测试矩阵（功能 x 场景的映射）
 */
export const TestMatrix = z.object({
  features: z.array(FeatureItem),
  scenarios: z.array(TestScenarioItem),
  summary: z.object({
    totalFeatures: z.number(),
    totalScenarios: z.number(),
    estimatedTests: z.number(),
    coverage: z.object({
      'happy-path': z.number(),
      'edge-case': z.number(),
      'error-path': z.number(),
      'state-change': z.number(),
    }),
  }),
});
export type TestMatrix = z.infer<typeof TestMatrix>;

/**
 * 测试矩阵分析结果
 */
export const TestMatrixAnalysis = z.object({
  matrix: TestMatrix,
  metadata: z.object({
    diffId: z.string(),
    revisionId: z.string(),
    framework: z.string().nullable(),
    duration: z.number(),
  }),
});
export type TestMatrixAnalysis = z.infer<typeof TestMatrixAnalysis>;

