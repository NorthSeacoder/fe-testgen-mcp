/**
 * fe-testgen-mcp - Frontend Test Generation MCP Server
 * 基于 MCP 协议（FastMCP 实现）的前端代码审查和单元测试生成工具
 */

import { FastMCP } from 'fastmcp';
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
import { ReviewFrontendDiffTool } from './tools/review-frontend-diff.js';
import { AnalyzeTestMatrixTool } from './tools/analyze-test-matrix.js';
import { GenerateTestsTool } from './tools/generate-tests.js';
import { PublishPhabricatorCommentsTool } from './tools/publish-phabricator-comments.js';
import { WriteTestFileTool } from './tools/write-test-file.js';
import { RunTestsTool } from './tools/run-tests.js';
import { AnalyzeRawDiffTestMatrixTool } from './tools/analyze-raw-diff-test-matrix.js';
import { GenerateTestsFromRawDiffTool } from './tools/generate-tests-from-raw-diff.js';
import { getEnv, validateAiConfig } from './config/env.js';
import { loadConfig } from './config/loader.js';
import { logger } from './utils/logger.js';
import { initializeCacheWarmer } from './cache/warmer.js';
import { MCPTrackingService } from './utils/tracking-service.js';

dotenv.config();

let toolRegistry: ToolRegistry;
let memory: Memory;
let trackingService: MCPTrackingService | undefined;

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
    throw new Error(`配置验证失败:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  // 初始化监控服务
  if (config.tracking?.enabled) {
    trackingService = new MCPTrackingService({
      appId: config.tracking.appId,
      appVersion: config.tracking.appVersion,
      env: config.tracking.env,
      measurement: config.tracking.measurement,
      metricsType: config.tracking.metricsType,
    });
  }

  initializeMetrics(undefined, trackingService);

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
    tracking: trackingService,
  });

  // 注册所有工具
  toolRegistry = new ToolRegistry();
  
  const fetchDiffTool = new FetchDiffTool(phabricator, cache);
  
  // 1. 核心数据获取工具
  toolRegistry.register(fetchDiffTool);
  toolRegistry.register(new FetchCommitChangesTool());

  // 2. Agent 封装工具
  toolRegistry.register(
    new ReviewFrontendDiffTool(openai, embedding, state, contextStore, fetchDiffTool)
  );
  toolRegistry.register(new AnalyzeTestMatrixTool(openai, state, fetchDiffTool));
  toolRegistry.register(
    new GenerateTestsTool(openai, embedding, state, contextStore, fetchDiffTool)
  );

  toolRegistry.register(new PublishPhabricatorCommentsTool(phabricator));
  toolRegistry.register(new WriteTestFileTool());
  toolRegistry.register(new RunTestsTool());
  toolRegistry.register(new AnalyzeRawDiffTestMatrixTool(openai, state));
  toolRegistry.register(new GenerateTestsFromRawDiffTool(openai, embedding, state, contextStore));
  
  // TODO: 其他辅助工具待实现:
  // - 更多 n8n 集成工具

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
    trackingEnabled: !!trackingService,
  });

  // 上报服务器初始化事件
  if (trackingService) {
    void trackingService.trackServerEvent('initialized', {
      toolsCount: toolRegistry.listMetadata().length,
      embeddingEnabled: config.embedding.enabled,
    });
  }

  return { toolRegistry, trackingService };
}

async function main() {
  try {
    const { toolRegistry, trackingService } = initialize();

    const server = new FastMCP({
      name: 'fe-testgen-mcp',
      version: '3.0.0',
    });

    // 动态注册所有工具
    const tools = await toolRegistry.listAll();
    for (const tool of tools) {
      const metadata = tool.getMetadata();

      server.addTool({
        name: metadata.name,
        description: metadata.description,
        parameters: metadata.inputSchema as any,
        execute: async (args: any) => {
          logger.info('Tool called', { tool: metadata.name });
          getMetrics().recordCounter('tool.called', 1, { tool: metadata.name });

          const startTime = Date.now();
          try {
            const result = await tool.execute(args || {});
            const duration = Date.now() - startTime;

            // 上报工具调用成功
            if (trackingService) {
              void trackingService.trackToolCall(metadata.name, duration, 'success');
            }

            // FastMCP expects string or content format
            const response = tool.formatResponse(result);
            if (response.content && response.content.length > 0) {
              const textParts = response.content.map((item) => {
                if (item.type === 'text') {
                  return item.text;
                }
                return JSON.stringify(item);
              });
              return textParts.join('\n');
            }
            return JSON.stringify(result);
          } catch (error) {
            const duration = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : String(error);

            // 上报工具调用失败
            if (trackingService) {
              void trackingService.trackToolCall(metadata.name, duration, 'error', errorMessage);
            }

            throw error;
          }
        },
      });
    }

    // 检查传输模式
    // 优先级: 命令行参数 > 环境变量 > 自动检测(TTY = HTTP, 非TTY = stdio)
    const argv = process.argv.slice(2);

    const getArgValue = (flag: string): string | undefined => {
      const withEquals = argv.find((arg) => arg.startsWith(`${flag}=`));
      if (withEquals) {
        return withEquals.split('=')[1];
      }

      const index = argv.indexOf(flag);
      if (index !== -1 && index + 1 < argv.length) {
        return argv[index + 1];
      }
      return undefined;
    };

    const transportArg = getArgValue('--transport');

    const explicitHttpStream =
      transportArg?.toLowerCase() === 'httpstream' ||
      transportArg?.toLowerCase() === 'http-stream' ||
      process.argv.includes('--transport=httpStream') ||
      process.argv.includes('--transport=http-stream') ||
      process.env.TRANSPORT_MODE === 'httpStream' ||
      process.env.TRANSPORT_MODE === 'http-stream';

    const explicitStdio =
      transportArg?.toLowerCase() === 'stdio' ||
      process.argv.includes('--transport=stdio') ||
      process.env.TRANSPORT_MODE === 'stdio';

    // 自动检测: 如果是 TTY（交互式终端），默认使用 HTTP 模式
    const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const useHttpStream = explicitHttpStream || (!explicitStdio && isInteractive);

    const portArg = getArgValue('--port');
    const httpPort = parseInt(portArg || process.env.HTTP_PORT || '3000', 10);

    const hostArg = getArgValue('--host');
    const httpHost = hostArg || process.env.HTTP_HOST || 'localhost';

    const endpointArg = getArgValue('--endpoint');
    const httpEndpoint = (endpointArg || process.env.HTTP_ENDPOINT || '/mcp') as `/${string}`;

    if (useHttpStream) {
      // FastMCP HTTP Streaming 模式
      await server.start({
        transportType: 'httpStream',
        httpStream: {
          port: httpPort,
          host: httpHost,
          endpoint: httpEndpoint,
        },
      });

      const displayHost = httpHost === '0.0.0.0' ? 'localhost' : httpHost;
      const serverUrl = `http://${displayHost}:${httpPort}${httpEndpoint}`;

      // 在控制台显示明显的启动信息
      console.log('\n' + '='.repeat(60));
      console.log('🚀 fe-testgen-mcp Server Started (HTTP Streaming Mode)');
      console.log('='.repeat(60));
      console.log(`📍 Server URL: ${serverUrl}`);
      console.log(`📡 Host: ${httpHost}`);
      console.log(`📡 Port: ${httpPort}`);
      console.log(`📋 MCP Endpoint: ${httpEndpoint}`);
      console.log('='.repeat(60));
      console.log('\n📝 Add to your MCP client configuration:');
      console.log(`\n  "fe-testgen-mcp": {`);
      console.log(`    "url": "${serverUrl}"`);
      console.log(`  }`);
      console.log('\n' + '='.repeat(60) + '\n');

      logger.info('FastMCP HTTP streaming started', {
        port: httpPort,
        host: httpHost,
        url: serverUrl,
        endpoint: httpEndpoint,
      });
      getMetrics().recordCounter('server.started', 1, { transport: 'httpStream' });

      if (trackingService) {
        void trackingService.trackServerEvent('started', {
          transport: 'httpStream',
          port: httpPort,
        });
      }
    } else {
      // Stdio 模式
      await server.start({
        transportType: 'stdio',
      });
      logger.info('FastMCP server started', { transport: 'stdio' });
      getMetrics().recordCounter('server.started', 1, { transport: 'stdio' });

      if (trackingService) {
        void trackingService.trackServerEvent('started', {
          transport: 'stdio',
        });
      }
    }
  } catch (error) {
    logger.error('Server failed to start', { error });
    getMetrics().recordCounter('server.start.failed', 1);

    if (trackingService) {
      void trackingService.trackError(
        'server_start_failed',
        error instanceof Error ? error.message : String(error)
      );
    }

    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  getMetrics().recordCounter('server.shutdown', 1);
  memory.cleanup();

  if (trackingService) {
    void trackingService.trackServerEvent('shutdown');
  }

  process.exit(0);
});

main().catch((error) => {
  logger.error('Fatal error', { error });

  if (trackingService) {
    void trackingService.trackError('fatal_error', error instanceof Error ? error.message : String(error));
  }

  process.exit(1);
});
