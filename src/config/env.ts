import { z } from 'zod';
import dotenv from 'dotenv';

// 加载 .env 文件
dotenv.config();

// 环境变量 schema
const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_BASE_URL: z.string().url().optional().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().optional().default('gpt-4'),
  
  EMBEDDING_BASE_URL: z.string().url().optional(),
  EMBEDDING_MODEL: z.string().optional().default('text-embedding-3-small'),
  
  PHABRICATOR_HOST: z.string().url('PHABRICATOR_HOST must be a valid URL'),
  PHABRICATOR_TOKEN: z.string().min(1, 'PHABRICATOR_TOKEN is required'),
  
  // 可选配置
  MODEL_TEMPERATURE: z.string().optional().default('0'),
  MODEL_TOP_P: z.string().optional().default('1'),
  CACHE_DIR: z.string().optional().default('.cache'),
  STATE_DIR: z.string().optional().default('.state'),
  ALLOW_PUBLISH_COMMENTS: z.string().optional().default('false'),
});

export type Env = z.infer<typeof envSchema>;

let env: Env | null = null;

/**
 * API 提供商类型
 */
export type ApiProvider = 'openai' | 'dashscope' | 'custom';

/**
 * 检测 API 提供商
 */
function detectApiProvider(baseURL?: string): ApiProvider {
  if (!baseURL) {
    return 'openai'; // 默认为 OpenAI
  }
  if (baseURL.includes('dashscope.aliyuncs.com')) {
    return 'dashscope';
  }
  if (baseURL.includes('api.openai.com')) {
    return 'openai';
  }
  return 'custom';
}

/**
 * 验证模型名称格式
 */
function validateModelName(model: string, provider: ApiProvider, type: 'llm' | 'embedding'): {
  valid: boolean;
  message?: string;
} {
  if (type === 'llm') {
    switch (provider) {
      case 'openai':
        // OpenAI 模型：gpt-4, gpt-4-turbo, gpt-3.5-turbo 等
        if (model.startsWith('gpt-')) {
          return { valid: true };
        }
        return {
          valid: false,
          message: `OpenAI LLM 模型名称应以 'gpt-' 开头，当前值: ${model}\n建议: gpt-4, gpt-4-turbo, gpt-3.5-turbo`,
        };
      
      case 'dashscope':
        // DashScope 模型：qwen-*, qwen-turbo, qwen-plus 等
        if (model.startsWith('qwen-') || model.startsWith('qwen2-')) {
          return { valid: true };
        }
        return {
          valid: false,
          message: `DashScope LLM 模型名称应以 'qwen-' 或 'qwen2-' 开头，当前值: ${model}\n建议: qwen-plus, qwen-turbo, qwen-max`,
        };
      
      default:
        // 自定义提供商，不验证格式
        return { valid: true };
    }
  } else {
    // embedding 模型
    switch (provider) {
      case 'openai':
        if (model.startsWith('text-embedding-')) {
          return { valid: true };
        }
        return {
          valid: false,
          message: `OpenAI Embedding 模型名称应以 'text-embedding-' 开头，当前值: ${model}\n建议: text-embedding-3-small, text-embedding-3-large, text-embedding-ada-002`,
        };
      
      case 'dashscope':
        if (model.startsWith('text-embedding-')) {
          return { valid: true };
        }
        return {
          valid: false,
          message: `DashScope Embedding 模型名称应以 'text-embedding-' 开头，当前值: ${model}\n建议: text-embedding-v1, text-embedding-v2, text-embedding-v3`,
        };
      
      default:
        return { valid: true };
    }
  }
}

/**
 * 验证 API Key 格式
 */
function validateApiKey(apiKey: string, provider: ApiProvider): {
  valid: boolean;
  message?: string;
} {
  switch (provider) {
    case 'openai':
      if (apiKey.startsWith('sk-')) {
        return { valid: true };
      }
      return {
        valid: false,
        message: `OpenAI API Key 应以 'sk-' 开头，当前值不符合格式`,
      };
    
    case 'dashscope':
      if (apiKey.startsWith('sk-')) {
        return { valid: true };
      }
      return {
        valid: false,
        message: `DashScope API Key 应以 'sk-' 开头，当前值不符合格式`,
      };
    
    default:
      // 自定义提供商，只检查是否为空
      if (apiKey && apiKey.length > 0) {
        return { valid: true };
      }
      return {
        valid: false,
        message: 'API Key 不能为空',
      };
  }
}

/**
 * 获取并验证环境变量
 */
export function getEnv(): Env {
  if (env) {
    return env;
  }

  try {
    env = envSchema.parse({
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      OPENAI_MODEL: process.env.OPENAI_MODEL,
      EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL,
      EMBEDDING_MODEL: process.env.EMBEDDING_MODEL,
      PHABRICATOR_HOST: process.env.PHABRICATOR_HOST,
      PHABRICATOR_TOKEN: process.env.PHABRICATOR_TOKEN,
      MODEL_TEMPERATURE: process.env.MODEL_TEMPERATURE,
      MODEL_TOP_P: process.env.MODEL_TOP_P,
      CACHE_DIR: process.env.CACHE_DIR,
      STATE_DIR: process.env.STATE_DIR,
      ALLOW_PUBLISH_COMMENTS: process.env.ALLOW_PUBLISH_COMMENTS,
    });

    return env;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missing = error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new Error(`Environment validation failed: ${missing}`);
    }
    throw error;
  }
}

/**
 * 验证 AI 配置
 * 检查模型名称、API Key 格式等
 */
export function validateAiConfig(config: {
  llm: {
    apiKey: string;
    baseURL?: string;
    model: string;
  };
  embedding?: {
    baseURL?: string;
    model: string;
    enabled?: boolean;
  };
}): {
  valid: boolean;
  warnings: string[];
  errors: string[];
} {
  const warnings: string[] = [];
  const errors: string[] = [];

  // 1. 验证 LLM 配置
  const llmProvider = detectApiProvider(config.llm.baseURL);
  
  // 验证 API Key
  const apiKeyValidation = validateApiKey(config.llm.apiKey, llmProvider);
  if (!apiKeyValidation.valid) {
    errors.push(`LLM API Key: ${apiKeyValidation.message}`);
  }

  // 验证模型名称
  const llmModelValidation = validateModelName(config.llm.model, llmProvider, 'llm');
  if (!llmModelValidation.valid) {
    warnings.push(`LLM Model: ${llmModelValidation.message}`);
  }

  // 2. 验证 Embedding 配置（如果启用）
  if (config.embedding?.enabled !== false && config.embedding?.baseURL) {
    const embeddingProvider = detectApiProvider(config.embedding.baseURL);
    
    const embeddingModelValidation = validateModelName(
      config.embedding.model,
      embeddingProvider,
      'embedding'
    );
    if (!embeddingModelValidation.valid) {
      warnings.push(`Embedding Model: ${embeddingModelValidation.message}`);
    }

    // 如果 LLM 和 Embedding 使用不同的提供商，给出警告
    if (llmProvider !== embeddingProvider) {
      warnings.push(
        `LLM 和 Embedding 使用不同的 API 提供商 (LLM: ${llmProvider}, Embedding: ${embeddingProvider})，这可能导致兼容性问题`
      );
    }
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}
