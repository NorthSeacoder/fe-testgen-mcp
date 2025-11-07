import { logger } from './logger.js';

export interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  factor?: number;
  retryable?: (error: unknown) => boolean;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'retryable'>> & { retryable?: RetryOptions['retryable'] } = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 10000,
  factor: 2,
};

/**
 * 判断错误是否可重试
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    // 网络错误
    if (error.message.includes('timeout') || error.message.includes('ECONNRESET')) {
      return true;
    }

    // HTTP 状态码
    if (error.message.includes('429')) {
      return true; // Rate limit
    }
    if (error.message.includes('500') || error.message.includes('502') || error.message.includes('503')) {
      return true; // Server errors
    }

    // 非重试错误
    if (error.message.includes('401') || error.message.includes('403') || error.message.includes('400')) {
      return false;
    }
  }

  // 默认可重试
  return true;
}

/**
 * 指数退避延迟
 */
function getDelay(attempt: number, initialDelay: number, maxDelay: number, factor: number): number {
  const delay = initialDelay * Math.pow(factor, attempt);
  return Math.min(delay, maxDelay);
}

/**
 * 带重试的函数执行
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const retryable = options.retryable || isRetryableError;

  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === opts.maxRetries) {
        logger.error(`Retry failed after ${opts.maxRetries} attempts`, { error });
        break;
      }

      if (!retryable(error)) {
        logger.warn('Non-retryable error encountered', { error });
        break;
      }

      const delay = getDelay(attempt, opts.initialDelay, opts.maxDelay, opts.factor);
      logger.warn(`Retry attempt ${attempt + 1}/${opts.maxRetries} after ${delay}ms`, { error });

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

