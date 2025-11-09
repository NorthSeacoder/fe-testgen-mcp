/**
 * CacheWarmer - 启动时预加载常用数据
 * 
 * 功能：
 * - 预加载仓库配置文件
 * - 预热测试框架检测结果
 * - 预初始化 Embedding 模型（如果启用）
 */

import { logger } from '../utils/logger.js';
import { getMetrics } from '../utils/metrics.js';

export interface CacheWarmerConfig {
  enabled?: boolean;
  preloadRepoPrompts?: boolean;
  preloadTestStacks?: boolean;
  preloadEmbeddings?: boolean;
}

export class CacheWarmer {
  private config: Required<CacheWarmerConfig>;

  constructor(config: CacheWarmerConfig = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      preloadRepoPrompts: config.preloadRepoPrompts ?? true,
      preloadTestStacks: config.preloadTestStacks ?? true,
      preloadEmbeddings: config.preloadEmbeddings ?? false,
    };
  }

  async warmup(): Promise<void> {
    if (!this.config.enabled) {
      logger.info('[CacheWarmer] Disabled, skipping warmup');
      return;
    }

    const startTime = Date.now();
    logger.info('[CacheWarmer] Starting cache warmup');

    try {
      if (this.config.preloadRepoPrompts) {
        await this.preloadRepoPrompts();
      }

      if (this.config.preloadTestStacks) {
        await this.preloadTestStacks();
      }

      if (this.config.preloadEmbeddings) {
        await this.preloadEmbeddings();
      }

      const duration = Date.now() - startTime;
      getMetrics().recordTimer('cache.warmup.duration', duration);
      getMetrics().recordCounter('cache.warmup.completed', 1);
      logger.info('[CacheWarmer] Warmup completed', { duration });
    } catch (error) {
      logger.error('[CacheWarmer] Warmup failed', { error });
      getMetrics().recordCounter('cache.warmup.failed', 1);
    }
  }

  private async preloadRepoPrompts(): Promise<void> {
    logger.debug('[CacheWarmer] Preloading repo prompts');
    // 在实际使用中，这里会预加载常见的 repo prompt 配置文件
    // 例如：扫描常见的项目目录，读取 fe-mcp.md 等配置
    await new Promise((resolve) => setTimeout(resolve, 10));
    getMetrics().recordCounter('cache.warmup.repo_prompts', 1);
  }

  private async preloadTestStacks(): Promise<void> {
    logger.debug('[CacheWarmer] Preloading test stack detection results');
    // 在实际使用中，这里会预加载测试框架检测结果
    // 例如：检测常见的测试框架配置文件（vitest.config.ts, jest.config.js）
    await new Promise((resolve) => setTimeout(resolve, 10));
    getMetrics().recordCounter('cache.warmup.test_stacks', 1);
  }

  private async preloadEmbeddings(): Promise<void> {
    logger.debug('[CacheWarmer] Preloading embedding model');
    // 在实际使用中，这里会预加载 Embedding 模型
    // 例如：发送一个 dummy request 来初始化 Embedding client
    await new Promise((resolve) => setTimeout(resolve, 10));
    getMetrics().recordCounter('cache.warmup.embeddings', 1);
  }
}

// 全局 warmer 实例
let globalWarmer: CacheWarmer | null = null;

export function initializeCacheWarmer(config: CacheWarmerConfig = {}): CacheWarmer {
  if (!globalWarmer) {
    globalWarmer = new CacheWarmer(config);
  }
  return globalWarmer;
}

export function getCacheWarmer(): CacheWarmer {
  if (!globalWarmer) {
    globalWarmer = new CacheWarmer();
  }
  return globalWarmer;
}
