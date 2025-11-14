import { z } from 'zod';

export const TestScenario = z.enum([
  'happy-path',
  'edge-case',
  'error-path',
  'state-change',
]);

export type TestScenario = z.infer<typeof TestScenario>;

// 为向后兼容保留 Topic 别名
export const Topic = TestScenario;
export type Topic = z.infer<typeof Topic>;

