# 基于 commit/branch 的测试驱动修复方案

## Worker + 多 Agent 协同的价值分析

| 场景 | 使用 worker 的收益 | 不使用 worker 的代价 |
| --- | --- | --- |
| **高延迟的 AI/测试执行** | 将 Q CLI、LLM 评价、测试运行等 CPU/IO 密集任务放在 worker 线程，可避免阻塞主事件循环，保持 FastMCP SSE 长连接稳定。 | 主线程被 `execSync`/长测占满，MCP 心跳和任务管理失去响应，导致工具在宿主 Agent 中被判定为超时。 |
| **多 Agent 并发任务** | worker 之间相互独立，配合 `MAX_CONCURRENT_TASKS`、任务队列就能安全并行多个 commit/branch 流，便于未来扩展“分析 Agent”“修复 Agent”“测试 Agent” 等角色。 | 主进程难以隔离任务上下文；一旦某个任务意外退出（如测试脚本 `process.exit(1)`），整个 MCP 进程会被带崩。 |
| **沙箱与资源控制** | worker 可在独立 `workDir` + 自定义 `env` 中运行测试，结合 `worker.terminate()`、超时和日志转发，便于对恶意脚本做限流与隔离。 | 所有脚本共享同一个 PID 与环境变量，`node_modules/.bin` 的 side effect（如全局安装）会影响后续任务。 |
| **可观测性** | worker 可以结构化推送 `progress`、`success`、`error` 消息，方便其他 Agent 订阅状态变化，构建“多 Agent 状态机”。 | 只能依赖主进程串行日志，难以对接外部编排器。 |

> 结论：在多 Agent 协作、测试驱动修复场景下继续沿用 worker 架构是有必要的，但建议抽象成通用 `TaskWorkerPool`，支持“LLM 补丁”“测试执行”“格式化”等不同任务类型。

---

## 方案概览

> 应用场景：开发日常以 `feature/xxx` 分支开发，完成后通过 Merge Request 或自动合并进入 `master`。我们希望在“feature 分支准备合并/已合并到 master”这一刻触发自动化，对 `feature/xxx` 相对于 `master` 的增量进行分析、测试补齐与修复。

1. **输入**：`gitlab_project_id` + `feature_branch`（如 `feature/payments-v2`）+（可选）`baseline_branch`（默认 `master`）及外部追踪字段（`sentry_issue_id` / `revisionId`）。
2. **核心阶段**：
   - 代码同步：拉取 `baseline_branch` 与 `feature_branch`，在 feature 分支上创建 `ai-verify/<feature>/<ts>` 工作分支。
   - 变更分析：调用 相应 tool生成功能清单 & 测试矩阵。
   - 测试用例生成：根据功能清单 & 测试矩阵生成测试文件。
   - 测试执行：worker 级别串行/并行跑测试，收集失败日志。
   - 智能修复：调用 相应 tool对失败场景进行定点修改。
   - 回归验证：重新执行受影响测试，直至绿色或超时。
   - GitOps：`commit → push → MR`，附带测试结果摘要。
3. **输出**：任务状态、测试日志、MR 链接、生成 case 数。

---

## 体系结构

### 1. 角色与 Agent

| Agent | 责任 | 主要接口 |
| --- | --- | --- |
| **Orchestrator Agent**（主 MCP） | 维护任务状态机，协调 worker，暴露工具给上层（如 Copilot、n8n）。 | `gitlab_test_repair_start`,`gitlab_task_status` |
| **Analysis Agent** | 负责 测试矩阵/测试生成，可直接调用现有 `testgen-mcp`。 | `fetch-diff`,`analyze-test-matrix`,`generate-tests` |
| **Fix Agent** | 与 Amazon Q、Claude 或内部模型交互，基于失败日志生成补丁。 | `q-cli-worker`（扩展为通用 worker） |
| **Test Agent** | 在隔离 worker 中安装依赖并运行测试，返回结构化结果。 | 新 worker `test-runner-worker.ts` |

### 2. 模块划分（建议）

```
src/
  orchestrator/
    task-manager.ts       # 任务状态、并发控制、事件广播
    workspace-manager.ts  # /tmp 目录生命周期、Git 操作封装
  agents/
    analysis-agent.ts     # 封装 testgen-mcp 的 HTTP/MCP 调用
    fix-agent.ts          # 组装 prompt、调用 Q CLI
    test-agent.ts         # 启/停测试 worker、解析日志
  workers/
    q-cli-worker.ts       # 现有
    test-runner-worker.ts # 新增，负责依赖安装 & test
docs/
  commit-branch-test-repair.md
```

---

## 详细流程（按阶段）

### 阶段 A：任务初始化
1. 触发方式：监听 `feature/xxx → master` 的 MR 创建/更新或 CI 合并事件，传入 `gitlab_project_id` 与 `feature_branch`。
2. 校验输入（GitLab Token、`feature_branch`、测试配置），并允许覆盖 `baseline_branch`（默认 `master`）。
3. 在 `taskStatus` 中写入 `pending`，返回 `taskId`。
4. `workspace-manager`：
   - 创建 `workDir=/tmp/gitlab-task/<taskId>`.
   - `git clone --filter=blob:none <repo>`，`git fetch origin <baseline_branch>` 与 `git fetch origin <feature_branch>`。
   - `git checkout origin/<feature_branch>`，创建 `branchName=ai-verify/<feature_branch>/<timestamp>`。
   - 记录 `baseline_branch`（默认为 `master`）及远端默认分支，供 MR/回写使用。

### 阶段 B：变更分析 & 测试矩阵
1. `analysis-agent` 读取 `git diff origin/<baseline_branch>...<branchName>`（三点差异，确保包含 merge-base 以来的所有 commit），或调用 `testgen-mcp`：
   - 输入 `revisionId`（可选）或直接喂 `diff` 内容。
   - 输出：文件列表、risk 区域、推荐测试矩阵及 `projectRoot`。
2. 将矩阵写入 `stateManager`（沿用 testgen-mcp 的缓存结构），供生成/执行阶段复用。

### 阶段 C：测试用例生成
1. 若矩阵中包含“需要新增测试”，调用 `generate-tests`：
   - 以 `projectRoot` 为起点写入 `.spec.ts` 等文件。
   - 生成记录：文件路径 + 生成方式（自动/已有）。
2. `fix-agent` 可在此阶段先运行一次 formatter/lint，确保新增测试符合规范。

### 阶段 D：依赖安装
1. `test-agent` 启动 `test-runner-worker`，执行：
   - 缓存键：`<repo>@<package-lock hash>`，首次需要 `pnpm install/npm ci`。
   - 允许通过 `TASK_TEST_INSTALL_TIMEOUT` 配置超时时间。
2. 安装成功后更新任务进度为 “deps-ready”。

### 阶段 E：测试执行 & 反馈循环
1. 根据测试矩阵生成执行队列，例如：
   - `vitest run fileA.spec.ts`
   - `pnpm test -- filterB`
2. worker 逐条执行，输出结构化结果：

```jsonc
{
  "test": "vitest fileA.spec.ts",
  "status": "failed",
  "stdout": "...",
  "stderr": "...",
  "durationMs": 12345
}
```

3. `fix-agent` 将失败结果写入 prompt，调用 Q CLI 生成补丁（仍复用 `q-cli-worker`）。
4. 若生成补丁造成新的 `git status` 变动，则再次运行对应测试，直至：
   - 所有测试 `passed`，或
   - 达到 `MAX_FIX_ATTEMPTS` / `TASK_TIMEOUT`。

### 阶段 F：GitOps 输出
1. `git status` 检查是否有变更；若无则任务以 “no-change” 结束。
2. `git commit -m "[feature_branch] test-driven verification against <baseline_branch>"`，信息包含：
   - 失败原因概要
   - 新增/修改的测试列表
   - 最终测试摘要
3. `git push origin <branchName>`；失败时自动 `git fetch --depth=100` 再重试。
4. 创建 MR：
   - `target_branch = default_branch`
   - 描述模板包含：问题链接、测试矩阵、通过/失败测试列表、AI agent 日志链接。
5. 可选：调用 Sentry/Phabricator API 添加评论或自动 resolve。

---

## 数据结构与配置

```ts
interface TestTaskConfig {
  gitlabProjectId: string;
  featureBranch: string;         // 需要分析/测试的源分支
  baselineBranch?: string;       // 默认为 master
  revisionId?: string;           // 可选：供 testgen-mcp 或外部系统使用
  sentryIssueId?: string;
  testRunner: 'pnpm' | 'npm' | 'yarn';
  testCommand: string;           // 默认 `pnpm test`
  maxFixAttempts: number;
  timeoutMs: number;
}

interface TestRunResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'timeout';
  logs: string;
  durationMs: number;
  relatedFiles: string[];
}
```

配置优先级：环境变量（如 `TEST_AGENT_INSTALL_TIMEOUT`）> 任务输入 > 默认值。

---

## 实现步骤（建议按里程碑推进）

1. **项目结构调整**
   - 新建 `docs/`（当前文档）。
   - 在 `src/` 下创建 `orchestrator/`、`agents/`、`workers/` 子目录。

2. **Task Manager 抽象**
   - 从 `server-gitlab.ts` 中拆出任务状态 Map、并发/超时控制，统一放到 `orchestrator/task-manager.ts`。
   - 支持任务事件（`progress`, `log`, `result`）供其他 Agent 订阅。

3. **Workspace Manager**
   - 把 clone、fetch、checkout、branch、清理等逻辑集中到 `workspace-manager.ts`。
   - 替换 `timeout rm -rf` 为 `fs.rm` + 轮询，兼容 macOS。
   - 拉取 `default_branch` 并缓存。

4. **Analysis Agent 对接 testgen-mcp**
   - 增加一个 HTTP/MCP client，封装 `fetch-diff`/`analyze-test-matrix`/`generate-tests` 的调用。
   - 处理缓存/状态文件（`stateManager`）落地在工作目录。

5. **Test Runner Worker**
   - 参考 `q-cli-worker.ts`，新增 `test-runner-worker.ts`：
     - 支持 `install`, `run`, `collect` 三种 message type。
     - 允许在单个 worker 中串行多个测试命令，避免频繁 spawn。
   - 主进程提供 `runTests(commands: string[], env)` API。

6. **Fix Agent 扩展**
   - 增加 prompt 模板：`测试失败日志 + 相关文件 + 预期行为`。
   - 支持多轮（参考失败测试列表），必要时生成补丁提示（`diff --git`）。

7. **状态持久化与重试**
   - 在 `taskStatus.result` 中增加：
     - `testRuns: TestRunResult[]`
     - `fixAttempts: {testName, status, summary}[]`
   - 失败时可恢复任务：读取 `workspace-manager` 缓存继续执行。

8. **GitOps & 报告**
   - 将测试摘要写入 commit/MR 描述。
   - 若配置了 Sentry：`PUT issues/<id>/` + comment（链接到 MR）。

9. **安全 & 配额**
   - worker 层限制 `process.env`，仅注入必要 token。
   - 可选：在 `workDir` 挂载 seccomp/apparmor（若运行在容器中）。

10. **文档 & 示例**
    - 在 `README.md` 中新增快速开始。
    - 提供示例命令：`gitlab_test_repair_start` 输入 JSON。

---

## 参考实现里程碑

| 里程碑 | 目标 | 交付物 |
| --- | --- | --- |
| M1 | 拆分 orchestrator & workspace manager，并支持 `feature_branch` + `baseline_branch` 的同步。 | 代码结构重构 + 单元测试 |
| M2 | 接入 testgen-mcp，能生成测试矩阵与用例。 | `analysis-agent.ts` + e2e-demo |
| M3 | Test runner worker + 多轮修复循环。 | `test-runner-worker.ts`、日志格式 |
| M4 | GitOps 自动化 + MR 输出测试摘要。 | MR 模板 + CLI 演示 |
| M5 | 安全加固与配置化（超时、并发、缓存）。 | 文档 + 配置示例 |

---

## 对其他 Agent 的指引

1. **输入上下文**：使用 `gitlab_test_repair_start` 时需提供 `gitlab_project_id`、`feature_branch`（可选 `baseline_branch`，默认 `master`）、`testCommand` 等字段；若要结合 Sentry/Phabricator，可额外传 `issue_id` 或 `revisionId`。
2. **状态查询**：轮询 `gitlab_task_status(task_id)`，可根据 `progress` 字段判断当前阶段（`workspace-ready`、`analysis`, `tests-running`, `fixing`, `gitops`）。
3. **调试**：开启 `DEBUG_TEST_AGENT=1` 后，worker 会把测试命令与 stdout/stderr 写入 `workDir/.mcp-logs/<taskId>.log`，方便其他 Agent 做 further reasoning。
4. **扩展 Hooks**：Orchestrator 预留 `onPhaseStart/End` 回调，外部 Agent 可以在测试前注入 mock 数据、在 MR 后自动通知 QA。

> 本文档可作为任务交接基线。实现者按照“实现步骤”逐项完成并在 PR 中引用对应里程碑即可。


