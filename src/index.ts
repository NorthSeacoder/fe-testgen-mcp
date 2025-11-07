import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import { getEnv, validateAiConfig } from './config/env.js';
import { loadConfig } from './config/loader.js';
import { logger } from './utils/logger.js';
import { PhabricatorClient } from './clients/phabricator.js';
import { OpenAIClient } from './clients/openai.js';
import { EmbeddingClient } from './clients/embedding.js';
import { Cache } from './cache/cache.js';
import { StateManager } from './state/manager.js';
import { FetchDiffTool } from './tools/fetch-diff.js';
import { ReviewDiffTool } from './tools/review-diff.js';
import { GenerateTestsTool } from './tools/generate-tests.js';
import { AnalyzeTestMatrixTool } from './tools/analyze-test-matrix.js';
import { PublishCommentsTool } from './tools/publish-comments.js';
import { TestMatrixAnalyzer } from './agents/test-matrix-analyzer.js';
import { ResolvePathTool } from './tools/resolve-path.js';
import { WriteTestFileTool } from './tools/write-test-file.js';
import { FetchCommitChangesTool } from './tools/fetch-commit-changes.js';
import { AnalyzeCommitTestMatrixTool } from './tools/analyze-commit-test-matrix.js';
import { RunTestsTool } from './tools/run-tests.js';
import { formatJsonResponse, formatErrorResponse, formatDiffResponse } from './utils/response-formatter.js';

dotenv.config();

let config: ReturnType<typeof loadConfig>;
let phabClient: PhabricatorClient;
let openaiClient: OpenAIClient;
let embeddingClient: EmbeddingClient;
let cache: Cache;
let stateManager: StateManager;
let fetchDiffTool: FetchDiffTool;
let reviewDiffTool: ReviewDiffTool;
let generateTestsTool: GenerateTestsTool;
let analyzeTestMatrixTool: AnalyzeTestMatrixTool;
let publishCommentsTool: PublishCommentsTool;
let resolvePathTool: ResolvePathTool;
let writeTestFileTool: WriteTestFileTool;
let fetchCommitChangesTool: FetchCommitChangesTool;
let analyzeCommitTestMatrixTool: AnalyzeCommitTestMatrixTool;
let runTestsTool: RunTestsTool;

function initialize() {
  try {
    getEnv();
    config = loadConfig();
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
      logger.error('AI configuration validation failed', { errors: validation.errors });
      throw new Error(
        `AI 配置验证失败:\n${validation.errors.map(e => `  - ${e}`).join('\n')}`
      );
    }

    if (validation.warnings.length > 0) {
      logger.warn('AI configuration warnings', { warnings: validation.warnings });
    }

    phabClient = new PhabricatorClient({
      host: config.phabricator.host,
      token: config.phabricator.token,
    });

    openaiClient = new OpenAIClient({
      apiKey: config.llm.apiKey,
      baseURL: config.llm.baseURL,
      model: config.llm.model,
      temperature: config.llm.temperature,
      topP: config.llm.topP,
      maxTokens: config.llm.maxTokens,
    });

    embeddingClient = new EmbeddingClient({
      apiKey: config.llm.apiKey,
      baseURL: config.embedding.baseURL || config.llm.baseURL,
      model: config.embedding.model,
    });

    cache = new Cache({
      dir: config.cache.dir,
      ttl: config.cache.ttl,
    });

    stateManager = new StateManager({
      dir: config.state.dir,
    });

    fetchDiffTool = new FetchDiffTool(phabClient, cache);
    publishCommentsTool = new PublishCommentsTool(phabClient, stateManager, embeddingClient);
    reviewDiffTool = new ReviewDiffTool(
      fetchDiffTool,
      stateManager,
      publishCommentsTool,
      openaiClient,
      embeddingClient,
      config
    );
    
    resolvePathTool = new ResolvePathTool();
    const testMatrixAnalyzer = new TestMatrixAnalyzer(openaiClient);
    analyzeTestMatrixTool = new AnalyzeTestMatrixTool(
      fetchDiffTool,
      resolvePathTool,
      stateManager,
      testMatrixAnalyzer
    );
    
    generateTestsTool = new GenerateTestsTool(
      fetchDiffTool,
      stateManager,
      openaiClient,
      embeddingClient,
      config
    );

    writeTestFileTool = new WriteTestFileTool();
    fetchCommitChangesTool = new FetchCommitChangesTool();
    analyzeCommitTestMatrixTool = new AnalyzeCommitTestMatrixTool(
      fetchCommitChangesTool,
      resolvePathTool,
      stateManager,
      testMatrixAnalyzer
    );
    runTestsTool = new RunTestsTool();

    logger.info('Initialization complete');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Initialization failed', { 
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined 
    });
    throw error;
  }
}

const server = new Server(
  {
    name: 'fe-testgen-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'fetch-diff',
        description: 
          '从 Phabricator 获取完整的 diff 内容（包括所有变更细节）。\n\n' +
          '💡 使用场景：\n' +
          '1. 在调用其他工具前，先查看 diff 的完整信息\n' +
          '2. 了解变更的具体内容、文件路径和统计信息\n' +
          '3. 仅需查看 diff 内容，不执行其他操作\n\n' +
          '📤 输出信息（完整且详细）：\n' +
          '• Revision 标题和描述\n' +
          '• 文件路径列表\n' +
          '• 变更类型（新增/修改/删除）\n' +
          '• 增删行数统计\n' +
          '• 每个文件的 hunks（包含具体的变更行内容）\n' +
          '• 完整的 diff 文本（带行号，标准 unified diff 格式，使用 NEW_LINE_xxx 标记新行）\n\n' +
          '⚠️ 重要提示：\n' +
          '• 此工具返回的信息已经包含所有变更细节\n' +
          '• hunks 字段包含每一行的具体变更（NEW_LINE_xxx 标记新行，DELETED 标记旧行）\n' +
          '• fullDiff 字段包含完整的 diff 文本\n' +
          '• 无需使用 git show、git diff 等命令\n' +
          '• Revision ID（如 D551414）不是 git commit hash，不能用于 git 命令',
        inputSchema: {
          type: 'object',
          properties: {
            revisionId: {
              type: 'string',
              description: 'Revision ID（如 D551414，这是 Phabricator ID，不是 git commit hash）',
            },
            forceRefresh: {
              type: 'boolean',
              description: '强制刷新缓存',
            },
          },
          required: ['revisionId'],
        },
      },
      {
        name: 'fetch-commit-changes',
        description:
          '从本地 Git 仓库中获取指定 commit 的变更内容。\n\n' +
          '💡 使用场景：\n' +
          '1. 代码合并后，根据 commit 生成功能清单和测试矩阵\n' +
          '2. 无需 Phabricator 的环境下获取 diff\n' +
          '3. 作为增量分析的基础数据源\n\n' +
          '📤 输出信息：\n' +
          '• commit 信息（hash、作者、提交时间、标题）\n' +
          '• 变更文件列表（仅保留前端文件）\n' +
          '• 每个文件的 hunks（NEW_LINE_xxx 标记新行）\n' +
          '• 完整的 diff 文本（带 NEW_LINE_xxx 标记的新行号）',
        inputSchema: {
          type: 'object',
          properties: {
            commitHash: {
              type: 'string',
              description: 'Git commit hash（支持短 hash）',
            },
            repoPath: {
              type: 'string',
              description: '本地仓库路径（默认当前工作目录）',
            },
          },
          required: ['commitHash'],
        },
      },
      {
        name: 'review-frontend-diff',
        description: 
          '审查前端代码变更。\n\n' +
          '📋 推荐工作流程：\n' +
          '1. 先调用 fetch-diff 查看 diff 内容\n' +
          '2. 调用此工具进行代码审查\n\n' +
          '⚙️ 自动执行的步骤：\n' +
          '• 获取 diff 内容\n' +
          '• 识别审查主题\n' +
          '• 执行代码审查\n' +
          '• （可选）发布评论到 Phabricator\n\n' +
          '✨ 特性：\n' +
          '• 支持增量去重，避免重复评论\n' +
          '• 自动识别审查主题（React、TypeScript、性能等）',
        inputSchema: {
          type: 'object',
          properties: {
            revisionId: {
              type: 'string',
              description: 'Revision ID',
            },
            topics: {
              type: 'array',
              items: { type: 'string' },
              description: '手动指定主题（可选）',
            },
            mode: {
              type: 'string',
              enum: ['incremental', 'full'],
              description: '模式：增量或全量',
            },
            publish: {
              type: 'boolean',
              description: '是否发布评论',
            },
            forceRefresh: {
              type: 'boolean',
              description: '强制刷新缓存',
            },
          },
          required: ['revisionId'],
        },
      },
      {
        name: 'analyze-test-matrix',
        description: 
          '分析代码变更的功能清单和测试矩阵（测试用例生成的第一步）。\n\n' +
          '📋 推荐工作流程：\n' +
          '1. 先调用 fetch-diff 查看 diff 内容和文件路径\n' +
          '2. 执行 pwd 命令获取当前工作目录（项目根目录）\n' +
          '3. 调用此工具，传入 projectRoot 参数\n\n' +
          '⚙️ 自动执行的步骤：\n' +
          '• 获取 diff 内容\n' +
          '• 使用提供的 projectRoot 解析文件路径\n' +
          '• 检测测试框架\n' +
          '• 分析测试矩阵\n\n' +
          '💡 提示：projectRoot 参数是可选的，但强烈建议提供。\n' +
          '如果不提供，系统会尝试自动检测，但可能失败。',
        inputSchema: {
          type: 'object',
          properties: {
            revisionId: {
              type: 'string',
              description: 'Revision ID',
            },
            projectRoot: {
              type: 'string',
              description: '项目根目录的绝对路径（通过 pwd 命令获取）',
            },
            forceRefresh: {
              type: 'boolean',
              description: '强制刷新缓存',
            },
          },
          required: ['revisionId'],
        },
      },
      {
        name: 'analyze-commit-test-matrix',
        description:
          '分析单个 commit 的功能清单和测试矩阵。\n\n' +
          '📋 推荐工作流程：\n' +
          '1. 调用 fetch-commit-changes 获取 commit 的 diff（可选）\n' +
          '2. 调用此工具分析功能清单和测试矩阵\n' +
          '3. 将结果用于 generate-tests 或 run-tests\n\n' +
          '⚙️ 自动执行的步骤：\n' +
          '• 获取 commit diff（NEW_LINE_xxx 行号）\n' +
          '• 解析项目根目录\n' +
          '• 检测测试框架\n' +
          '• 分析功能清单和测试矩阵',
        inputSchema: {
          type: 'object',
          properties: {
            commitHash: {
              type: 'string',
              description: 'Git commit hash（支持短 hash）',
            },
            repoPath: {
              type: 'string',
              description: '本地仓库路径（默认当前工作目录）',
            },
            projectRoot: {
              type: 'string',
              description: '项目根目录的绝对路径（可选）',
            },
          },
          required: ['commitHash'],
        },
      },
      {
        name: 'generate-tests',
        description: 
          '基于测试矩阵生成具体的单元测试代码。\n' +
          '⚠️ 前置要求：必须先调用 analyze-test-matrix 生成测试矩阵。\n\n' +
          '📋 推荐工作流程：\n' +
          '1. 调用 analyze-test-matrix（传入 projectRoot）\n' +
          '2. 从返回结果中获取 projectRoot 字段的值\n' +
          '3. 调用此工具时，传入相同的 projectRoot 值\n\n' +
          '⚙️ 自动执行的步骤：\n' +
          '• 加载已保存的测试矩阵\n' +
          '• 生成具体的测试用例代码\n' +
          '• 应用增量去重（如果是增量模式）\n\n' +
          '🔴 重要：projectRoot 参数是必需的！\n' +
          'analyze-test-matrix 的返回结果中包含 projectRoot 字段，\n' +
          '你必须将该值传递给此工具，否则会导致项目根目录检测失败。',
        inputSchema: {
          type: 'object',
          properties: {
            revisionId: {
              type: 'string',
              description: 'Revision ID',
            },
            projectRoot: {
              type: 'string',
              description: '项目根目录的绝对路径（必须与 analyze-test-matrix 使用相同的值，否则会报错）',
            },
            scenarios: {
              type: 'array',
              items: { type: 'string' },
              description: '手动指定测试场景（可选）',
            },
            mode: {
              type: 'string',
              enum: ['incremental', 'full'],
              description: '模式：增量或全量',
            },
            maxTests: {
              type: 'number',
              description: '最大测试数量',
            },
            forceRefresh: {
              type: 'boolean',
              description: '强制刷新缓存',
            },
          },
          required: ['revisionId'],
        },
      },
      {
        name: 'run-tests',
        description:
          '在项目中执行测试命令。\n\n' +
          '默认执行 `npm test -- --runInBand`，可以通过参数自定义命令。',
        inputSchema: {
          type: 'object',
          properties: {
            projectRoot: {
              type: 'string',
              description: '项目根目录（默认当前工作目录）',
            },
            command: {
              type: 'string',
              description: '要执行的命令（默认 npm）',
            },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: '命令参数（默认 ["test", "--", "--runInBand"])',
            },
            timeoutMs: {
              type: 'number',
              description: '超时时间（毫秒，默认 600000）',
            },
          },
        },
      },
      {
        name: 'write-test-file',
        description:
          '将生成的测试用例写入文件。\n' +
          '⚠️ 默认情况下，如果文件已存在会跳过写入（除非设置 overwrite=true）。\n\n' +
          '使用场景：\n' +
          '• 将 generate-tests 生成的测试代码保存到磁盘\n' +
          '• 批量写入多个测试文件',
        inputSchema: {
          type: 'object',
          properties: {
            files: {
              type: 'array',
              description: '要写入的测试文件列表',
              items: {
                type: 'object',
                properties: {
                  filePath: {
                    type: 'string',
                    description: '测试文件的绝对路径',
                  },
                  content: {
                    type: 'string',
                    description: '要写入的测试代码',
                  },
                  overwrite: {
                    type: 'boolean',
                    description: '是否覆盖已存在的文件（默认 false）',
                  },
                },
                required: ['filePath', 'content'],
              },
            },
          },
          required: ['files'],
        },
      },
      {
        name: 'publish-phabricator-comments',
        description: '发布评论到 Phabricator',
        inputSchema: {
          type: 'object',
          properties: {
            revisionId: {
              type: 'string',
              description: 'Revision ID',
            },
            comments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  file: { type: 'string' },
                  line: { type: 'number' },
                  message: { type: 'string' },
                  issueId: { type: 'string' },
                },
                required: ['file', 'line', 'message', 'issueId'],
              },
            },
            message: {
              type: 'string',
              description: '总体评论',
            },
            incremental: {
              type: 'boolean',
              description: '增量模式',
            },
          },
          required: ['revisionId', 'comments'],
        },
      }
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  logger.info(`Handling CallTool action for tool '${name}'`, { args });

  try {
    switch (name) {

      case 'fetch-diff': {
        const { revisionId, forceRefresh } = args as {
          revisionId: string;
          forceRefresh?: boolean;
        };
        const diff = await fetchDiffTool.fetch({ revisionId, forceRefresh });
        const frontendDiff = fetchDiffTool.filterFrontendFiles(diff);
        logger.info(`Tool '${name}' completed successfully`, {
          revisionId: diff.revisionId,
          filesCount: frontendDiff.files.length,
        });
        return formatDiffResponse(frontendDiff);
      }

      case 'fetch-commit-changes': {
        const { commitHash, repoPath } = args as {
          commitHash: string;
          repoPath?: string;
        };
        const commitResult = await fetchCommitChangesTool.fetch({
          commitHash,
          repoPath,
        });
        const frontendDiff = fetchDiffTool.filterFrontendFiles(commitResult.diff);
        logger.info(`Tool '${name}' completed successfully`, {
          commit: commitResult.commitInfo.hash.substring(0, 7),
          filesCount: frontendDiff.files.length,
        });
        return formatDiffResponse(frontendDiff, { commit: commitResult.commitInfo });
      }


      case 'review-frontend-diff': {
        const input = args as {
          revisionId: string;
          topics?: string[];
          mode?: 'incremental' | 'full';
          publish?: boolean;
          forceRefresh?: boolean;
        };
        const result = await reviewDiffTool.review({
          revisionId: input.revisionId,
          topics: input.topics,
          mode: input.mode || 'incremental',
          publish: input.publish || false,
          forceRefresh: input.forceRefresh || false,
        });
        logger.info(`Tool '${name}' completed successfully`, {
          revisionId: input.revisionId,
          issuesCount: result.issues.length,
          published: input.publish,
        });
        return formatJsonResponse(result);
      }

      case 'analyze-test-matrix': {
        const input = args as {
          revisionId: string;
          projectRoot?: string;
          forceRefresh?: boolean;
        };
        const result = await analyzeTestMatrixTool.analyze({
          revisionId: input.revisionId,
          projectRoot: input.projectRoot,
          forceRefresh: input.forceRefresh || false,
        });
        logger.info(`Tool '${name}' completed successfully`, {
          revisionId: input.revisionId,
          projectRoot: input.projectRoot,
          features: result.matrix.summary.totalFeatures,
          scenarios: result.matrix.summary.totalScenarios,
          estimatedTests: result.matrix.summary.estimatedTests,
        });

        const resultWithProjectRoot = {
          ...result,
          projectRoot: input.projectRoot,
        };

        return formatJsonResponse(resultWithProjectRoot);
      }

      case 'analyze-commit-test-matrix': {
        const input = args as {
          commitHash: string;
          repoPath?: string;
          projectRoot?: string;
        };
        const result = await analyzeCommitTestMatrixTool.analyze({
          commitHash: input.commitHash,
          repoPath: input.repoPath,
          projectRoot: input.projectRoot,
        });
        logger.info(`Tool '${name}' completed successfully`, {
          commit: result.metadata.commitInfo?.hash?.substring(0, 7) || input.commitHash,
          features: result.matrix.summary.totalFeatures,
          scenarios: result.matrix.summary.totalScenarios,
          estimatedTests: result.matrix.summary.estimatedTests,
        });
        return formatJsonResponse(result);
      }

      case 'generate-tests': {
        const input = args as {
          revisionId: string;
          projectRoot?: string;
          scenarios?: string[];
          mode?: 'incremental' | 'full';
          maxTests?: number;
          forceRefresh?: boolean;
        };
        const result = await generateTestsTool.generate({
          revisionId: input.revisionId,
          projectRoot: input.projectRoot,
          scenarios: input.scenarios,
          mode: input.mode || 'incremental',
          maxTests: input.maxTests,
          forceRefresh: input.forceRefresh || false,
        });
        logger.info(`Tool '${name}' completed successfully`, {
          revisionId: input.revisionId,
          testsCount: result.tests.length,
          scenarios: result.identifiedScenarios,
        });
        return formatJsonResponse(result);
      }

      case 'run-tests': {
        const input = args as {
          projectRoot?: string;
          command?: string;
          args?: string[];
          timeoutMs?: number;
        };
        const result = await runTestsTool.run({
          projectRoot: input.projectRoot,
          command: input.command,
          args: input.args,
          timeoutMs: input.timeoutMs,
        });
        logger.info(`Tool '${name}' completed successfully`, {
          success: result.success,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        });
        return formatJsonResponse(result);
      }

      case 'write-test-file': {
        const input = args as {
          files: Array<{
            filePath: string;
            content: string;
            overwrite?: boolean;
          }>;
        };
        const results = await writeTestFileTool.writeMultiple(input.files);
        const successCount = results.filter(r => r.success).length;
        logger.info(`Tool '${name}' completed successfully`, {
          total: results.length,
          success: successCount,
          failed: results.length - successCount,
        });
        return formatJsonResponse({
          success: successCount,
          total: results.length,
          results,
        });
      }

      case 'publish-phabricator-comments': {
        const input = args as {
          revisionId: string;
          comments: Array<{
            file: string;
            line: number;
            message: string;
            issueId: string;
          }>;
          message?: string;
          incremental?: boolean;
        };
        const result = await publishCommentsTool.publish({
          revisionId: input.revisionId,
          comments: input.comments,
          message: input.message,
          incremental: input.incremental !== undefined ? input.incremental : true,
        });
        logger.info(`Tool '${name}' completed successfully`, {
          revisionId: input.revisionId,
          published: result.published,
          skipped: result.skipped,
        });
        return formatJsonResponse(result);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorDetails =
      error instanceof Error
        ? {
            message: error.message,
            stack: error.stack,
            name: error.name,
          }
        : { raw: String(error) };

    logger.error(`Tool ${name} failed`, {
      error: errorDetails,
      args,
    });

    return formatErrorResponse(error);
  }
});

async function main() {
  try {
    initialize();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('fe-testgen-mcp server started');
  } catch (error) {
    logger.error('Server failed to start', { error });
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error('Fatal error', { error });
  process.exit(1);
});
