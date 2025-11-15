/**
 * Generation Worker - 在 worker 线程中执行测试用例生成
 */

import { parentPort, workerData } from 'worker_threads';
import type { WorkerTask, WorkerResponse } from './worker-pool.js';
import type { ProjectConfig } from '../orchestrator/project-detector.js';
import type { TestMatrix } from '../schemas/test-matrix.js';
import type { TestCase } from '../schemas/test-plan.js';
import { OpenAIClient } from '../clients/openai.js';
import { EmbeddingClient } from '../clients/embedding.js';
import { StateManager } from '../state/manager.js';
import { ContextStore } from '../core/context.js';
import { TestAgent } from '../agents/test-agent.js';
import { logger } from '../utils/logger.js';

interface GenerationPayload {
  diff: string;
  matrix: TestMatrix;
  projectConfig: ProjectConfig;
  scenarios?: string[];
  maxTests?: number;
}

interface GenerationResult {
  tests: TestCase[];
}

async function runGeneration(payload: GenerationPayload): Promise<GenerationResult> {
  // 初始化客户端
  const openai = new OpenAIClient({
    apiKey: process.env.OPENAI_API_KEY || '',
    baseURL: process.env.OPENAI_BASE_URL,
    model: process.env.OPENAI_MODEL || 'gpt-4',
  });

  const embedding = new EmbeddingClient({
    apiKey: process.env.OPENAI_API_KEY || '',
    baseURL: process.env.OPENAI_BASE_URL,
    model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
  });

  const state = new StateManager({ dir: process.env.STATE_DIR || '.mcp-state' });
  const contextStore = new ContextStore();

  // 创建 TestAgent
  const agent = new TestAgent(openai, embedding, state, contextStore);

  // 创建代码变更源（使用 RawDiffSource）
  const { RawDiffSource } = await import('../core/code-change-source.js');
  
  // 将字符串 diff 转换为 Diff 对象
  const diffObj = {
    revisionId: 'worker-gen',
    raw: payload.diff,
    numberedRaw: payload.diff, // 简化处理
    files: [],
    metadata: {
      title: 'Test Generation',
    },
  };
  
  const source = new RawDiffSource('worker-generation', diffObj);

  // 执行测试生成
  const result = await agent.generate(source, {
    maxSteps: 10,
    mode: 'full',
    scenarios: payload.scenarios,
    maxTests: payload.maxTests,
    framework: payload.projectConfig.testFramework,
    projectRoot: payload.projectConfig.projectRoot,
  });

  return {
    tests: result.tests,
  };
}

// Worker 主逻辑
if (parentPort) {
  const task: WorkerTask<GenerationPayload> = workerData;

  logger.info('[GenerationWorker] Starting generation', { workspaceId: task.workspaceId });

  runGeneration(task.payload)
    .then((result) => {
      const response: WorkerResponse<GenerationResult> = {
        success: true,
        data: result,
      };
      parentPort!.postMessage(response);
    })
    .catch((error) => {
      const response: WorkerResponse = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      parentPort!.postMessage(response);
    });
}
