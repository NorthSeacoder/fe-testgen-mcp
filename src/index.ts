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
import { FetchDiffToolV2 } from './tools/v2/fetch-diff.js';
import { FetchCommitChangesToolV2 } from './tools/v2/fetch-commit-changes.js';
import { getEnv, validateAiConfig } from './config/env.js';
import { loadConfig } from './config/loader.js';
import { logger } from './utils/logger.js';

dotenv.config();

let toolRegistry: ToolRegistry;
let memory: Memory;

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
  toolRegistry.register(new FetchDiffToolV2(phabricator, cache));
  toolRegistry.register(new FetchCommitChangesToolV2());

  getMetrics().recordCounter('server.initialization.success', 1);
  logger.info('Initialization complete', { 
    tools: toolRegistry.list().length,
    embeddingEnabled: config.embedding.enabled,
  });
}

const server = new Server(
  { name: 'fe-testgen-mcp', version: '2.0.0' },
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

  const tool = toolRegistry.get(name);
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
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('MCP server started');
    getMetrics().recordCounter('server.started', 1);
  } catch (error) {
    logger.error('Server failed to start', { error });
    getMetrics().recordCounter('server.start.failed', 1);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  logger.info('Shutting down...');
  getMetrics().recordCounter('server.shutdown', 1);
  memory.cleanup();
  process.exit(0);
});

main().catch(error => {
  logger.error('Fatal error', { error });
  process.exit(1);
});