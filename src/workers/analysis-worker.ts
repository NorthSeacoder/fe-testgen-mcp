/**
 * Analysis Worker - 在 worker 线程中执行测试矩阵分析
 */

import { parentPort, workerData } from 'worker_threads';
import type { WorkerTask, WorkerResponse } from './worker-pool.js';
import type { ProjectConfig } from '../orchestrator/project-detector.js';
import { OpenAIClient } from '../clients/openai.js';
import { TestMatrixAnalyzer } from '../agents/test-matrix-analyzer.js';
import { logger } from '../utils/logger.js';

interface AnalysisPayload {
  diff: string;
  projectConfig: ProjectConfig;
}

interface AnalysisResult {
  features: any[];
  scenarios: any[];
}

async function runAnalysis(payload: AnalysisPayload): Promise<AnalysisResult> {
  // 初始化 OpenAI 客户端
  const openai = new OpenAIClient({
    apiKey: process.env.OPENAI_API_KEY || '',
    baseURL: process.env.OPENAI_BASE_URL,
    model: process.env.OPENAI_MODEL || 'gpt-4',
  });

  // 创建分析器
  const analyzer = new TestMatrixAnalyzer(openai);

  // 执行分析
  const result = await analyzer.execute({
    diff: payload.diff,
    files: [],
    framework: payload.projectConfig.testFramework,
  });

  if (result.items.length === 0) {
    return {
      features: [],
      scenarios: [],
    };
  }

  // 合并所有结果
  const features = result.items.flatMap((item) => item.features);
  const scenarios = result.items.flatMap((item) => item.scenarios);

  return {
    features,
    scenarios,
  };
}

// Worker 主逻辑
if (parentPort) {
  const task: WorkerTask<AnalysisPayload> = workerData;

  logger.info('[AnalysisWorker] Starting analysis', { workspaceId: task.workspaceId });

  runAnalysis(task.payload)
    .then((result) => {
      const response: WorkerResponse<AnalysisResult> = {
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
