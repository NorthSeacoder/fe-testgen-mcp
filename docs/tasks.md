# 实现任务清单

> 基于 `implementation-improvement-plan.md` 的详细任务拆解
> 
> **目标**：补齐核心缺失功能，优化 n8n 集成体验
> 
> **原则**：
> - ✅ 保持现有工具不变（零破坏性）
> - ✅ 新增工具作为独立模块
> - ✅ 适合 n8n agent 节点调用
> - ✅ 支持 workspaceId 串联

---

## 任务总览

| 阶段 | 工作量 | 优先级 | 依赖关系 | 预估时间 |
|------|-------|--------|---------|---------|
| M1: 多项目工作区管理 | ~1200 行 | P0 | 无 | 3-4 天 |
| M2: Worker 机制 | ~800 行 | P0 | M1 | 3-4 天 |
| M3: 测试用例修复 | ~600 行 | P1 | M1 | 2-3 天 |
| M4: n8n 集成增强 | ~400 行 | P1 | M1, M2, M3 | 1-2 天 |
| M5: 配置文件增强 | ~300 行 | P2 | M1 | 1-2 天 |

**总工作量**：~3800 行新增代码，~100 行修改

---

## M1: 多项目工作区管理（P0）

### 目标
支持多 Git 项目并发处理，自动检测项目配置（Monorepo、测试框架、已有测试）

### 📝 子任务列表

#### M1.1 创建 Git 客户端（~200 行） ✅

**文件**：`src/clients/git-client.ts`

**接口**：
```typescript
export class GitClient {
  async clone(repoUrl: string, targetDir: string, branch?: string): Promise<void>
  async diff(workDir: string, baseRef: string, targetRef?: string): Promise<string>
  async getChangedFiles(workDir: string, baseRef: string, targetRef?: string): Promise<string[]>
  async branchExists(workDir: string, branch: string): Promise<boolean>
  async getCurrentBranch(workDir: string): Promise<string>
}
```

**实现要点**：
- 使用 `child_process.exec` 执行 git 命令
- 支持 `--depth=1` 浅克隆（节省时间）
- 错误处理：命令失败时抛出详细错误
- 支持超时控制（默认 60s）

**依赖**：无（使用 Node.js 内置模块）

**验收**：
- ✅ 可以 clone 远程仓库
- ✅ 可以获取 diff 和变更文件列表
- ✅ 可以检查分支是否存在

---

#### M1.2 创建工作区管理器（~300 行） ✅

**文件**：`src/orchestrator/workspace-manager.ts`

**接口**：
```typescript
export interface WorkspaceConfig {
  repoUrl: string;          // Git 仓库 URL 或本地路径
  branch: string;           // 要分析的分支
  baselineBranch?: string;  // 对比基准分支
  workDir?: string;         // 可选：指定工作目录
}

export class WorkspaceManager {
  async createWorkspace(config: WorkspaceConfig): Promise<string>  // 返回 workspaceId
  getWorkspace(workspaceId: string): Workspace | undefined
  async getDiff(workspaceId: string): Promise<string>
  async cleanup(workspaceId: string): Promise<void>
  async cleanupExpired(): Promise<void>  // 清理超过 1 小时的工作区
}
```

**实现要点**：
- workspaceId 生成：`ws-${Date.now()}-${randomString(6)}`
- 本地路径：直接使用（不 clone）
- 远程仓库：clone 到 `/tmp/mcp-workspace/${workspaceId}`
- 内存存储：`Map<workspaceId, Workspace>`
- 定时清理：每 10 分钟检查一次过期工作区

**依赖**：
- `GitClient`（M1.1）
- `fs` 模块（删除临时目录）

**验收**：
- ✅ 可以创建工作区并返回 workspaceId
- ✅ 支持本地路径和远程仓库
- ✅ 可以获取 diff
- ✅ 可以清理工作区
- ✅ 自动清理过期工作区

---

#### M1.3 创建项目检测器（~400 行） ✅

**文件**：`src/orchestrator/project-detector.ts`

**接口**：
```typescript
export interface ProjectConfig {
  projectRoot: string;
  packageRoot?: string;      // Monorepo 子项目根目录
  isMonorepo: boolean;
  monorepoType?: 'pnpm' | 'yarn' | 'npm' | 'lerna' | 'nx' | 'rush';
  testFramework?: 'vitest' | 'jest' | 'none';
  hasExistingTests: boolean;
  testPattern?: string;
  customRules?: string;      // 从 .cursor/rule/fe-mcp.md 读取
}

export class ProjectDetector {
  async detectProject(workDir: string): Promise<ProjectConfig>
  async detectSubProject(workDir: string, changedFiles: string[]): Promise<string | undefined>
}
```

**实现要点**：
- **detectMonorepo**：检查 `pnpm-workspace.yaml`, `lerna.json`, `nx.json`, `package.json` 的 `workspaces` 字段
- **detectTestFramework**：读取 `package.json` 的 `dependencies` 和 `devDependencies`
- **detectExistingTests**：使用 `glob` 查找 `**/*.{test,spec}.{ts,tsx,js,jsx}`
- **loadCustomRules**：按优先级查找：`.cursor/rule/fe-mcp.md` → `fe-mcp.md` → `.cursorrules` → ...
- **detectSubProject**：分析变更文件路径，找出变更最多的子项目

**依赖**：
- `fs` 模块
- `glob` 库（可选，或使用 `fs.readdirSync` 递归）

**验收**：
- ✅ 可以检测 Monorepo 类型
- ✅ 可以检测测试框架
- ✅ 可以检测是否已有测试
- ✅ 可以加载自定义规则
- ✅ 可以识别 Monorepo 子项目

---

#### M1.4 创建工具：fetch-diff-from-repo（~200 行） ✅

**文件**：`src/tools/fetch-diff-from-repo.ts`

**参数**：
```typescript
{
  repoUrl: string;           // Git 仓库 URL 或本地路径
  branch: string;            // 要分析的分支
  baselineBranch?: string;   // 对比基准分支（默认 origin/HEAD）
  workDir?: string;          // 可选：指定工作目录
}
```

**返回**：
```typescript
{
  workspaceId: string;
  diff: string;
  projectConfig: ProjectConfig;
  changedFiles: string[];
}
```

**实现步骤**：
1. 调用 `WorkspaceManager.createWorkspace()` 创建工作区
2. 调用 `ProjectDetector.detectProject()` 检测项目配置
3. 调用 `WorkspaceManager.getDiff()` 获取 diff
4. 调用 `GitClient.getChangedFiles()` 获取变更文件列表
5. 如果是 Monorepo，调用 `ProjectDetector.detectSubProject()` 识别子项目

**依赖**：
- `WorkspaceManager`（M1.2）
- `ProjectDetector`（M1.3）
- `GitClient`（M1.1）
- `BaseTool`（已有）

**验收**：
- ✅ 可以通过仓库名+分支名获取 diff
- ✅ 返回 workspaceId 便于串联
- ✅ 自动检测项目配置
- ✅ 支持 Monorepo 子项目识别

---

#### M1.5 创建工具：detect-project-config（~100 行） ✅

**文件**：`src/tools/detect-project-config.ts`

**参数**：
```typescript
{
  workspaceId: string;
}
```

**返回**：
```typescript
ProjectConfig
```

**实现步骤**：
1. 从 `WorkspaceManager` 获取工作区
2. 调用 `ProjectDetector.detectProject()` 检测项目配置

**依赖**：
- `WorkspaceManager`（M1.2）
- `ProjectDetector`（M1.3）
- `BaseTool`（已有）

**验收**：
- ✅ 可以检测已存在工作区的项目配置

---

#### M1.6 更新 AppContext（~50 行） ✅

**文件**：`src/core/app-context.ts`

**新增字段**：
```typescript
export interface AppContext {
  // ... 已有字段
  workspaceManager?: WorkspaceManager;
  projectDetector?: ProjectDetector;
  gitClient?: GitClient;
}
```

**文件**：`src/index.ts`

**初始化**：
```typescript
const gitClient = new GitClient();
const workspaceManager = new WorkspaceManager(gitClient);
const projectDetector = new ProjectDetector();

setAppContext({
  // ... 已有字段
  gitClient,
  workspaceManager,
  projectDetector,
});

// 启动定时清理任务
setInterval(() => {
  workspaceManager.cleanupExpired().catch(logger.error);
}, 10 * 60 * 1000); // 每 10 分钟
```

**依赖**：
- M1.1, M1.2, M1.3

**验收**：
- ✅ 所有模块正确初始化
- ✅ 定时清理任务正常运行

---

#### M1.7 注册新工具到 MCP（~20 行） ✅

**文件**：`src/index.ts`

```typescript
// 注册新工具
toolRegistry.register(new FetchDiffFromRepoTool());
toolRegistry.register(new DetectProjectConfigTool());
```

**验收**：
- ✅ 工具在 MCP 中可见
- ✅ 可以通过 MCP 客户端调用

---

### 📋 M1 验收标准

**功能完整性**：
- ✅ 可以从 Git 仓库 URL 或本地路径创建工作区
- ✅ 可以获取 diff 和变更文件列表
- ✅ 可以自动检测 Monorepo 和测试框架
- ✅ 可以加载自定义规则（.cursor/rule/fe-mcp.md）
- ✅ 支持多个工作区并发存在
- ✅ 自动清理过期工作区

**测试用例**：
```javascript
// 测试用例 1：本地路径
const result1 = await mcpAgent.call('fetch-diff-from-repo', {
  repoUrl: '/path/to/local/repo',
  branch: 'feature/test'
})

// 测试用例 2：远程仓库
const result2 = await mcpAgent.call('fetch-diff-from-repo', {
  repoUrl: 'https://github.com/org/repo.git',
  branch: 'feature/test',
  baselineBranch: 'main'
})

// 测试用例 3：Monorepo 项目
// 验证能正确识别子项目
```

---

## M2: Worker 机制（P0）

### 目标
将耗时任务（分析、生成、测试）隔离到 worker 线程，避免阻塞主线程

### 📝 子任务列表

#### M2.1 创建 Worker 池管理器（~200 行） ✅

**文件**：`src/workers/worker-pool.ts`

**接口**：
```typescript
export interface WorkerTask<T = any> {
  type: 'analyze' | 'generate' | 'test';
  workspaceId: string;
  payload: T;
  timeout?: number;
}

export class WorkerPool {
  constructor(maxWorkers: number = 3)
  async executeTask<TInput, TOutput>(task: WorkerTask<TInput>): Promise<TOutput>
  async cleanup(): Promise<void>
}
```

**实现要点**：
- 使用 `worker_threads` 模块
- 支持最大并发数控制（默认 3）
- 支持超时自动终止
- Worker 完成后自动清理
- 错误处理：Worker 崩溃时返回错误而不是抛出

**依赖**：
- `worker_threads` 模块（Node.js 内置）

**验收**：
- ✅ 可以创建和管理 worker
- ✅ 支持超时控制
- ✅ Worker 崩溃不影响主进程
- ✅ 支持并发控制

---

#### M2.2 创建分析任务 Worker（~150 行）

**文件**：`src/workers/analysis-worker.ts`

**输入**：
```typescript
{
  diff: string;
  projectConfig: ProjectConfig;
}
```

**输出**：
```typescript
TestMatrix
```

**实现要点**：
- 使用 `parentPort` 接收消息
- 实例化 `TestMatrixAnalyzer` 并执行
- 捕获错误并通过 `parentPort.postMessage` 返回

**依赖**：
- `TestMatrixAnalyzer`（已有）
- `OpenAIClient`（已有）

**验收**：
- ✅ 可以在 worker 中执行分析
- ✅ 返回正确的测试矩阵
- ✅ 错误能正确传递

---

#### M2.3 创建生成任务 Worker（~150 行）

**文件**：`src/workers/generation-worker.ts`

**输入**：
```typescript
{
  diff: string;
  matrix: TestMatrix;
  projectConfig: ProjectConfig;
  scenarios: string[];
}
```

**输出**：
```typescript
TestCase[]
```

**实现要点**：
- 使用 `parentPort` 接收消息
- 实例化 `TestAgent` 并调用 `generateTests`
- 捕获错误并通过 `parentPort.postMessage` 返回

**依赖**：
- `TestAgent`（已有）
- `OpenAIClient`, `EmbeddingClient`, `StateManager`, `ContextStore`（已有）

**验收**：
- ✅ 可以在 worker 中生成测试
- ✅ 返回正确的测试用例
- ✅ 错误能正确传递

---

#### M2.4 创建测试执行 Worker（~200 行）

**文件**：`src/workers/test-runner-worker.ts`

**输入**：
```typescript
{
  workDir: string;
  testFiles?: string[];
  framework: 'vitest' | 'jest';
  timeout?: number;
}
```

**输出**：
```typescript
{
  summary: { total, passed, failed, skipped, duration };
  stdout: string;
  stderr: string;
  exitCode: number;
}
```

**实现要点**：
- 使用 `child_process.exec` 执行测试命令
- 解析测试输出（Vitest/Jest 格式）
- 支持超时控制
- 环境变量：`CI=1`（禁用交互式输出）

**依赖**：
- `child_process` 模块（Node.js 内置）

**验收**：
- ✅ 可以在 worker 中执行测试
- ✅ 返回结构化的测试结果
- ✅ 支持超时控制

---

#### M2.5 创建工具：analyze-test-matrix-worker（~150 行）

**文件**：`src/tools/analyze-test-matrix-worker.ts`

**参数**：
```typescript
{
  workspaceId: string;
  diff: string;
  projectConfig: ProjectConfig;
}
```

**返回**：
```typescript
TestMatrix
```

**实现步骤**：
1. 从 `AppContext` 获取 `WorkerPool`
2. 如果 worker 可用，调用 `workerPool.executeTask()` 执行分析
3. 如果 worker 不可用或失败，回退到直接执行

**依赖**：
- `WorkerPool`（M2.1）
- `AnalyzeTestMatrixTool`（已有，用于回退）

**验收**：
- ✅ 优先使用 worker 执行
- ✅ Worker 失败时自动回退
- ✅ 返回结果与直接执行一致

---

#### M2.6 创建工具：generate-tests-worker（~150 行）

**文件**：`src/tools/generate-tests-worker.ts`

**参数**：
```typescript
{
  workspaceId: string;
  matrix: TestMatrix;
  scenarios?: string[];
  maxTests?: number;
}
```

**返回**：
```typescript
TestCase[]
```

**实现步骤**：
1. 从 `AppContext` 获取 `WorkerPool`
2. 如果 worker 可用，调用 `workerPool.executeTask()` 执行生成
3. 如果 worker 不可用或失败，回退到直接执行

**依赖**：
- `WorkerPool`（M2.1）
- `GenerateTestsTool`（已有，用于回退）

**验收**：
- ✅ 优先使用 worker 执行
- ✅ Worker 失败时自动回退
- ✅ 返回结果与直接执行一致

---

#### M2.7 更新工具：run-tests（~50 行修改）

**文件**：`src/tools/run-tests.ts`

**修改内容**：
- 检查 `AppContext` 中是否有 `WorkerPool`
- 如果有，使用 worker 执行测试
- 如果没有或失败，回退到直接执行

**实现要点**：
```typescript
async executeImpl(args: RunTestsArgs): Promise<TestRunResult> {
  const workerPool = getAppContext().workerPool;
  
  if (workerPool && process.env.WORKER_ENABLED !== 'false') {
    try {
      return await workerPool.executeTask<TestRunnerPayload, TestRunResult>({
        type: 'test',
        workspaceId: args.workspaceId,
        payload: { ... },
        timeout: (args.timeout || 60000) + 5000,
      });
    } catch (error) {
      logger.warn('[RunTests] Worker failed, fallback to direct execution', { error });
      return this.runDirectly(args);
    }
  }
  
  return this.runDirectly(args);
}
```

**依赖**：
- `WorkerPool`（M2.1）

**验收**：
- ✅ 优先使用 worker 执行
- ✅ Worker 失败时自动回退
- ✅ 可以通过 `WORKER_ENABLED=false` 禁用

---

#### M2.8 更新 AppContext 和初始化（~30 行）

**文件**：`src/core/app-context.ts`

```typescript
export interface AppContext {
  // ... 已有字段
  workerPool?: WorkerPool;
}
```

**文件**：`src/index.ts`

```typescript
// 初始化 Worker 池
const workerPool = process.env.WORKER_ENABLED !== 'false' 
  ? new WorkerPool(parseInt(process.env.WORKER_MAX_POOL || '3', 10))
  : undefined;

setAppContext({
  // ... 已有字段
  workerPool,
});

// 进程退出时清理 worker
process.on('SIGINT', async () => {
  if (workerPool) {
    await workerPool.cleanup();
  }
  // ... 其他清理
});
```

**验收**：
- ✅ Worker 池正确初始化
- ✅ 进程退出时正确清理

---

#### M2.9 注册新工具到 MCP（~10 行）

**文件**：`src/index.ts`

```typescript
toolRegistry.register(new AnalyzeTestMatrixWorkerTool(openai, state));
toolRegistry.register(new GenerateTestsWorkerTool(openai, embedding, state, contextStore));
```

**验收**：
- ✅ 新工具在 MCP 中可见

---

### 📋 M2 验收标准

**功能完整性**：
- ✅ 分析、生成、测试执行都可以在 worker 中进行
- ✅ Worker 超时自动终止
- ✅ Worker 崩溃不影响主进程
- ✅ 支持 3 个 worker 并发
- ✅ 支持回退到直接执行
- ✅ 可以通过环境变量禁用 worker

**测试用例**：
```javascript
// 测试用例 1：分析（worker）
const matrix = await mcpAgent.call('analyze-test-matrix-worker', {
  workspaceId,
  diff,
  projectConfig
})

// 测试用例 2：生成（worker）
const tests = await mcpAgent.call('generate-tests-worker', {
  workspaceId,
  matrix,
  scenarios: ['happy-path']
})

// 测试用例 3：测试执行（自动使用 worker）
const results = await mcpAgent.call('run-tests', {
  workspaceId,
  testFiles: [...]
})

// 测试用例 4：禁用 worker
process.env.WORKER_ENABLED = 'false'
// 验证回退到直接执行
```

---

## M3: 测试用例修复（P1）

### 目标
修复失败的测试用例（调整测试代码），而非修复源代码

### 📝 子任务列表

#### M3.1 创建测试修复 Agent（~300 行）

**文件**：`src/agents/test-fix-agent.ts`

**接口**：
```typescript
export interface TestFixContext {
  failures: TestFailure[];
  testFiles: Map<string, string>;
  projectConfig: ProjectConfig;
}

export interface TestFailure {
  testName: string;
  testFile: string;
  errorMessage: string;
  stackTrace: string;
}

export interface TestFix {
  testFile: string;
  originalCode: string;
  fixedCode: string;
  reason: string;
  confidence: number;
}

export class TestFixAgent extends BaseAgent<TestFix> {
  async execute(context: TestFixContext): Promise<AgentResult<TestFix>>
}
```

**实现要点**：
- **analyzeFailure**：分析失败原因（Mock 不正确、断言过严、异步处理等）
- **generateFix**：生成修复后的测试代码
- **Prompt 设计**：
  - 系统角色：专业的测试工程师
  - 强调：只修复测试代码，不修改源代码
  - 常见修复方法：Mock 调整、断言放松、添加 await、环境兼容

**依赖**：
- `OpenAIClient`（已有）
- `BaseAgent`（已有）

**验收**：
- ✅ 可以分析失败原因
- ✅ 可以生成修复代码
- ✅ 修复建议合理（置信度 > 0.7）

---

#### M3.2 创建 Prompt 模板（~100 行）

**文件**：`src/prompts/test-fix-agent.md`

**内容**：
- 核心原则（只修复测试、最小化修改、保持测试意图）
- 常见失败场景与修复方法（6 种场景 + 示例）
- 输出格式（JSON）

**参考**：详见 `implementation-improvement-plan.md` M3.3 节

**验收**：
- ✅ Prompt 清晰明确
- ✅ 包含足够的示例

---

#### M3.3 创建工具：fix-failing-tests（~250 行）

**文件**：`src/tools/fix-failing-tests.ts`

**参数**：
```typescript
{
  workspaceId: string;
  testResults: TestRunResult;
  maxAttempts?: number;  // 默认 3
}
```

**返回**：
```typescript
{
  success: boolean;
  fixes: TestFix[];
  retriedResults?: TestRunResult;
  attempts: number;
}
```

**实现步骤**：
1. 从 `testResults` 中提取失败的测试
2. 读取测试文件内容
3. 调用 `TestFixAgent.execute()` 生成修复
4. 应用修复（写入文件）
5. 重新运行测试
6. 如果还有失败且未达到最大尝试次数，重复步骤 1-5

**实现要点**：
- **extractFailures**：解析测试输出（Vitest/Jest 格式）
- **readTestFiles**：读取失败的测试文件
- **applyFixes**：将修复后的代码写入文件
- **循环控制**：最多尝试 `maxAttempts` 次

**依赖**：
- `TestFixAgent`（M3.1）
- `WorkspaceManager`（M1.2）
- `RunTestsTool`（已有）

**验收**：
- ✅ 可以提取失败的测试
- ✅ 可以生成并应用修复
- ✅ 可以重新运行测试
- ✅ 支持多轮修复

---

#### M3.4 注册新工具到 MCP（~10 行）

**文件**：`src/index.ts`

```typescript
toolRegistry.register(new FixFailingTestsTool());
```

**验收**：
- ✅ 工具在 MCP 中可见

---

### 📋 M3 验收标准

**功能完整性**：
- ✅ 可以分析失败的测试用例
- ✅ 可以生成修复后的测试代码
- ✅ 修复后自动重新运行测试
- ✅ 支持多轮修复（最多 3 次）
- ✅ 置信度评估准确（> 0.7）

**测试用例**：
```javascript
// 测试用例 1：修复失败的测试
const fixResult = await mcpAgent.call('fix-failing-tests', {
  workspaceId,
  testResults: { /* 包含失败信息 */ },
  maxAttempts: 3
})

// 验证：
// - fixes 数组包含修复建议
// - retriedResults 显示测试通过
// - attempts <= maxAttempts
```

---

## M4: n8n 集成增强（P1）

### 目标
提供一键式工具，简化 n8n 工作流

### 📝 子任务列表

#### M4.1 创建一键式工作流工具（~400 行）

**文件**：`src/tools/test-generation-workflow.ts`

**参数**：
```typescript
{
  repoUrl: string;
  branch: string;
  baselineBranch?: string;
  scenarios?: string[];
  autoFix?: boolean;        // 是否自动修复失败的测试
  maxFixAttempts?: number;
  maxTests?: number;
}
```

**返回**：
```typescript
{
  workspaceId: string;
  projectConfig: ProjectConfig;
  matrix: TestMatrix;
  tests: TestCase[];
  filesWritten: string[];
  testResults: TestRunResult;
  fixes?: TestFix[];
}
```

**实现步骤**：
1. 调用 `FetchDiffFromRepoTool` 获取 diff 和项目配置
2. 调用 `AnalyzeTestMatrixWorkerTool` 分析测试矩阵
3. 调用 `GenerateTestsWorkerTool` 生成测试
4. 调用 `WriteTestFileTool` 写入测试文件
5. 调用 `RunTestsTool` 运行测试
6. 如果 `autoFix=true` 且有失败，调用 `FixFailingTestsTool` 修复
7. 返回完整结果

**实现要点**：
- 使用 try-catch 处理每个步骤的错误
- 记录每个步骤的耗时
- 提供详细的错误信息

**依赖**：
- M1.4（FetchDiffFromRepoTool）
- M2.5（AnalyzeTestMatrixWorkerTool）
- M2.6（GenerateTestsWorkerTool）
- 已有工具（WriteTestFileTool, RunTestsTool）
- M3.3（FixFailingTestsTool）

**验收**：
- ✅ 可以一键完成整个流程
- ✅ 返回完整结果
- ✅ 错误处理合理

---

#### M4.2 注册新工具到 MCP（~10 行）

**文件**：`src/index.ts`

```typescript
toolRegistry.register(new TestGenerationWorkflowTool());
```

**验收**：
- ✅ 工具在 MCP 中可见

---

### 📋 M4 验收标准

**功能完整性**：
- ✅ 可以一键完成整个测试生成流程
- ✅ 支持自动修复选项
- ✅ 返回完整结果

**测试用例**：
```javascript
// 测试用例 1：完整流程（带修复）
const result = await mcpAgent.call('test-generation-workflow', {
  repoUrl: 'https://github.com/org/repo.git',
  branch: 'feature/test',
  scenarios: ['happy-path', 'edge-case'],
  autoFix: true,
  maxFixAttempts: 3
})

// 验证：
// - workspaceId 存在
// - tests 数组不为空
// - testResults 包含测试结果
// - 如果有失败且 autoFix=true，fixes 数组不为空
```

---

## M5: 配置文件增强（P2）

### 目标
补充 `.cursor/rule/fe-mcp.md` 推荐配置

### 📝 子任务列表

#### M5.1 创建配置模板（~200 行）

**文件**：`docs/cursor-rule-template.md`

**内容**：
- 项目信息（类型、测试框架、Monorepo）
- 测试配置（场景优先级、最大测试数）
- 代码规范（React、测试、Mock、断言）
- Monorepo 配置
- 排除规则
- 已有测试处理策略
- 项目特定规则（状态管理、API、路由）

**参考**：详见 `implementation-improvement-plan.md` M5 节

**验收**：
- ✅ 模板完整清晰
- ✅ 包含所有推荐规则

---

#### M5.2 创建工具：generate-cursor-rule（~100 行）

**文件**：`src/tools/generate-cursor-rule.ts`

**参数**：
```typescript
{
  workspaceId: string;
  outputPath?: string;  // 默认 .cursor/rule/fe-mcp.md
}
```

**返回**：
```typescript
{
  filePath: string;
  content: string;
}
```

**实现步骤**：
1. 从 `WorkspaceManager` 获取工作区
2. 从 `ProjectDetector` 获取项目配置
3. 读取模板文件
4. 替换模板中的占位符（项目名、测试框架等）
5. 写入文件到指定路径

**依赖**：
- `WorkspaceManager`（M1.2）
- `ProjectDetector`（M1.3）
- `cursor-rule-template.md`（M5.1）

**验收**：
- ✅ 可以生成配置文件
- ✅ 配置文件内容正确

---

#### M5.3 注册新工具到 MCP（~10 行）

**文件**：`src/index.ts`

```typescript
toolRegistry.register(new GenerateCursorRuleTool());
```

**验收**：
- ✅ 工具在 MCP 中可见

---

### 📋 M5 验收标准

**功能完整性**：
- ✅ 提供完整的配置模板
- ✅ 可以自动生成项目配置
- ✅ 配置文件包含所有推荐规则
- ✅ 支持 Monorepo 子项目配置

**测试用例**：
```javascript
// 测试用例 1：生成配置文件
const config = await mcpAgent.call('generate-cursor-rule', {
  workspaceId,
  outputPath: '.cursor/rule/fe-mcp.md'
})

// 验证：
// - 文件成功创建
// - 内容包含项目信息
// - 格式正确
```

---

## 环境变量配置

### 新增环境变量

```bash
# Worker 配置
WORKER_ENABLED=true                 # 是否启用 worker（默认 true）
WORKER_MAX_POOL=3                   # Worker 池大小（默认 3）
WORKER_TIMEOUT_MS=300000            # Worker 超时（默认 5 分钟）

# 工作区配置
WORKSPACE_CLEANUP_INTERVAL=600000   # 清理间隔（默认 10 分钟）
WORKSPACE_MAX_AGE=3600000           # 工作区最大存活时间（默认 1 小时）

# 测试修复配置
FIX_MAX_ATTEMPTS=3                  # 最大修复尝试次数（默认 3）
FIX_CONFIDENCE_THRESHOLD=0.7        # 修复置信度阈值（默认 0.7）
```

---

## 开发指南

### 开发顺序

1. **M1 → M2**：先实现工作区管理，再实现 worker 机制
2. **M3**：可以在 M1 完成后并行开发
3. **M4**：依赖 M1、M2、M3 全部完成
4. **M5**：可以在 M1 完成后随时开发

### 代码规范

- ✅ 使用 TypeScript
- ✅ 遵循 ESLint 规则
- ✅ 所有公共方法添加 JSDoc 注释
- ✅ 错误处理：使用 try-catch，记录详细日志
- ✅ 命名规范：
  - 类名：PascalCase
  - 方法名：camelCase
  - 常量：UPPER_SNAKE_CASE

### 测试策略

- **单元测试**：核心模块（WorkspaceManager, ProjectDetector, TestFixAgent）
- **集成测试**：工具链（fetch-diff-from-repo → analyze → generate → run → fix）
- **E2E 测试**：完整流程（test-generation-workflow）

### 日志规范

```typescript
// 使用已有的 logger
import { logger } from '../utils/logger.js';

// 关键操作
logger.info('[WorkspaceManager] Creating workspace', { repoUrl, branch });

// 警告
logger.warn('[WorkerPool] Worker timeout', { workerId, timeout });

// 错误
logger.error('[TestFixAgent] Failed to generate fix', { error, testFile });
```

---

## 完成检查清单

### M1 完成检查

- [ ] GitClient 实现完成
- [ ] WorkspaceManager 实现完成
- [ ] ProjectDetector 实现完成
- [ ] fetch-diff-from-repo 工具实现完成
- [ ] detect-project-config 工具实现完成
- [ ] AppContext 更新完成
- [ ] 工具已注册到 MCP
- [ ] 单元测试通过
- [ ] 集成测试通过
- [ ] 文档更新（README.md）

### M2 完成检查

- [ ] WorkerPool 实现完成
- [ ] analysis-worker 实现完成
- [ ] generation-worker 实现完成
- [ ] test-runner-worker 实现完成
- [ ] analyze-test-matrix-worker 工具实现完成
- [ ] generate-tests-worker 工具实现完成
- [ ] run-tests 工具更新完成
- [ ] AppContext 更新完成
- [ ] 工具已注册到 MCP
- [ ] Worker 超时测试通过
- [ ] Worker 回退测试通过
- [ ] 文档更新

### M3 完成检查

- [ ] TestFixAgent 实现完成
- [ ] Prompt 模板创建完成
- [ ] fix-failing-tests 工具实现完成
- [ ] 工具已注册到 MCP
- [ ] 修复测试通过（至少 60% 成功率）
- [ ] 多轮修复测试通过
- [ ] 文档更新

### M4 完成检查

- [ ] test-generation-workflow 工具实现完成
- [ ] 工具已注册到 MCP
- [ ] 完整流程测试通过
- [ ] 带修复的流程测试通过
- [ ] n8n 集成文档更新

### M5 完成检查

- [ ] cursor-rule-template.md 创建完成
- [ ] generate-cursor-rule 工具实现完成
- [ ] 工具已注册到 MCP
- [ ] 配置生成测试通过
- [ ] 文档更新

---

## 常见问题

### Q1: Worker 为什么会超时？

**原因**：
- LLM 调用耗时过长
- 测试执行时间超出预期
- 网络问题

**解决**：
- 增加 `WORKER_TIMEOUT_MS`
- 检查网络连接
- 优化 LLM Prompt（减少 token 数量）

### Q2: 工作区清理不及时怎么办？

**原因**：
- 清理间隔太长
- 工作区被占用（进程未退出）

**解决**：
- 减少 `WORKSPACE_CLEANUP_INTERVAL`
- 确保进程正常退出时清理工作区

### Q3: 测试修复成功率低怎么办？

**原因**：
- Prompt 不够清晰
- 测试失败信息不够详细
- LLM 能力限制

**解决**：
- 优化 Prompt（增加更多示例）
- 改进失败信息提取逻辑
- 调整置信度阈值

---

## 文档更新

### 需要更新的文档

1. **README.md**
   - 新增工具说明（fetch-diff-from-repo, fix-failing-tests, test-generation-workflow）
   - 新增环境变量说明
   - 新增 n8n 集成示例

2. **docs/n8n-integration.md**（新建）
   - n8n 工作流示例
   - 逐步调用和一键式调用对比
   - 常见问题

3. **docs/cursor-rule-guide.md**（新建）
   - 配置文件说明
   - 推荐规则
   - Monorepo 配置示例

---

**最后更新**：2024-11-15  
**版本**：v1.0  
**状态**：Ready for Implementation
