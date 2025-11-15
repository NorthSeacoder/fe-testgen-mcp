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
import { EmbeddingClient } from './clients/embedding.js';
import { GitClient } from './clients/git-client.js';
import { Cache } from './cache/cache.js';
import { StateManager } from './state/manager.js';
import { WorkspaceManager } from './orchestrator/workspace-manager.js';
import { ProjectDetector } from './orchestrator/project-detector.js';
import { WorkerPool } from './workers/worker-pool.js';
import { FetchCommitChangesTool } from './tools/fetch-commit-changes.js';
import { FetchDiffFromRepoTool } from './tools/fetch-diff-from-repo.js';
import { DetectProjectConfigTool } from './tools/detect-project-config.js';
import { AnalyzeTestMatrixTool } from './tools/analyze-test-matrix.js';
import { AnalyzeTestMatrixWorkerTool } from './tools/analyze-test-matrix-worker.js';
import { GenerateTestsTool } from './tools/generate-tests.js';
import { GenerateTestsWorkerTool } from './tools/generate-tests-worker.js';
import { WriteTestFileTool } from './tools/write-test-file.js';
import { RunTestsTool } from './tools/run-tests.js';
import { FixFailingTestsTool } from './tools/fix-failing-tests.js';
import { TestGenerationWorkflowTool } from './tools/test-generation-workflow.js';
import { AnalyzeRawDiffTestMatrixTool } from './tools/analyze-raw-diff-test-matrix.js';
import { GenerateTestsFromRawDiffTool } from './tools/generate-tests-from-raw-diff.js';
import { GenerateCursorRuleTool } from './tools/generate-cursor-rule.js';
import { getEnv, validateAiConfig } from './config/env.js';
import { loadConfig } from './config/loader.js';
import { logger } from './utils/logger.js';
import { initializeCacheWarmer } from './cache/warmer.js';
import { MCPTrackingService } from './utils/tracking-service.js';

dotenv.config();

let toolRegistry: ToolRegistry;
let memory: Memory;
let trackingService: MCPTrackingService | undefined;
let gitClientInstance: GitClient | undefined;
let workspaceManagerInstance: WorkspaceManager | undefined;
let projectDetectorInstance: ProjectDetector | undefined;
let workerPoolInstance: WorkerPool | undefined;
let workspaceCleanupInterval: NodeJS.Timeout | undefined;

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

  const embedding = new EmbeddingClient({
    apiKey: config.llm.apiKey,
    baseURL: config.embedding.baseURL || config.llm.baseURL,
    model: config.embedding.model,
  });

  const cache = new Cache({ dir: config.cache.dir, ttl: config.cache.ttl });
  const state = new StateManager({ dir: config.state.dir });
  const contextStore = new ContextStore();
  memory = new Memory();

  // 初始化 Git 和 Workspace 管理器
  gitClientInstance = new GitClient();
  workspaceManagerInstance = new WorkspaceManager(gitClientInstance);
  projectDetectorInstance = new ProjectDetector();
  if (process.env.WORKER_ENABLED !== 'false') {
    const maxWorkers = parseInt(process.env.WORKER_MAX_POOL || '3', 10);
    workerPoolInstance = new WorkerPool(Number.isNaN(maxWorkers) ? 3 : maxWorkers);
  }

  // 设置全局上下文
  setAppContext({
    openai,
    embedding,
    cache,
    state,
    contextStore,
    memory,
    tracking: trackingService,
    gitClient: gitClientInstance,
    workspaceManager: workspaceManagerInstance,
    projectDetector: projectDetectorInstance,
    workerPool: workerPoolInstance,
  });

  // 启动定时清理任务
  workspaceCleanupInterval = setInterval(() => {
    workspaceManagerInstance?.cleanupExpired().catch((error) => {
      logger.error('[WorkspaceManager] Cleanup failed', { error });
    });
  }, 10 * 60 * 1000);

  // 注册所有工具
  toolRegistry = new ToolRegistry();
  
  // 1. 核心数据获取工具
  toolRegistry.register(new FetchCommitChangesTool());
  toolRegistry.register(new FetchDiffFromRepoTool());
  toolRegistry.register(new DetectProjectConfigTool());

  // 2. Agent 封装工具（直接执行版本）
  toolRegistry.register(new AnalyzeTestMatrixTool(openai, state));
  toolRegistry.register(
    new GenerateTestsTool(openai, embedding, state, contextStore)
  );

  // 3. Worker 版本（异步执行）
  toolRegistry.register(new AnalyzeTestMatrixWorkerTool(openai));
  toolRegistry.register(new GenerateTestsWorkerTool(openai, embedding, state, contextStore));

  // 4. 测试操作工具
  toolRegistry.register(new WriteTestFileTool());
  toolRegistry.register(new RunTestsTool());
  toolRegistry.register(new FixFailingTestsTool());
  toolRegistry.register(new TestGenerationWorkflowTool());
  toolRegistry.register(new GenerateCursorRuleTool());
  
  // 5. 原始 Diff 工具
  toolRegistry.register(new AnalyzeRawDiffTestMatrixTool(openai, state));
  toolRegistry.register(new GenerateTestsFromRawDiffTool(openai, embedding, state, contextStore));

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
      
      // 尝试获取 Zod schema（如果工具提供了的话）
      const zodSchema = (tool as any).getZodSchema?.();

      server.addTool({
        name: metadata.name,
        description: metadata.description,
        // 使用 Zod schema（如果有的话），FastMCP 要求 Standard Schema
        ...(zodSchema ? { parameters: zodSchema } : {}),
        execute: async (args: any) => {
          logger.info('Tool called', { tool: metadata.name, args });
          getMetrics().recordCounter('tool.called', 1, { tool: metadata.name });

          const startTime = Date.now();
          try {
            const result = await tool.execute(args || {});
            const duration = Date.now() - startTime;

            // 如果工具执行失败，返回格式化的错误响应
            if (!result.success) {
              // 上报工具调用失败
              if (trackingService) {
                void trackingService.trackToolCall(metadata.name, duration, 'error', result.error);
              }

              const errorResponse = tool.formatResponse(result);
              if (errorResponse.content && errorResponse.content.length > 0) {
                const textParts = errorResponse.content.map((item) => {
                  if (item.type === 'text') {
                    return item.text;
                  }
                  return JSON.stringify(item);
                });
                return textParts.join('\n');
              }
              // 如果格式化失败，返回基本的错误信息
              return JSON.stringify({
                error: result.error || 'Unknown error',
                tool: metadata.name,
                metadata: result.metadata,
              }, null, 2);
            }

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
            return JSON.stringify(result, null, 2);
          } catch (error) {
            const duration = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorStack = error instanceof Error ? error.stack : undefined;

            logger.error(`[Tool:${metadata.name}] Unexpected error`, {
              error: errorMessage,
              stack: errorStack,
              args,
            });

            // 上报工具调用失败
            if (trackingService) {
              void trackingService.trackToolCall(metadata.name, duration, 'error', errorMessage);
            }

            // 返回格式化的错误响应，而不是抛出错误
            return JSON.stringify({
              error: errorMessage,
              stack: errorStack,
              tool: metadata.name,
            }, null, 2);
          }
        },
        annotations: {
          readOnlyHint: false,
          idempotentHint: false,
        },
      });
    }

    // 启动 FastMCP HTTP Streaming 服务
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

    const portArg = getArgValue('--port');
    const httpPort = parseInt(portArg || process.env.HTTP_PORT || '3000', 10);

    const hostArg = getArgValue('--host');
    const httpHost = hostArg || process.env.HTTP_HOST || 'localhost';

    const endpointArg = getArgValue('--endpoint');
    const httpEndpoint = (endpointArg || process.env.HTTP_ENDPOINT || '/mcp') as `/${string}`;

    await server.start({
      transportType: 'httpStream',
      httpStream: {
        port: httpPort,
        host: httpHost,
        endpoint: httpEndpoint
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
    console.log(`🔄 Mode: Stateless (SSE compatible)`);
    console.log(`🛠️  Tools: ${toolRegistry.listMetadata().length} registered`);
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

  if (workspaceCleanupInterval) {
    clearInterval(workspaceCleanupInterval);
  }

  if (workerPoolInstance) {
    await workerPoolInstance.cleanup();
  }

  if (workspaceManagerInstance) {
    await workspaceManagerInstance.cleanupAll();
  }

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
