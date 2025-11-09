/**
 * fe-testgen-mcp - Frontend Test Generation MCP Server
 * 基于 MCP 协议的前端代码审查和单元测试生成工具
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';

import { ToolRegistry } from './core/tool-registry.js';
import { ContextStore, Memory } from './core/context.js';
import { setAppContext } from './core/app-context.js';
import { initializeMetrics, getMetrics } from './utils/metrics.js';
import { OpenAIClient } from './clients/openai.js';
import { PhabricatorClient } from './clients/phabricator.js';
import { EmbeddingClient } from './clients/embedding.js';
import { Cache } from './cache/cache.js';
import { StateManager } from './state/manager.js';
import { FetchDiffTool } from './tools/fetch-diff.js';
import { FetchCommitChangesTool } from './tools/fetch-commit-changes.js';
import { getEnv, validateAiConfig } from './config/env.js';
import { loadConfig } from './config/loader.js';
import { logger } from './utils/logger.js';
import { HttpTransport } from './transports/http.js';
import { initializePrometheusExporter } from './utils/prometheus-exporter.js';
import { initializeCacheWarmer } from './cache/warmer.js';

dotenv.config();

let toolRegistry: ToolRegistry;
let memory: Memory;
let httpTransport: HttpTransport | null = null;

function initialize() {
  const config = loadConfig();
  getEnv();
  
  const validation = validateAiConfig({
    llm: {
      apiKey: config.llm.apiKey,
      baseURL: config.llm.baseURL,
      model: config.llm.model,
    },
    embedding: {
      baseURL: config.embedding.baseURL || config.llm.baseURL,
      model: config.embedding.model,
      enabled: config.embedding.enabled,
    },
  });

  if (validation.errors.length > 0) {
    throw new Error(`配置验证失败:\n${validation.errors.map(e => `  - ${e}`).join('\n')}`);
  }

  initializeMetrics();

  const openai = new OpenAIClient({
    apiKey: config.llm.apiKey,
    baseURL: config.llm.baseURL,
    model: config.llm.model,
    temperature: config.llm.temperature,
    topP: config.llm.topP,
    maxTokens: config.llm.maxTokens,
  });

  const phabricator = new PhabricatorClient({
    host: config.phabricator.host,
    token: config.phabricator.token,
  });

  const embedding = new EmbeddingClient({
    apiKey: config.llm.apiKey,
    baseURL: config.embedding.baseURL || config.llm.baseURL,
    model: config.embedding.model,
  });

  const cache = new Cache({ dir: config.cache.dir, ttl: config.cache.ttl });
  const state = new StateManager({ dir: config.state.dir });
  const contextStore = new ContextStore();
  memory = new Memory();

  // 设置全局上下文
  setAppContext({
    openai,
    embedding,
    phabricator,
    cache,
    state,
    contextStore,
    memory,
  });

  // 注册工具
  toolRegistry = new ToolRegistry();
  toolRegistry.register(new FetchDiffTool(phabricator, cache));
  toolRegistry.register(new FetchCommitChangesTool());

  // 初始化 Prometheus Exporter
  initializePrometheusExporter({
    prefix: 'fe_testgen_mcp_',
    defaultLabels: { service: 'fe-testgen-mcp', version: '3.0.0' },
  });

  // 初始化缓存预热（异步执行，不阻塞启动）
  const warmer = initializeCacheWarmer({
    enabled: true,
    preloadRepoPrompts: true,
    preloadTestStacks: true,
    preloadEmbeddings: config.embedding.enabled,
  });
  warmer.warmup().catch((error) => {
    logger.warn('[Startup] Cache warmup failed', { error });
  });

  getMetrics().recordCounter('server.initialization.success', 1);
  logger.info('Initialization complete', { 
    tools: toolRegistry.listMetadata().length,
    embeddingEnabled: config.embedding.enabled,
  });
}

const server = new Server(
  { name: 'fe-testgen-mcp', version: '3.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolRegistry.listMetadata().map(meta => ({
    name: meta.name,
    description: meta.description,
    inputSchema: meta.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params;
  logger.info('Tool called', { tool: name });
  getMetrics().recordCounter('tool.called', 1, { tool: name });

  const tool = await toolRegistry.get(name);
  if (!tool) {
    getMetrics().recordCounter('tool.not_found', 1, { tool: name });
    throw new Error(`Tool "${name}" not found`);
  }

  const result = await tool.execute(args || {});
  return tool.formatResponse(result);
});

async function main() {
  try {
    initialize();

    // 检查是否使用 HTTP transport
    const useHttp = process.argv.includes('--transport=http') || process.env.TRANSPORT_MODE === 'http';
    const httpPort = parseInt(process.env.HTTP_PORT || '3000', 10);

    if (useHttp) {
      // HTTP Transport 模式
      httpTransport = new HttpTransport(toolRegistry, {
        port: httpPort,
        host: '0.0.0.0',
        cors: { origin: '*' },
      });
      await httpTransport.start();
      logger.info('HTTP transport started', { port: httpPort });
      getMetrics().recordCounter('server.started', 1, { transport: 'http' });
    } else {
      // 默认 Stdio Transport 模式
      const transport = new StdioServerTransport();
      await server.connect(transport);
      logger.info('MCP server started', { transport: 'stdio' });
      getMetrics().recordCounter('server.started', 1, { transport: 'stdio' });
    }
  } catch (error) {
    logger.error('Server failed to start', { error });
    getMetrics().recordCounter('server.start.failed', 1);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  getMetrics().recordCounter('server.shutdown', 1);
  memory.cleanup();

  if (httpTransport) {
    await httpTransport.stop();
  }

  process.exit(0);
});

main().catch(error => {
  logger.error('Fatal error', { error });
  process.exit(1);
});