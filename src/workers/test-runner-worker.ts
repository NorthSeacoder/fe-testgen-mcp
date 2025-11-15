/**
 * Test Runner Worker - 在 worker 线程中执行测试
 */

import { parentPort, workerData } from 'worker_threads';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { WorkerTask, WorkerResponse } from './worker-pool.js';
import { logger } from '../utils/logger.js';

const execAsync = promisify(exec);

interface TestRunnerPayload {
  workDir: string;
  testFiles?: string[];
  framework: 'vitest' | 'jest';
  timeout?: number;
}

interface TestRunnerResult {
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    duration: number;
  };
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runTests(payload: TestRunnerPayload): Promise<TestRunnerResult> {
  const { workDir, testFiles, framework, timeout = 60000 } = payload;

  // 构建测试命令
  let command: string;
  if (framework === 'jest') {
    command = 'npx jest --ci --no-coverage';
    if (testFiles && testFiles.length > 0) {
      command += ` ${testFiles.join(' ')}`;
    }
  } else {
    // vitest
    command = 'npx vitest run --no-coverage';
    if (testFiles && testFiles.length > 0) {
      command += ` ${testFiles.join(' ')}`;
    }
  }

  logger.info('[TestRunnerWorker] Executing tests', { command, workDir });

  const startTime = Date.now();
  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    const result = await execAsync(command, {
      cwd: workDir,
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: {
        ...process.env,
        CI: '1', // 禁用交互式输出
      },
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error: any) {
    stdout = error.stdout || '';
    stderr = error.stderr || '';
    exitCode = error.code || 1;
  }

  const duration = Date.now() - startTime;

  // 解析测试结果
  const summary = parseTestResults(stdout, stderr, framework);
  summary.duration = duration;

  return {
    summary,
    stdout,
    stderr,
    exitCode,
  };
}

function parseTestResults(
  stdout: string,
  stderr: string,
  framework: string
): {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
} {
  const combined = stdout + stderr;

  let total = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  if (framework === 'vitest') {
    // 解析 Vitest 输出
    const testMatch = combined.match(/Tests\s+(\d+)\s+passed[^(]*\((\d+)\)/i);
    if (testMatch) {
      passed = parseInt(testMatch[1], 10);
      total = parseInt(testMatch[2], 10);
    }

    const failMatch = combined.match(/Tests\s+(\d+)\s+failed/i);
    if (failMatch) {
      failed = parseInt(failMatch[1], 10);
    }

    const skipMatch = combined.match(/Tests\s+(\d+)\s+skipped/i);
    if (skipMatch) {
      skipped = parseInt(skipMatch[1], 10);
    }
  } else {
    // 解析 Jest 输出
    const testMatch = combined.match(/Tests:\s+(?:(\d+)\s+failed,\s*)?(\d+)\s+passed,\s*(\d+)\s+total/i);
    if (testMatch) {
      failed = parseInt(testMatch[1] || '0', 10);
      passed = parseInt(testMatch[2], 10);
      total = parseInt(testMatch[3], 10);
    }

    const skipMatch = combined.match(/(\d+)\s+skipped/i);
    if (skipMatch) {
      skipped = parseInt(skipMatch[1], 10);
    }
  }

  return {
    total,
    passed,
    failed,
    skipped,
    duration: 0, // Will be set by caller
  };
}

// Worker 主逻辑
if (parentPort) {
  const task: WorkerTask<TestRunnerPayload> = workerData;

  logger.info('[TestRunnerWorker] Starting test execution', { workspaceId: task.workspaceId });

  runTests(task.payload)
    .then((result) => {
      const response: WorkerResponse<TestRunnerResult> = {
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
