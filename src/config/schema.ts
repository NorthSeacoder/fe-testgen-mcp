import { z } from 'zod';

// 配置文件的 Zod schema
export const configSchema = z.object({
  llm: z.object({
    provider: z.string().default('openai'),
    model: z.string(),
    apiKey: z.string(),
    baseURL: z.string().optional(),
    temperature: z.number().default(0),
    topP: z.number().default(1),
    maxTokens: z.number().default(4096),
    timeout: z.number().default(60000),
    maxRetries: z.number().default(3),
  }),
  embedding: z.object({
    baseURL: z.string().optional(),
    model: z.string().default('text-embedding-3-small'),
    enabled: z.boolean().default(true),
  }),
  phabricator: z.object({
    host: z.string().url(),
    token: z.string(),
  }),
  cache: z.object({
    dir: z.string().default('.cache'),
    ttl: z.number().default(86400),
  }),
  state: z.object({
    dir: z.string().default('.state'),
  }),
  orchestrator: z.object({
    parallelAgents: z.boolean().default(true),
    maxConcurrency: z.number().default(5),
  }),
  filter: z.object({
    confidenceMinGlobal: z.number().default(0.7),
    scenarioConfidenceMin: z.record(z.number()).default({}),
    similarityThreshold: z.number().default(0.85),
    scenarioLimits: z.record(z.number()).optional(),
  }),
  crTopics: z.array(z.string()),
  testScenarios: z.array(z.string()),
  // 项目特定规则 prompt 路径（可选）
  projectContextPrompt: z.string().optional(),
  // 被测项目的根目录路径（可选，默认为当前工作目录）
  projectRoot: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

