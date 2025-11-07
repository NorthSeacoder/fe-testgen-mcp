import { z } from 'zod';

// CR Topic 枚举
export const CRTopic = z.enum([
  'react',
  'typescript',
  'performance',
  'accessibility',
  'security',
  'css',
  'i18n',
  'testing-suggestions',
]);

export type CRTopic = z.infer<typeof CRTopic>;

// Test Scenario 枚举
export const TestScenario = z.enum([
  'happy-path',
  'edge-case',
  'error-path',
  'state-change',
]);

export type TestScenario = z.infer<typeof TestScenario>;

// Topic 类型（CR 或 Test）
export const Topic = z.union([CRTopic, TestScenario]);
export type Topic = z.infer<typeof Topic>;

