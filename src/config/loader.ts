import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { configSchema, type Config } from './schema.js';
import { PROJECT_ROOT } from '../utils/paths.js';

/**
 * 加载配置文件
 * 支持环境变量替换（如 ${OPENAI_API_KEY}）
 * 配置文件路径优先级：
 * 1. 传入的 configPath 参数（如果是相对路径，相对于项目根目录）
 * 2. 默认值：项目根目录的 'config.yaml'
 */

export function loadConfig(configPath?: string): Config {
  let finalPath: string;
  
  if (configPath) {
    // 如果是绝对路径，直接使用；否则相对于项目根目录
    finalPath = configPath.startsWith('/') ? configPath : resolve(PROJECT_ROOT, configPath);
  } else {
    // 默认使用项目根目录的 config.yaml
    finalPath = resolve(PROJECT_ROOT, 'config.yaml');
  }
  
  const content = readFileSync(finalPath, 'utf-8');
  const config = parse(content);

  // 递归替换环境变量
  const resolved = replaceEnvVars(config) as Record<string, unknown>;

  // 使用环境变量填充缺失的配置
  const env = process.env;
  if (!(resolved.llm as Record<string, unknown>)?.apiKey && env.OPENAI_API_KEY) {
    resolved.llm = (resolved.llm || {}) as Record<string, unknown>;
    (resolved.llm as Record<string, unknown>).apiKey = env.OPENAI_API_KEY;
  }
  if (!(resolved.llm as Record<string, unknown>)?.baseURL && env.OPENAI_BASE_URL) {
    resolved.llm = (resolved.llm || {}) as Record<string, unknown>;
    (resolved.llm as Record<string, unknown>).baseURL = env.OPENAI_BASE_URL;
  }
  if (!(resolved.llm as Record<string, unknown>)?.model && env.OPENAI_MODEL) {
    resolved.llm = (resolved.llm || {}) as Record<string, unknown>;
    (resolved.llm as Record<string, unknown>).model = env.OPENAI_MODEL;
  }
  if (!(resolved.embedding as Record<string, unknown>)?.baseURL && env.EMBEDDING_BASE_URL) {
    resolved.embedding = (resolved.embedding || {}) as Record<string, unknown>;
    (resolved.embedding as Record<string, unknown>).baseURL = env.EMBEDDING_BASE_URL;
  }
  if (!(resolved.embedding as Record<string, unknown>)?.model && env.EMBEDDING_MODEL) {
    resolved.embedding = (resolved.embedding || {}) as Record<string, unknown>;
    (resolved.embedding as Record<string, unknown>).model = env.EMBEDDING_MODEL;
  }
  if (!(resolved.phabricator as Record<string, unknown>)?.host && env.PHABRICATOR_HOST) {
    resolved.phabricator = (resolved.phabricator || {}) as Record<string, unknown>;
    (resolved.phabricator as Record<string, unknown>).host = env.PHABRICATOR_HOST;
  }
  if (!(resolved.phabricator as Record<string, unknown>)?.token && env.PHABRICATOR_TOKEN) {
    resolved.phabricator = (resolved.phabricator || {}) as Record<string, unknown>;
    (resolved.phabricator as Record<string, unknown>).token = env.PHABRICATOR_TOKEN;
  }
  if (!resolved.projectRoot && env.PROJECT_ROOT) {
    resolved.projectRoot = env.PROJECT_ROOT;
  }

  // 监控配置使用环境变量填充（完全可选，默认不启用）
  const trackingEnvVar = env.TRACKING_ENV as 'dev' | 'test' | 'prod' | undefined;
  if (env.TRACKING_ENABLED === 'true') {
    // 只有当 TRACKING_ENABLED=true 时才启用监控
    resolved.tracking = {
      enabled: true,
      appId: env.TRACKING_APP_ID || 'MCP_SERVICE',
      appVersion: env.TRACKING_APP_VERSION,
      env: trackingEnvVar || 'prod',
      measurement: env.TRACKING_MEASUREMENT || 'mcp_service_metrics',
      metricsType: env.TRACKING_METRICS_TYPE || 'metricsType1',
      ...(resolved.tracking as Record<string, unknown> | undefined),
    } as Record<string, unknown>;
  } else if (!resolved.tracking) {
    // 如果没有配置文件中的 tracking 配置，也没有启用环境变量，则禁用
    resolved.tracking = {
      enabled: false,
    } as Record<string, unknown>;
  }

  // 验证配置
  return configSchema.parse(resolved);
}

/**
 * 递归替换环境变量
 */
function replaceEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    // 匹配 ${VAR_NAME} 格式
    const match = obj.match(/^\$\{(.+)\}$/);
    if (match) {
      const envKey = match[1];
      const envValue = process.env[envKey];

      if (envValue === undefined) {
        return obj; // 保持原样，后续会用默认值
      }

      // 转换布尔值字符串
      if (envValue === 'true') return true;
      if (envValue === 'false') return false;

      // 转换数字
      if (/^\d+$/.test(envValue)) {
        return Number(envValue);
      }

      // 尝试转换浮点数
      const floatValue = parseFloat(envValue);
      if (!isNaN(floatValue) && isFinite(floatValue)) {
        return floatValue;
      }

      return envValue;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => replaceEnvVars(item));
  }

  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = replaceEnvVars(value);
    }
    return result;
  }

  return obj;
}

