import Keyv from 'keyv';
import KeyvFileModule from 'keyv-file';
import { logger } from '../utils/logger.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// 处理 ES Module 和 CommonJS 的兼容性
const KeyvFile = (KeyvFileModule as any).default || KeyvFileModule;

export interface CacheConfig {
  dir: string;
  ttl: number; // seconds
}

export class Cache {
  private keyv: Keyv<string>;

  constructor(config: CacheConfig) {

    // 确保缓存目录存在
    try {
      mkdirSync(config.dir, { recursive: true });
    } catch {
      // 忽略错误
    }

    const store = new KeyvFile({
      filename: join(config.dir, 'cache.json'),
    });

    this.keyv = new Keyv<string>({
      store,
      ttl: config.ttl * 1000, // Keyv 使用毫秒
    });

    this.keyv.on('error', (err) => {
      logger.error('Cache error', { error: err });
    });
  }

  /**
   * 获取缓存值
   */
  async get<T>(key: string): Promise<T | undefined> {
    try {
      const value = await this.keyv.get(key);
      if (value === undefined) {
        return undefined;
      }
      return JSON.parse(value) as T;
    } catch (error) {
      logger.warn(`Cache get failed for key: ${key}`, { error });
      return undefined;
    }
  }

  /**
   * 设置缓存值
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      await this.keyv.set(key, serialized, ttl ? ttl * 1000 : undefined);
    } catch (error) {
      logger.warn(`Cache set failed for key: ${key}`, { error });
    }
  }

  /**
   * 删除缓存值
   */
  async delete(key: string): Promise<void> {
    try {
      await this.keyv.delete(key);
    } catch (error) {
      logger.warn(`Cache delete failed for key: ${key}`, { error });
    }
  }

  /**
   * 清空所有缓存
   */
  async clear(): Promise<void> {
    try {
      await this.keyv.clear();
    } catch (error) {
      logger.warn('Cache clear failed', { error });
    }
  }

  /**
   * 根据模式删除缓存键
   */
  async deleteByPattern(_pattern: string): Promise<number> {
    // Keyv 本身不支持模式匹配，需要遍历所有键
    // 这里简化实现，实际可能需要自定义存储
    logger.warn('deleteByPattern not fully implemented, use clear() instead');
    return 0;
  }
}

