# 实现改进方案 - 对齐文档与代码（修订版）

> 基于 `commit-branch-test-repair.md` 设计文档与当前代码库的对比分析
> 
> **重要澄清**：
> - ✅ 修复指的是修复失败的测试用例（调整测试代码让其通过），而非修复源代码
> - ✅ 主要使用场景是在 n8n 中作为 agent 节点调用
> - ✅ 支持多 Git 项目和 Monorepo
> - ✅ Worker 用于隔离耗时任务（分析/生成/测试执行）

## 📊 现状分析

### 当前实现的优势

✅ **核心能力已具备**
- **AgentCoordinator**: 多 Agent 协同框架，支持并行执行、优先级调度、自动重试
- **TestAgent**: 完整的测试生成流程（矩阵分析 + 4 种场景并行生成）
- **工具链完整**: fetch-commit-changes → analyze-test-matrix → generate-tests → write-test-file → run-tests
- **性能优化**: OpenAI 响应缓存、p-limit 并发控制、自动去重
- **FastMCP 架构**: HTTP Streaming 支持，适合 n8n 集成

✅ **已有的外部集成**
- **n8n/GitLab 支持**: analyze-raw-diff-test-matrix, generate-tests-from-raw-diff
- **Phabricator 集成**: fetch-diff, publish-phabricator-comments（已在其他分支）

### 当前实现与文档设计的差异

| 模块 | 文档设计 | 当前实现 | 实际需求 |
|------|---------|---------|---------|
| **Worker 机制** | 测试执行隔离 | ❌ 无 | ✅ **需要**：分析/生成/测试都需要隔离 |
| **多项目管理** | 工作区管理 | ❌ 无 | ✅ **需要**：支持多个 Git 项目并发 |
| **Diff 获取** | 外部输入 | ⚠️ 需要外部提供 | ✅ **可增强**：通过仓库名+分支名获取 |
| **测试修复** | 智能修复源码 | ❌ 无 | ⚠️ **澄清**：是修复测试用例，不是源码 |
| **任务追踪** | 持久化状态 | ❌ 无 | ⚠️ **重新评估**：n8n 场景可能不需要 |
| **GitLab 集成** | 自动 MR | ❌ 无 | ⚠️ **可选**：n8n 可以自己处理 |
| **Monorepo** | 基础支持 | ⚠️ 部分支持 | ✅ **需增强**：自动检测子项目 |
| **测试工具检测** | 无明确要求 | ❌ 无 | ✅ **需要**：检测项目是否已有测试 |

---

## 🎯 改进方案设计（重新调整）

### 设计原则

1. **面向 n8n 集成**：工具设计适合在 n8n agent 节点中调用
2. **Worker 隔离耗时任务**：分析、生成、测试执行都可以在 worker 中进行
3. **支持多项目并发**：可以同时处理多个 Git 项目（包括 Monorepo）
4. **智能项目检测**：自动检测测试框架、项目结构、是否已有测试
5. **兼容现有架构**：不破坏现有工具，渐进式增强

### 架构改进

```
src/
  orchestrator/              # 新增：多项目管理
    workspace-manager.ts     # Git 工作区生命周期（支持多项目）
    project-detector.ts      # 项目检测（Monorepo、测试框架）
  
  agents/
    test-agent.ts            # 已有
    test-matrix-analyzer.ts  # 已有
    test-fix-agent.ts        # 新增：修复失败的测试用例
    base.ts                  # 已有
  
  workers/                   # 新增：Worker 隔离
    analysis-worker.ts       # 分析任务 worker
    generation-worker.ts     # 生成任务 worker
    test-runner-worker.ts    # 测试执行 worker
    worker-pool.ts           # Worker 池管理
  
  tools/
    # 已有工具保持不变
    # 新增增强工具
    fetch-diff-from-repo.ts       # 通过仓库名+分支名获取 diff
    analyze-test-matrix-worker.ts # worker 版本的分析工具
    generate-tests-worker.ts      # worker 版本的生成工具
    fix-failing-tests.ts          # 修复失败的测试用例
    detect-project-config.ts      # 检测项目配置
  
  clients/
    git-client.ts            # 新增：Git 操作客户端
    openai.ts                # 已有
    embedding.ts             # 已有
  
  core/                      # 已有核心模块保持不变
    agent-coordinator.ts
    react-engine.ts
    ...
```

---

## 📋 实现里程碑（重新规划）

### M1: 多项目工作区管理（优先级 P0）

**目标**：支持多个 Git 项目并发处理，自动检测项目配置

#### 交付物

1. **orchestrator/workspace-manager.ts** - 多项目工作区管理
```typescript
export interface WorkspaceConfig {
  repoUrl: string;           // Git 仓库 URL 或本地路径
  branch: string;            // 要分析的分支
  baselineBranch?: string;   // 对比基准分支
  workDir?: string;          // 可选：指定工作目录（默认临时目录）
}

export class WorkspaceManager {
  private workspaces = new Map<string, Workspace>();
  
  // 创建工作区（支持多项目）
  async createWorkspace(config: WorkspaceConfig): Promise<string> {
    const workspaceId = this.generateWorkspaceId();
    const workDir = config.workDir || `/tmp/mcp-workspace/${workspaceId}`;
    
    // 如果是本地路径，直接使用；否则 clone
    if (this.isLocalPath(config.repoUrl)) {
      await this.symlinkOrCopy(config.repoUrl, workDir);
    } else {
      await this.gitClone(config.repoUrl, workDir, config.branch);
    }
    
    this.workspaces.set(workspaceId, {
      id: workspaceId,
      workDir,
      config,
      createdAt: Date.now(),
    });
    
    return workspaceId;
  }
  
  // 获取 diff
  async getDiff(workspaceId: string): Promise<string> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);
    
    const baselineBranch = workspace.config.baselineBranch || 'origin/HEAD';
    return this.gitDiff(workspace.workDir, baselineBranch);
  }
  
  // 清理工作区
  async cleanup(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;
    
    // 如果是临时目录，删除；如果是用户指定的，保留
    if (workspace.workDir.startsWith('/tmp/mcp-workspace/')) {
      await fs.rm(workspace.workDir, { recursive: true, force: true });
    }
    
    this.workspaces.delete(workspaceId);
  }
  
  // 自动清理过期工作区（超过 1 小时）
  async cleanupExpired(): Promise<void> {
    const now = Date.now();
    const expired = Array.from(this.workspaces.entries())
      .filter(([_, ws]) => now - ws.createdAt > 3600000);
    
    for (const [id, _] of expired) {
      await this.cleanup(id);
    }
  }
}
```

2. **orchestrator/project-detector.ts** - 项目检测
```typescript
export interface ProjectConfig {
  projectRoot: string;       // 项目根目录
  packageRoot?: string;      // Package 根目录（Monorepo 中的子项目）
  isMonorepo: boolean;       // 是否是 Monorepo
  monorepoType?: 'pnpm' | 'yarn' | 'npm' | 'lerna' | 'nx' | 'rush';
  testFramework?: 'vitest' | 'jest' | 'none';
  hasExistingTests: boolean; // 是否已有测试文件
  testPattern?: string;      // 测试文件匹配模式
  customRules?: string;      // 自定义规则内容（从 .cursor/rule/fe-mcp.md 读取）
}

export class ProjectDetector {
  // 检测项目配置
  async detectProject(workDir: string): Promise<ProjectConfig> {
    const isMonorepo = await this.detectMonorepo(workDir);
    const monorepoType = isMonorepo ? await this.detectMonorepoType(workDir) : undefined;
    const testFramework = await this.detectTestFramework(workDir);
    const hasExistingTests = await this.detectExistingTests(workDir);
    const testPattern = await this.getTestPattern(workDir, testFramework);
    const customRules = await this.loadCustomRules(workDir);
    
    return {
      projectRoot: workDir,
      isMonorepo,
      monorepoType,
      testFramework,
      hasExistingTests,
      testPattern,
      customRules,
    };
  }
  
  // 检测 Monorepo
  private async detectMonorepo(workDir: string): Promise<boolean> {
    // 检查 pnpm-workspace.yaml, lerna.json, nx.json 等
    const indicators = [
      'pnpm-workspace.yaml',
      'lerna.json',
      'nx.json',
      'rush.json',
      'package.json' // 检查 workspaces 字段
    ];
    
    for (const file of indicators) {
      const exists = await fs.pathExists(path.join(workDir, file));
      if (exists) {
        // 进一步验证
        if (file === 'package.json') {
          const pkg = await fs.readJson(path.join(workDir, file));
          return !!(pkg.workspaces || pkg.workspace);
        }
        return true;
      }
    }
    
    return false;
  }
  
  // 检测测试框架
  private async detectTestFramework(workDir: string): Promise<'vitest' | 'jest' | 'none'> {
    const pkgPath = path.join(workDir, 'package.json');
    if (!await fs.pathExists(pkgPath)) return 'none';
    
    const pkg = await fs.readJson(pkgPath);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    
    if (deps.vitest) return 'vitest';
    if (deps.jest || deps['@jest/core']) return 'jest';
    
    return 'none';
  }
  
  // 检测是否已有测试
  private async detectExistingTests(workDir: string): Promise<boolean> {
    // 查找常见测试文件
    const testPatterns = [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/__tests__/**/*.ts',
      '**/__tests__/**/*.tsx',
    ];
    
    for (const pattern of testPatterns) {
      const files = await glob(pattern, { cwd: workDir, ignore: ['**/node_modules/**'] });
      if (files.length > 0) return true;
    }
    
    return false;
  }
  
  // 加载自定义规则
  private async loadCustomRules(workDir: string): Promise<string | undefined> {
    const ruleFiles = [
      '.cursor/rule/fe-mcp.md',
      'fe-mcp.md',
      '.cursorrules',
      // ... 其他已有的 rule 文件
    ];
    
    for (const file of ruleFiles) {
      const filePath = path.join(workDir, file);
      if (await fs.pathExists(filePath)) {
        return await fs.readFile(filePath, 'utf-8');
      }
    }
    
    return undefined;
  }
  
  // 对于 Monorepo，检测变更文件所属的子项目
  async detectSubProject(workDir: string, changedFiles: string[]): Promise<string | undefined> {
    if (!await this.detectMonorepo(workDir)) return undefined;
    
    // 读取 workspace 配置
    const workspaces = await this.getWorkspaces(workDir);
    
    // 找到变更文件最多的子项目
    const subProjectCounts = new Map<string, number>();
    for (const file of changedFiles) {
      for (const ws of workspaces) {
        if (file.startsWith(ws + '/')) {
          subProjectCounts.set(ws, (subProjectCounts.get(ws) || 0) + 1);
        }
      }
    }
    
    // 返回变更最多的子项目
    if (subProjectCounts.size > 0) {
      return Array.from(subProjectCounts.entries())
        .sort((a, b) => b[1] - a[1])[0][0];
    }
    
    return undefined;
  }
}
```

3. **clients/git-client.ts** - Git 操作客户端
```typescript
export class GitClient {
  // Clone 仓库
  async clone(repoUrl: string, targetDir: string, branch?: string): Promise<void> {
    const args = ['clone', '--depth=1'];
    if (branch) args.push('-b', branch);
    args.push(repoUrl, targetDir);
    
    await this.execGit(args);
  }
  
  // 获取 diff
  async diff(workDir: string, baseRef: string, targetRef?: string): Promise<string> {
    const args = ['diff', baseRef];
    if (targetRef) args.push(targetRef);
    
    const result = await this.execGit(args, { cwd: workDir });
    return result.stdout;
  }
  
  // 获取变更的文件列表
  async getChangedFiles(workDir: string, baseRef: string, targetRef?: string): Promise<string[]> {
    const args = ['diff', '--name-only', baseRef];
    if (targetRef) args.push(targetRef);
    
    const result = await this.execGit(args, { cwd: workDir });
    return result.stdout.split('\n').filter(Boolean);
  }
  
  // 检查分支是否存在
  async branchExists(workDir: string, branch: string): Promise<boolean> {
    try {
      await this.execGit(['rev-parse', '--verify', branch], { cwd: workDir });
      return true;
    } catch {
      return false;
    }
  }
  
  private async execGit(args: string[], options?: ExecOptions): Promise<ExecResult> {
    // 使用 execa 或 child_process.exec
    const { stdout, stderr } = await exec(`git ${args.join(' ')}`, options);
    return { stdout, stderr };
  }
}
```

4. **tools/fetch-diff-from-repo.ts** - 通过仓库名+分支名获取 diff
```typescript
export interface FetchDiffFromRepoArgs {
  repoUrl: string;           // Git 仓库 URL 或本地路径
  branch: string;            // 要分析的分支
  baselineBranch?: string;   // 对比基准分支（默认 origin/HEAD）
  workDir?: string;          // 可选：指定工作目录
}

export class FetchDiffFromRepoTool extends BaseTool {
  async executeImpl(args: FetchDiffFromRepoArgs): Promise<{
    workspaceId: string;
    diff: string;
    projectConfig: ProjectConfig;
    changedFiles: string[];
  }> {
    const workspaceManager = getAppContext().workspaceManager;
    const projectDetector = getAppContext().projectDetector;
    const gitClient = getAppContext().gitClient;
    
    // 1. 创建工作区
    const workspaceId = await workspaceManager.createWorkspace({
      repoUrl: args.repoUrl,
      branch: args.branch,
      baselineBranch: args.baselineBranch,
      workDir: args.workDir,
    });
    
    const workspace = workspaceManager.getWorkspace(workspaceId);
    
    // 2. 检测项目配置
    const projectConfig = await projectDetector.detectProject(workspace.workDir);
    
    // 3. 获取 diff 和变更文件
    const diff = await workspaceManager.getDiff(workspaceId);
    const changedFiles = await gitClient.getChangedFiles(
      workspace.workDir,
      args.baselineBranch || 'origin/HEAD'
    );
    
    // 4. 如果是 Monorepo，检测子项目
    if (projectConfig.isMonorepo) {
      const subProject = await projectDetector.detectSubProject(
        workspace.workDir,
        changedFiles
      );
      if (subProject) {
        projectConfig.packageRoot = subProject;
      }
    }
    
    return {
      workspaceId,
      diff,
      projectConfig,
      changedFiles,
    };
  }
}
```

5. **tools/detect-project-config.ts** - 检测项目配置
```typescript
export interface DetectProjectConfigArgs {
  workspaceId: string;       // 已创建的工作区 ID
}

export class DetectProjectConfigTool extends BaseTool {
  async executeImpl(args: DetectProjectConfigArgs): Promise<ProjectConfig> {
    const workspaceManager = getAppContext().workspaceManager;
    const projectDetector = getAppContext().projectDetector;
    
    const workspace = workspaceManager.getWorkspace(args.workspaceId);
    return projectDetector.detectProject(workspace.workDir);
  }
}
```

#### 验证标准
- ✅ 可以从 Git 仓库 URL 或本地路径创建工作区
- ✅ 可以获取 diff 和变更文件列表
- ✅ 可以自动检测 Monorepo 和测试框架
- ✅ 可以加载自定义规则（.cursor/rule/fe-mcp.md）
- ✅ 支持多个工作区并发存在
- ✅ 自动清理过期工作区

---

### M2: Worker 机制（优先级 P0）

**目标**：将耗时任务（分析、生成、测试）隔离到 worker 线程

#### 交付物

1. **workers/worker-pool.ts** - Worker 池管理
```typescript
export interface WorkerTask<T = any> {
  type: 'analyze' | 'generate' | 'test';
  workspaceId: string;
  payload: T;
  timeout?: number;
}

export class WorkerPool {
  private workers = new Map<string, Worker>();
  private maxWorkers: number;
  private taskQueue: WorkerTask[] = [];
  
  constructor(maxWorkers: number = 3) {
    this.maxWorkers = maxWorkers;
  }
  
  // 执行任务（自动选择 worker）
  async executeTask<TInput, TOutput>(task: WorkerTask<TInput>): Promise<TOutput> {
    // 如果达到最大 worker 数，等待
    while (this.workers.size >= this.maxWorkers) {
      await this.waitForAvailableWorker();
    }
    
    // 选择合适的 worker 文件
    const workerPath = this.getWorkerPath(task.type);
    
    // 创建 worker
    const workerId = `${task.type}-${Date.now()}`;
    const worker = new Worker(workerPath, {
      workerData: { workspaceId: task.workspaceId },
    });
    
    this.workers.set(workerId, worker);
    
    try {
      const result = await this.runWorkerTask<TInput, TOutput>(
        worker,
        task.payload,
        task.timeout
      );
      return result;
    } finally {
      // 清理 worker
      await worker.terminate();
      this.workers.delete(workerId);
    }
  }
  
  private async runWorkerTask<TInput, TOutput>(
    worker: Worker,
    payload: TInput,
    timeout?: number
  ): Promise<TOutput> {
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => {
        worker.terminate();
        reject(new Error('Worker task timeout'));
      }, timeout) : null;
      
      worker.on('message', (message) => {
        if (timer) clearTimeout(timer);
        if (message.success) {
          resolve(message.result);
        } else {
          reject(new Error(message.error));
        }
      });
      
      worker.on('error', (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      });
      
      worker.postMessage(payload);
    });
  }
  
  private getWorkerPath(type: string): string {
    return path.join(__dirname, `${type}-worker.js`);
  }
  
  async cleanup(): Promise<void> {
    for (const [id, worker] of this.workers) {
      await worker.terminate();
    }
    this.workers.clear();
  }
}
```

2. **workers/analysis-worker.ts** - 分析任务 worker
```typescript
import { parentPort, workerData } from 'worker_threads';

interface AnalysisPayload {
  diff: string;
  projectConfig: ProjectConfig;
}

parentPort?.on('message', async (payload: AnalysisPayload) => {
  try {
    // 在 worker 中执行分析
    const analyzer = new TestMatrixAnalyzer(getOpenAIClient());
    
    const result = await analyzer.execute({
      diff: payload.diff,
      files: [], // 从 diff 解析
      framework: payload.projectConfig.testFramework,
    });
    
    parentPort?.postMessage({
      success: true,
      result: result.items[0],
    });
  } catch (error) {
    parentPort?.postMessage({
      success: false,
      error: error.message,
    });
  }
});
```

3. **workers/generation-worker.ts** - 生成任务 worker
```typescript
import { parentPort, workerData } from 'worker_threads';

interface GenerationPayload {
  diff: string;
  matrix: TestMatrix;
  projectConfig: ProjectConfig;
  scenarios: string[];
}

parentPort?.on('message', async (payload: GenerationPayload) => {
  try {
    const testAgent = new TestAgent(
      getOpenAIClient(),
      getEmbeddingClient(),
      getStateManager(),
      getContextStore()
    );
    
    const result = await testAgent.generateTests(
      { raw: payload.diff } as Diff,
      payload.matrix,
      {
        maxSteps: 10,
        mode: 'incremental',
        scenarios: payload.scenarios,
        framework: payload.projectConfig.testFramework,
      },
      {} as AgentContext
    );
    
    parentPort?.postMessage({
      success: true,
      result,
    });
  } catch (error) {
    parentPort?.postMessage({
      success: false,
      error: error.message,
    });
  }
});
```

4. **workers/test-runner-worker.ts** - 测试执行 worker
```typescript
import { parentPort, workerData } from 'worker_threads';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface TestRunnerPayload {
  workDir: string;
  testFiles?: string[];
  framework: 'vitest' | 'jest';
  timeout?: number;
}

parentPort?.on('message', async (payload: TestRunnerPayload) => {
  try {
    const { workDir, testFiles, framework, timeout = 60000 } = payload;
    
    // 构建测试命令
    let command: string;
    if (framework === 'vitest') {
      command = testFiles
        ? `vitest run ${testFiles.join(' ')}`
        : 'vitest run';
    } else {
      command = testFiles
        ? `jest ${testFiles.join(' ')}`
        : 'jest';
    }
    
    // 执行测试
    const result = await execAsync(command, {
      cwd: workDir,
      timeout,
      env: { ...process.env, CI: '1' },
    });
    
    // 解析测试结果
    const parsed = parseTestOutput(result.stdout, framework);
    
    parentPort?.postMessage({
      success: true,
      result: {
        ...parsed,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    });
  } catch (error) {
    parentPort?.postMessage({
      success: false,
      error: error.message,
      stdout: error.stdout,
      stderr: error.stderr,
    });
  }
});

function parseTestOutput(output: string, framework: string): TestSummary {
  // 解析测试输出，提取通过/失败/跳过数量
  // Vitest: "Test Files  2 passed (2)"
  // Jest: "Tests:       5 passed, 5 total"
  
  // ... 解析逻辑
  
  return {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    duration: 0,
  };
}
```

5. **更新工具：使用 worker 执行**

```typescript
// tools/analyze-test-matrix-worker.ts
export class AnalyzeTestMatrixWorkerTool extends BaseTool {
  async executeImpl(args: AnalyzeTestMatrixArgs): Promise<TestMatrix> {
    const workerPool = getAppContext().workerPool;
    
    if (workerPool) {
      // 使用 worker 执行
      const result = await workerPool.executeTask<AnalysisPayload, TestMatrix>({
        type: 'analyze',
        workspaceId: args.workspaceId,
        payload: {
          diff: args.rawDiff,
          projectConfig: args.projectConfig,
        },
        timeout: 120000, // 2 分钟
      });
      return result;
    } else {
      // 回退到直接执行
      return this.analyzeDirectly(args);
    }
  }
}

// tools/generate-tests-worker.ts
export class GenerateTestsWorkerTool extends BaseTool {
  async executeImpl(args: GenerateTestsArgs): Promise<TestCase[]> {
    const workerPool = getAppContext().workerPool;
    
    if (workerPool) {
      const result = await workerPool.executeTask<GenerationPayload, TestCase[]>({
        type: 'generate',
        workspaceId: args.workspaceId,
        payload: {
          diff: args.rawDiff,
          matrix: args.matrix,
          projectConfig: args.projectConfig,
          scenarios: args.scenarios || ['happy-path', 'edge-case'],
        },
        timeout: 300000, // 5 分钟
      });
      return result;
    } else {
      return this.generateDirectly(args);
    }
  }
}

// 更新 run-tests.ts
export class RunTestsTool extends BaseTool {
  async executeImpl(args: RunTestsArgs): Promise<TestRunResult> {
    const workerPool = getAppContext().workerPool;
    
    if (workerPool) {
      const result = await workerPool.executeTask<TestRunnerPayload, TestRunResult>({
        type: 'test',
        workspaceId: args.workspaceId,
        payload: {
          workDir: args.projectRoot,
          testFiles: args.testFiles,
          framework: args.framework || 'vitest',
          timeout: args.timeout,
        },
        timeout: (args.timeout || 60000) + 5000, // worker 超时稍长于任务超时
      });
      return result;
    } else {
      return this.runDirectly(args);
    }
  }
}
```

#### 验证标准
- ✅ 分析、生成、测试执行都可以在 worker 中进行
- ✅ Worker 超时自动终止
- ✅ Worker 崩溃不影响主进程
- ✅ 支持 3 个 worker 并发
- ✅ 支持回退到直接执行（WORKER_ENABLED=false）

---

### M3: 测试用例修复（优先级 P1）

**目标**：修复失败的测试用例，而非修复源代码

#### 交付物

1. **agents/test-fix-agent.ts** - 测试用例修复 Agent
```typescript
export interface TestFixContext {
  failures: TestFailure[];      // 失败的测试
  testFiles: Map<string, string>; // 测试文件内容
  sourceFiles?: Map<string, string>; // 相关源文件（可选，用于理解预期行为）
  projectConfig: ProjectConfig;  // 项目配置
}

export interface TestFailure {
  testName: string;
  testFile: string;
  errorMessage: string;
  stackTrace: string;
  actualBehavior: string;        // 实际行为
  expectedBehavior?: string;     // 预期行为（从测试代码推断）
}

export interface TestFix {
  testFile: string;
  originalCode: string;
  fixedCode: string;
  reason: string;                // 修复原因
  confidence: number;            // 置信度 0-1
}

export class TestFixAgent extends BaseAgent<TestFix> {
  constructor(private llm: OpenAIClient) {
    super('test-fix-agent');
  }
  
  async execute(context: TestFixContext): Promise<AgentResult<TestFix>> {
    const fixes: TestFix[] = [];
    
    for (const failure of context.failures) {
      // 1. 分析失败原因
      const analysis = await this.analyzeFailure(failure, context);
      
      // 2. 生成修复方案
      const fix = await this.generateFix(failure, analysis, context);
      
      if (fix) {
        fixes.push(fix);
      }
    }
    
    return {
      items: fixes,
      summary: {
        totalFailures: context.failures.length,
        fixesGenerated: fixes.length,
        averageConfidence: fixes.reduce((sum, f) => sum + f.confidence, 0) / fixes.length,
      },
    };
  }
  
  private async analyzeFailure(
    failure: TestFailure,
    context: TestFixContext
  ): Promise<FailureAnalysis> {
    const testContent = context.testFiles.get(failure.testFile);
    
    const prompt = `# 测试失败分析

你是一个专业的测试工程师，负责分析失败的测试用例并找出原因。

## 失败的测试

**测试文件**: ${failure.testFile}
**测试名称**: ${failure.testName}
**错误信息**: ${failure.errorMessage}

**测试代码**:
\`\`\`typescript
${testContent}
\`\`\`

**堆栈跟踪**:
\`\`\`
${failure.stackTrace}
\`\`\`

## 任务

分析失败原因，可能的原因包括：
1. **Mock 不正确**：Mock 的数据或行为与实际不符
2. **断言过严**：期望值设置不合理（如精确匹配对象，但顺序可能不同）
3. **异步处理**：缺少 await 或 waitFor
4. **环境差异**：测试依赖特定环境（如 DOM API）
5. **边界条件**：测试场景不完整
6. **测试逻辑错误**：测试本身写错了

## 输出格式

\`\`\`json
{
  "reason": "断言过严：期望对象顺序完全匹配，但实际返回顺序可能不同",
  "category": "assertion",
  "suggestedFix": "使用 toContainEqual 或 toMatchObject 代替 toEqual",
  "confidence": 0.9
}
\`\`\`
`;
    
    const response = await this.llm.chatCompletion({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    });
    
    return JSON.parse(this.extractJSON(response.choices[0].message.content));
  }
  
  private async generateFix(
    failure: TestFailure,
    analysis: FailureAnalysis,
    context: TestFixContext
  ): Promise<TestFix | null> {
    const testContent = context.testFiles.get(failure.testFile);
    
    const prompt = `# 测试用例修复

基于失败分析，生成修复后的测试代码。

## 失败分析

${JSON.stringify(analysis, null, 2)}

## 原始测试代码

\`\`\`typescript
${testContent}
\`\`\`

## 要求

1. **只修复测试代码**，不修改源代码
2. **最小化修改**：只改动必要的部分
3. **保持测试意图**：不改变测试要验证的核心功能
4. **提高鲁棒性**：让测试更稳定

常见修复方法：
- Mock 不正确 → 调整 mock 数据/行为
- 断言过严 → 使用更灵活的匹配器（toContainEqual, toMatchObject）
- 异步处理 → 添加 await, waitFor
- 环境差异 → 添加 polyfill 或 skip
- 边界条件 → 添加额外的测试场景
- 测试逻辑错误 → 修正测试逻辑

## 输出格式

\`\`\`json
{
  "fixedCode": "... 完整的修复后代码 ...",
  "reason": "将 toEqual 改为 toContainEqual，允许数组元素顺序不同",
  "confidence": 0.9,
  "changes": [
    "第 15 行：expect(result).toEqual([...]) → expect(result).toContainEqual(...)"
  ]
}
\`\`\`
`;
    
    const response = await this.llm.chatCompletion({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    });
    
    const parsed = JSON.parse(this.extractJSON(response.choices[0].message.content));
    
    return {
      testFile: failure.testFile,
      originalCode: testContent || '',
      fixedCode: parsed.fixedCode,
      reason: parsed.reason,
      confidence: parsed.confidence,
    };
  }
}
```

2. **tools/fix-failing-tests.ts** - 修复失败测试的工具
```typescript
export interface FixFailingTestsArgs {
  workspaceId: string;
  testResults: TestRunResult;    // 包含失败信息的测试结果
  maxAttempts?: number;          // 最大修复尝试次数（默认 3）
}

export interface FixFailingTestsResult {
  success: boolean;
  fixes: TestFix[];
  retriedResults?: TestRunResult; // 修复后重新运行的结果
  attempts: number;
}

export class FixFailingTestsTool extends BaseTool {
  async executeImpl(args: FixFailingTestsArgs): Promise<FixFailingTestsResult> {
    const workspaceManager = getAppContext().workspaceManager;
    const workspace = workspaceManager.getWorkspace(args.workspaceId);
    
    let currentResults = args.testResults;
    let attempts = 0;
    const maxAttempts = args.maxAttempts || 3;
    const allFixes: TestFix[] = [];
    
    while (currentResults.summary.failed > 0 && attempts < maxAttempts) {
      attempts++;
      
      // 1. 提取失败的测试
      const failures = this.extractFailures(currentResults);
      
      // 2. 读取测试文件内容
      const testFiles = await this.readTestFiles(workspace.workDir, failures);
      
      // 3. 调用 TestFixAgent 生成修复
      const fixAgent = new TestFixAgent(getAppContext().openai);
      const fixResult = await fixAgent.execute({
        failures,
        testFiles,
        projectConfig: workspace.projectConfig,
      });
      
      if (fixResult.items.length === 0) {
        // 无法生成修复，停止
        break;
      }
      
      allFixes.push(...fixResult.items);
      
      // 4. 应用修复
      await this.applyFixes(workspace.workDir, fixResult.items);
      
      // 5. 重新运行测试
      const runTool = new RunTestsTool();
      currentResults = await runTool.execute({
        workspaceId: args.workspaceId,
        projectRoot: workspace.workDir,
        testFiles: failures.map(f => f.testFile),
      });
      
      // 如果全部通过，退出循环
      if (currentResults.summary.failed === 0) {
        break;
      }
    }
    
    return {
      success: currentResults.summary.failed === 0,
      fixes: allFixes,
      retriedResults: currentResults,
      attempts,
    };
  }
  
  private extractFailures(results: TestRunResult): TestFailure[] {
    // 从测试结果中提取失败信息
    // 解析 stdout/stderr，提取测试名称、错误信息、堆栈
    
    const failures: TestFailure[] = [];
    
    // Vitest 格式: "FAIL  src/components/Button.spec.ts"
    // Jest 格式: "FAIL  src/components/Button.test.ts"
    
    // ... 解析逻辑 ...
    
    return failures;
  }
  
  private async readTestFiles(
    workDir: string,
    failures: TestFailure[]
  ): Promise<Map<string, string>> {
    const testFiles = new Map<string, string>();
    
    for (const failure of failures) {
      const filePath = path.join(workDir, failure.testFile);
      const content = await fs.readFile(filePath, 'utf-8');
      testFiles.set(failure.testFile, content);
    }
    
    return testFiles;
  }
  
  private async applyFixes(workDir: string, fixes: TestFix[]): Promise<void> {
    for (const fix of fixes) {
      const filePath = path.join(workDir, fix.testFile);
      await fs.writeFile(filePath, fix.fixedCode, 'utf-8');
    }
  }
}
```

3. **Prompt 模板** - prompts/test-fix-agent.md
```markdown
# 测试用例修复指南

## 核心原则

1. **只修复测试代码，不修改源代码**
2. **最小化修改**：只改动必要的部分
3. **保持测试意图**：不改变测试要验证的核心功能
4. **提高鲁棒性**：让测试更稳定、更可靠

## 常见失败场景与修复方法

### 1. Mock 不正确

**问题**：Mock 的数据或行为与实际不符

**修复**：
- 调整 mock 返回值的结构
- 修正 mock 函数的行为
- 添加缺失的 mock

**示例**：
```typescript
// 修复前
vi.mock('./api', () => ({
  fetchUser: vi.fn().mockResolvedValue({ name: 'test' })
}))

// 修复后（补充缺失字段）
vi.mock('./api', () => ({
  fetchUser: vi.fn().mockResolvedValue({ 
    id: 1, 
    name: 'test', 
    email: 'test@example.com' 
  })
}))
```

### 2. 断言过严

**问题**：期望值设置不合理（如精确匹配对象，但顺序可能不同）

**修复**：
- `toEqual` → `toMatchObject`（部分匹配）
- `toEqual([...])` → `toContainEqual(...)`（数组包含）
- `toBe` → `toBeCloseTo`（浮点数）

**示例**：
```typescript
// 修复前
expect(result).toEqual([{ id: 1 }, { id: 2 }])

// 修复后（允许顺序不同）
expect(result).toContainEqual({ id: 1 })
expect(result).toContainEqual({ id: 2 })
```

### 3. 异步处理

**问题**：缺少 await 或 waitFor

**修复**：
- 添加 await
- 使用 waitFor 等待异步更新
- 使用 findBy* 替代 getBy*

**示例**：
```typescript
// 修复前
it('should display user', () => {
  render(<UserProfile userId={1} />)
  expect(screen.getByText('John')).toBeInTheDocument()
})

// 修复后
it('should display user', async () => {
  render(<UserProfile userId={1} />)
  expect(await screen.findByText('John')).toBeInTheDocument()
})
```

### 4. 环境差异

**问题**：测试依赖特定环境（如 DOM API、window 对象）

**修复**：
- 添加环境检查
- 使用 polyfill
- 在不支持的环境中 skip

**示例**：
```typescript
// 修复前
it('should copy to clipboard', () => {
  navigator.clipboard.writeText('test')
  // ...
})

// 修复后
it('should copy to clipboard', () => {
  if (!navigator.clipboard) {
    // Mock clipboard API
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined)
      }
    })
  }
  navigator.clipboard.writeText('test')
  // ...
})
```

### 5. 边界条件

**问题**：测试场景不完整

**修复**：
- 添加边界值测试
- 添加空值/null/undefined 测试
- 添加错误场景测试

### 6. 测试逻辑错误

**问题**：测试本身写错了

**修复**：
- 修正测试步骤
- 修正期望值
- 修正测试数据

## 输出格式

```json
{
  "fixedCode": "... 完整的修复后代码 ...",
  "reason": "修复原因",
  "confidence": 0.9,
  "changes": ["具体改动列表"]
}
```
```

#### 验证标准
- ✅ 可以分析失败的测试用例
- ✅ 可以生成修复后的测试代码
- ✅ 修复后重新运行测试
- ✅ 支持多轮修复（最多 3 次）
- ✅ 置信度评估准确

---

### M4: n8n 集成增强（优先级 P1）

**目标**：优化 n8n agent 节点调用体验

#### n8n 工作流示例

```
┌─────────────────────────────────────────────────────────────┐
│                   n8n Workflow: Test Generation             │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  1. Trigger: GitLab Webhook (MR created/updated)            │
│      ↓                                                        │
│  2. Extract: repoUrl, branch, baselineBranch                │
│      ↓                                                        │
│  3. MCP Agent: fetch-diff-from-repo                         │
│      Input: { repoUrl, branch, baselineBranch }             │
│      Output: { workspaceId, diff, projectConfig }           │
│      ↓                                                        │
│  4. MCP Agent: analyze-test-matrix-worker                   │
│      Input: { workspaceId, diff, projectConfig }            │
│      Output: { matrix }                                      │
│      ↓                                                        │
│  5. MCP Agent: generate-tests-worker                        │
│      Input: { workspaceId, matrix, scenarios }              │
│      Output: { tests }                                       │
│      ↓                                                        │
│  6. MCP Agent: write-test-file                              │
│      Input: { workspaceId, tests }                          │
│      Output: { filesWritten }                               │
│      ↓                                                        │
│  7. MCP Agent: run-tests                                    │
│      Input: { workspaceId, testFiles }                      │
│      Output: { testResults }                                │
│      ↓                                                        │
│  8. If (testResults.failed > 0):                            │
│      MCP Agent: fix-failing-tests                           │
│      Input: { workspaceId, testResults, maxAttempts: 3 }    │
│      Output: { fixes, retriedResults }                      │
│      ↓                                                        │
│  9. Notification: Send results to Slack/Email               │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

#### 简化版（一键式）

```typescript
// tools/test-generation-workflow.ts
export interface TestGenerationWorkflowArgs {
  repoUrl: string;
  branch: string;
  baselineBranch?: string;
  scenarios?: string[];
  autoFix?: boolean;         // 是否自动修复失败的测试
  maxFixAttempts?: number;
}

export class TestGenerationWorkflowTool extends BaseTool {
  async executeImpl(args: TestGenerationWorkflowArgs): Promise<{
    workspaceId: string;
    projectConfig: ProjectConfig;
    matrix: TestMatrix;
    tests: TestCase[];
    filesWritten: string[];
    testResults: TestRunResult;
    fixes?: TestFix[];
  }> {
    // 一键式流程，内部调用所有步骤
    
    // 1. 获取 diff
    const fetchTool = new FetchDiffFromRepoTool();
    const fetchResult = await fetchTool.execute({ ... });
    
    // 2. 分析矩阵
    const analyzeTool = new AnalyzeTestMatrixWorkerTool();
    const matrix = await analyzeTool.execute({ ... });
    
    // 3. 生成测试
    const generateTool = new GenerateTestsWorkerTool();
    const tests = await generateTool.execute({ ... });
    
    // 4. 写入文件
    const writeTool = new WriteTestFileTool();
    const writeResult = await writeTool.execute({ ... });
    
    // 5. 运行测试
    const runTool = new RunTestsTool();
    const testResults = await runTool.execute({ ... });
    
    // 6. (可选) 修复失败的测试
    let fixes;
    if (args.autoFix && testResults.summary.failed > 0) {
      const fixTool = new FixFailingTestsTool();
      const fixResult = await fixTool.execute({ ... });
      fixes = fixResult.fixes;
    }
    
    return { ... };
  }
}
```

#### 验证标准
- ✅ 可以在 n8n 中逐步调用各个工具
- ✅ 提供一键式工具简化流程
- ✅ 每个步骤返回 workspaceId，便于串联
- ✅ 支持自动修复选项

---

### M5: 配置文件增强（优先级 P2）

**目标**：补充 `.cursor/rule/fe-mcp.md` 推荐配置

#### 推荐配置模板

创建 `docs/cursor-rule-template.md` 作为项目配置模板：

```markdown
# FE MCP 测试生成配置

> 本文件用于配置 fe-testgen-mcp 的测试生成行为
> 
> **路径**: `.cursor/rule/fe-mcp.md`
> 
> **优先级**: 项目级配置 > 全局配置

## 项目信息

- **项目名称**: [Your Project Name]
- **项目类型**: [React / Vue / Angular / Pure TypeScript]
- **测试框架**: [Vitest / Jest]
- **是否 Monorepo**: [是 / 否]

## 测试配置

### 测试框架

```yaml
testFramework: vitest
testPattern: "**/*.{test,spec}.{ts,tsx}"
testDirectory: "__tests__"
```

### 测试风格

```yaml
# 测试描述语言
descriptionLanguage: zh-CN  # zh-CN / en-US

# 测试场景优先级
scenarioPriority:
  - happy-path
  - edge-case
  - error-path
  - state-change

# 最大生成测试数
maxTestsPerFile: 10
```

## 代码规范

### React 组件

- 必须使用函数式组件 + Hooks
- 所有组件需要 TypeScript 类型定义
- Props 使用 interface 定义

### 测试规范

```typescript
// ✅ 推荐
describe('Button', () => {
  it('should render correctly', () => {
    // ...
  })
  
  it('should handle click event', async () => {
    // ...
  })
})

// ❌ 避免
test('button', () => {
  // 测试描述不清晰
})
```

### Mock 规范

```typescript
// ✅ 推荐：使用 vi.mock
vi.mock('./api', () => ({
  fetchUser: vi.fn().mockResolvedValue({ id: 1, name: 'test' })
}))

// ❌ 避免：使用 jest.mock（如果使用 Vitest）
jest.mock('./api', ...)
```

### 断言规范

```typescript
// ✅ 推荐：使用语义化的匹配器
expect(user).toMatchObject({ name: 'test' })
expect(items).toContainEqual({ id: 1 })
expect(count).toBeGreaterThan(0)

// ❌ 避免：过于严格的匹配
expect(user).toEqual({ id: 1, name: 'test', createdAt: expect.any(Date) })
```

## Monorepo 配置

如果是 Monorepo 项目，请在子项目中创建独立配置：

```
monorepo-root/
├── .cursor/rule/fe-mcp.md      # 全局配置
├── packages/
│   ├── ui-components/
│   │   └── .cursor/rule/fe-mcp.md  # UI 组件库配置
│   └── business-logic/
│       └── .cursor/rule/fe-mcp.md  # 业务逻辑配置
```

## 排除规则

不生成测试的文件/目录：

```yaml
exclude:
  - "**/*.d.ts"
  - "**/*.stories.tsx"
  - "**/node_modules/**"
  - "**/dist/**"
  - "**/.next/**"
  - "**/coverage/**"
```

## 已有测试处理

- **策略**: 增量生成（只为没有测试的文件生成）
- **覆盖**: 不覆盖已有测试文件
- **合并**: 如果文件有部分测试，生成补充测试

## 自定义 Prompt

### 生成测试前

```
在生成测试前，请确保：
1. 理解组件的业务逻辑和用户交互
2. 识别关键的状态变化和副作用
3. 考虑边界条件和错误场景
```

### 生成测试时

```
生成测试时，请遵循：
1. 测试描述清晰，使用中文
2. 每个测试只验证一个功能点
3. 使用 async/await 处理异步操作
4. Mock 外部依赖（API、localStorage 等）
```

### 生成测试后

```
生成测试后，请检查：
1. 所有测试都有清晰的描述
2. 所有断言都有意义
3. 没有重复的测试场景
4. 测试覆盖了主要功能
```

## 项目特定规则

### 状态管理

我们使用 Zustand 进行全局状态管理：

```typescript
// 测试 Zustand store
import { renderHook, act } from '@testing-library/react'
import { useStore } from './store'

it('should update state', () => {
  const { result } = renderHook(() => useStore())
  
  act(() => {
    result.current.increment()
  })
  
  expect(result.current.count).toBe(1)
})
```

### API 请求

我们使用 Axios 进行 API 请求：

```typescript
// Mock Axios
vi.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

it('should fetch data', async () => {
  mockedAxios.get.mockResolvedValue({ data: { ... } })
  // ...
})
```

### 路由

我们使用 React Router v6：

```typescript
// 测试路由
import { MemoryRouter } from 'react-router-dom'

it('should navigate to detail page', () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <App />
    </MemoryRouter>
  )
  // ...
})
```

## 参考示例

查看 `src/__tests__/example.test.ts` 了解推荐的测试风格。

---

**更新时间**: 2024-11-15
**版本**: 1.0
```

#### 自动生成配置工具

```typescript
// tools/generate-cursor-rule.ts
export interface GenerateCursorRuleArgs {
  workspaceId: string;
  outputPath?: string;  // 默认 .cursor/rule/fe-mcp.md
}

export class GenerateCursorRuleTool extends BaseTool {
  async executeImpl(args: GenerateCursorRuleArgs): Promise<{
    filePath: string;
    content: string;
  }> {
    const workspaceManager = getAppContext().workspaceManager;
    const projectDetector = getAppContext().projectDetector;
    
    const workspace = workspaceManager.getWorkspace(args.workspaceId);
    const projectConfig = await projectDetector.detectProject(workspace.workDir);
    
    // 基于项目配置生成推荐的 cursor rule
    const template = await this.loadTemplate();
    const content = this.fillTemplate(template, projectConfig);
    
    // 写入文件
    const outputPath = args.outputPath || '.cursor/rule/fe-mcp.md';
    const fullPath = path.join(workspace.workDir, outputPath);
    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, content, 'utf-8');
    
    return {
      filePath: outputPath,
      content,
    };
  }
  
  private fillTemplate(template: string, config: ProjectConfig): string {
    // 替换模板中的占位符
    return template
      .replace('[Your Project Name]', path.basename(config.projectRoot))
      .replace('[Vitest / Jest]', config.testFramework || 'vitest')
      .replace('[是 / 否]', config.isMonorepo ? '是' : '否')
      // ... 其他替换
  }
}
```

#### 验证标准
- ✅ 提供完整的配置模板
- ✅ 可以自动生成项目配置
- ✅ 配置文件包含所有推荐规则
- ✅ 支持 Monorepo 子项目配置

---

## 🔄 实施策略

### 开发顺序

```
M1 (多项目工作区) → M2 (Worker 隔离) → M3 (测试修复) → M4 (n8n 增强) → M5 (配置)
    ↓                    ↓                  ↓                ↓                ↓
  可用于基础         可用于高并发       可用于自动化     可用于生产      完全就绪
  场景测试           场景测试           测试修复         集成           
```

### 兼容性保证

1. **现有工具不受影响**：
   - 所有已有工具保持不变
   - 新增工具作为独立模块

2. **渐进式启用**：
   - Worker 默认启用（`WORKER_ENABLED=true`）
   - 如果 worker 失败，自动回退到直接执行
   - 可以通过环境变量禁用 worker

3. **n8n 兼容性**：
   - 每个工具可以独立调用
   - 也提供一键式工具简化流程
   - workspaceId 贯穿整个流程

### 里程碑检查点

| 里程碑 | 新增代码 | 修改代码 | 预估工时 | 优先级 |
|--------|---------|---------|---------|--------|
| M1: 多项目工作区 | ~1200 行 | 0 | 3-4 天 | P0 |
| M2: Worker 隔离 | ~800 行 | ~100 行 | 3-4 天 | P0 |
| M3: 测试修复 | ~600 行 | 0 | 2-3 天 | P1 |
| M4: n8n 增强 | ~400 行 | 0 | 1-2 天 | P1 |
| M5: 配置增强 | ~300 行 | 0 | 1-2 天 | P2 |
| 文档 + 测试 | ~500 行 | 0 | 2-3 天 | P1 |
| **总计** | **~3800 行** | **~100 行** | **12-18 天** | - |

---

## 📝 使用示例

### 场景 1：n8n 逐步调用

```javascript
// 1. 获取 diff
const step1 = await mcpAgent.call('fetch-diff-from-repo', {
  repoUrl: 'https://github.com/org/repo.git',
  branch: 'feature/new-feature',
  baselineBranch: 'main'
})
// 返回: { workspaceId, diff, projectConfig, changedFiles }

// 2. 分析矩阵
const step2 = await mcpAgent.call('analyze-test-matrix-worker', {
  workspaceId: step1.workspaceId,
  diff: step1.diff,
  projectConfig: step1.projectConfig
})
// 返回: { matrix }

// 3. 生成测试
const step3 = await mcpAgent.call('generate-tests-worker', {
  workspaceId: step1.workspaceId,
  matrix: step2.matrix,
  scenarios: ['happy-path', 'edge-case']
})
// 返回: { tests }

// 4. 写入测试文件
const step4 = await mcpAgent.call('write-test-file', {
  workspaceId: step1.workspaceId,
  tests: step3.tests
})
// 返回: { filesWritten }

// 5. 运行测试
const step5 = await mcpAgent.call('run-tests', {
  workspaceId: step1.workspaceId,
  testFiles: step4.filesWritten
})
// 返回: { testResults }

// 6. (如果有失败) 修复测试
if (step5.testResults.summary.failed > 0) {
  const step6 = await mcpAgent.call('fix-failing-tests', {
    workspaceId: step1.workspaceId,
    testResults: step5.testResults,
    maxAttempts: 3
  })
  // 返回: { fixes, retriedResults }
}
```

### 场景 2：n8n 一键调用

```javascript
// 一键式流程
const result = await mcpAgent.call('test-generation-workflow', {
  repoUrl: 'https://github.com/org/repo.git',
  branch: 'feature/new-feature',
  baselineBranch: 'main',
  scenarios: ['happy-path', 'edge-case', 'error-path'],
  autoFix: true,
  maxFixAttempts: 3
})

// 返回完整结果
// {
//   workspaceId,
//   projectConfig,
//   matrix,
//   tests,
//   filesWritten,
//   testResults,
//   fixes
// }
```

### 场景 3：直接使用（不通过 n8n）

```bash
# 启动 MCP 服务器
npm start

# 通过 MCP 客户端调用
fetch-diff-from-repo {
  "repoUrl": "/path/to/local/repo",
  "branch": "feature/new-feature"
}

# 后续步骤...
```

---

## ✅ 成功标准

### 功能完整性
- ✅ 支持多个 Git 项目并发处理
- ✅ 支持 Monorepo 自动检测和子项目识别
- ✅ 支持测试用例修复（而非源代码修复）
- ✅ 支持 worker 隔离（分析、生成、测试）
- ✅ 适合在 n8n agent 节点中调用

### 性能指标
- ✅ Worker 隔离不阻塞主线程
- ✅ 支持 3 个 worker 并发
- ✅ 工作区创建 < 30s
- ✅ 测试修复成功率 > 60%

### 可用性
- ✅ 文档完整，有 n8n 集成示例
- ✅ 支持逐步调用和一键式调用
- ✅ 配置文件模板完整
- ✅ 错误信息清晰

### 可维护性
- ✅ 代码模块化，职责清晰
- ✅ 核心模块有单元测试
- ✅ 配置灵活，支持不同环境

---

## 📚 参考资料

- 原始设计文档：`commit-branch-test-repair.md`
- 当前项目状态：`.project-status`
- FastMCP 文档：https://github.com/jlowin/fastmcp

---

## 📅 更新日志

- **2024-11-15**: 初始版本，基于用户反馈重新调整
  - 明确修复是指修复测试用例，不是源代码
  - 扩展 worker 机制到分析/生成/测试
  - 强化 n8n 集成设计
  - 增强 Monorepo 支持
  - 补充配置文件推荐
