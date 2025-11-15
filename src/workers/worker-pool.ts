/**
 * WorkerPool - Worker 线程池管理器
 */

import { Worker } from 'node:worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface WorkerTask<T = any> {
  type: 'analyze' | 'generate' | 'test';
  workspaceId: string;
  payload: T;
  timeout?: number;
}

export interface WorkerResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

interface WorkerJob<TInput, TOutput> {
  worker: Worker;
  task: WorkerTask<TInput>;
  resolve: (value: TOutput) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
  completed: boolean;
}

interface QueuedTask<TInput, TOutput> {
  task: WorkerTask<TInput>;
  resolve: (value: TOutput) => void;
  reject: (error: Error) => void;
}

export class WorkerPool {
  private maxWorkers: number;
  private activeJobs = new Map<number, WorkerJob<any, any>>();
  private queue: QueuedTask<any, any>[] = [];
  private nextJobId = 0;

  constructor(maxWorkers: number = 3) {
    this.maxWorkers = Math.max(1, maxWorkers);
    logger.info('[WorkerPool] Initialized', { maxWorkers: this.maxWorkers });
  }

  /**
   * 执行任务
   */
  async executeTask<TInput, TOutput>(task: WorkerTask<TInput>): Promise<TOutput> {
    return new Promise<TOutput>((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.processQueue();
    });
  }

  /**
   * 清理所有 worker
   */
  async cleanup(): Promise<void> {
    logger.info('[WorkerPool] Cleaning up workers', {
      activeJobs: this.activeJobs.size,
      queueLength: this.queue.length,
    });

    this.queue = [];

    const jobIds = Array.from(this.activeJobs.keys());
    await Promise.all(jobIds.map(async (jobId) => {
      const job = this.activeJobs.get(jobId);
      if (!job) {
        return;
      }

      job.completed = true;
      this.clearJobTimeout(jobId);
      try {
        await job.worker.terminate();
      } catch (error) {
        logger.warn('[WorkerPool] Failed to terminate worker during cleanup', { jobId, error });
      }
      this.activeJobs.delete(jobId);
    }));
  }

  /**
   * 处理任务队列
   */
  private processQueue(): void {
    if (this.queue.length === 0) {
      return;
    }

    while (this.activeJobs.size < this.maxWorkers && this.queue.length > 0) {
      const queued = this.queue.shift();
      if (!queued) {
        break;
      }

      this.startJob(queued);
    }
  }

  /**
   * 启动一个 worker 任务
   */
  private startJob<TInput, TOutput>(queued: QueuedTask<TInput, TOutput>): void {
    const { task, resolve, reject } = queued;

    const workerPath = this.getWorkerPath(task.type);
    const worker = new Worker(workerPath, {
      workerData: task,
    });

    const jobId = this.nextJobId++;
    const job: WorkerJob<TInput, TOutput> = {
      worker,
      task,
      resolve,
      reject,
      completed: false,
    };

    this.activeJobs.set(jobId, job);

    if (task.timeout && task.timeout > 0) {
      job.timeout = setTimeout(() => {
        if (job.completed) {
          return;
        }

        job.completed = true;
        logger.warn('[WorkerPool] Task timeout', {
          jobId,
          type: task.type,
          workspaceId: task.workspaceId,
          timeout: task.timeout,
        });
        job.reject(new Error(`Task timeout after ${task.timeout}ms`));
        this.finishJob(jobId, true);
      }, task.timeout);
    }

    worker.on('message', (response: WorkerResponse<TOutput>) => {
      if (job.completed) {
        return;
      }

      job.completed = true;
      this.clearJobTimeout(jobId);

      if (response.success) {
        logger.info('[WorkerPool] Task completed', {
          jobId,
          type: task.type,
          workspaceId: task.workspaceId,
        });
        job.resolve(response.data as TOutput);
      } else {
        logger.error('[WorkerPool] Task failed', {
          jobId,
          type: task.type,
          workspaceId: task.workspaceId,
          error: response.error,
        });
        job.reject(new Error(response.error || 'Worker task failed'));
      }

      this.finishJob(jobId, true);
    });

    worker.on('error', (error) => {
      if (job.completed) {
        return;
      }

      job.completed = true;
      this.clearJobTimeout(jobId);

      logger.error('[WorkerPool] Worker encountered an error', {
        jobId,
        type: task.type,
        workspaceId: task.workspaceId,
        error: error.message,
      });

      job.reject(error);
      this.finishJob(jobId, true);
    });

    worker.on('exit', (code) => {
      if (!this.activeJobs.has(jobId)) {
        return; // Already cleaned up
      }

      this.clearJobTimeout(jobId);

      if (!job.completed) {
        job.completed = true;
        if (code !== 0) {
          logger.error('[WorkerPool] Worker exited unexpectedly', {
            jobId,
            type: task.type,
            workspaceId: task.workspaceId,
            exitCode: code,
          });
          job.reject(new Error(`Worker exited with code ${code}`));
        } else {
          logger.warn('[WorkerPool] Worker exited without sending response', {
            jobId,
            type: task.type,
            workspaceId: task.workspaceId,
          });
          job.reject(new Error('Worker exited without response'));
        }
      }

      this.finishJob(jobId, false);
    });

    logger.info('[WorkerPool] Task started', {
      jobId,
      type: task.type,
      workspaceId: task.workspaceId,
    });
  }

  /**
   * 完成任务并清理资源
   */
  private finishJob(jobId: number, terminateWorker: boolean): void {
    const job = this.activeJobs.get(jobId);
    if (!job) {
      return;
    }

    this.clearJobTimeout(jobId);
    this.activeJobs.delete(jobId);

    if (terminateWorker) {
      job.worker.terminate().catch((error) => {
        logger.warn('[WorkerPool] Failed to terminate worker cleanly', {
          jobId,
          error,
        });
      });
    }

    setImmediate(() => this.processQueue());
  }

  /**
   * 清除任务超时定时器
   */
  private clearJobTimeout(jobId: number): void {
    const job = this.activeJobs.get(jobId);
    if (job?.timeout) {
      clearTimeout(job.timeout);
      job.timeout = undefined;
    }
  }

  /**
   * 获取 worker 文件路径
   */
  private getWorkerPath(type: string): string {
    const workerFiles: Record<string, string> = {
      analyze: 'analysis-worker.js',
      generate: 'generation-worker.js',
      test: 'test-runner-worker.js',
    };

    const workerFile = workerFiles[type];
    if (!workerFile) {
      throw new Error(`Unknown worker type: ${type}`);
    }

    return path.join(__dirname, workerFile);
  }
}
