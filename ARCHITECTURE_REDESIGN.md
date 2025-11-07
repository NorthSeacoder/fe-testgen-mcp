# MCP 架构重新设计方案

## 1. 产品愿景

将当前的 stdio-based MCP 改造成一个服务端智能体系统，支持：

### 场景 A: diff 审查流程
```
Phabricator Diff 创建 → Webhook 通知 → MCP 获取 Diff → 代码审查 → 发布评论
```

### 场景 B: 测试生成流程
```
代码 Merge → Webhook 通知 → MCP 获取 Commit → 分析测试矩阵 → 生成测试用例 → 写入文件 → 执行测试 → 全部通过 → 创建 MR
```

## 2. 架构分层 (ReAct 模式)

### 2.1 传输层 (Transport Layer)
- **Current**: stdio (StdioServerTransport)
- **Target**: HTTP + SSE (Server-Sent Events)
- **实现方案**:
  - 保留 stdio 模式用于本地开发
  - 新增 HTTP Server 模式用于生产环境
  - 支持 Webhook 接收 Phabricator 事件

### 2.2 工具层 (Tool Layer) - 原子化、可组合

#### 代码获取工具
- ✅ `fetch-diff-from-phabricator`: 从 Phabricator 获取 diff
- 🆕 `fetch-commit-changes`: 从 git commit 获取变更
- 🆕 `fetch-file-content`: 获取指定文件内容

#### 代码分析工具  
- ✅ `analyze-code-quality`: 分析代码质量（当前的 review-frontend-diff）
- ✅ `analyze-test-matrix`: 分析测试矩阵
- ✅ `detect-test-framework`: 检测测试框架
- 🆕 `analyze-feature-list`: 从 commit 分析功能清单

#### 生成工具
- ✅ `generate-test-cases`: 生成测试用例代码
- 🆕 `generate-review-comments`: 独立的评论生成（从 review 中分离）

#### 文件操作工具
- 🆕 `write-test-file`: 写入测试文件
- 🆕 `read-source-file`: 读取源文件
- ✅ `resolve-path`: 路径解析

#### 执行工具
- 🆕 `run-tests`: 执行测试
- 🆕 `run-command`: 执行任意 shell 命令

#### 发布工具
- ✅ `publish-comments`: 发布评论到 Phabricator
- 🆕 `create-merge-request`: 创建 MR/PR

### 2.3 智能体层 (Agent Layer)

每个智能体都遵循 ReAct 模式：
```
while not done:
  thought = agent.think(observation)
  action = agent.decide_action(thought)
  observation = execute_tool(action)
```

#### 审查智能体 (ReviewAgent)
- 职责: 端到端的代码审查流程
- 工作流: fetch-diff → analyze → generate-comments → publish

#### 测试智能体 (TestAgent)  
- 职责: 端到端的测试生成流程
- 工作流: fetch-diff/commit → analyze-matrix → generate-tests → write-files

#### 执行智能体 (ExecutionAgent)
- 职责: 测试执行和质量门控
- 工作流: run-tests → check-results → report/retry

#### 集成智能体 (IntegrationAgent)
- 职责: 代码集成流程
- 工作流: run-tests → check-quality → create-mr → notify

### 2.4 编排层 (Orchestration Layer)

- **Workflow**: 定义多智能体协作流程
- **EventHandler**: 处理 webhook 事件，触发对应工作流
- **StateManager**: 管理全局状态和工作流状态

## 3. 关键问题修复

### 3.1 评论行数错乱问题

**根本原因**: 
- AI 从带行号的 diff 中提取行号时，可能混淆了旧行号和新行号
- diff-parser 的 `generateNumberedDiff` 格式：`-旧行号 +新行号: 代码内容`
- AI 有时会返回旧行号（`-` 后面的），而不是新行号（`+` 后面的）

**解决方案**:
1. ✅ 已有的 `findNewLineNumber` 函数可以验证行号
2. ✅ review-diff.ts 已经在使用 `findNewLineNumber` 过滤
3. 🔧 需要改进: 在 AI prompt 中更强调使用新行号
4. 🔧 需要改进: 在生成带行号 diff 时，优化格式，使其更清晰

**优化后的 diff 格式**:
```
File: src/Button.tsx
@@ -10,5 +12,6 @@

NEW_LINE_12:  const Button = () => {
NEW_LINE_13: +  const [state, setState] = useState(null);  // 新增行
NEW_LINE_14:    return <button>Click</button>;
NEW_LINE_15:  };
DELETED (was line 14): -  const old = 1;  // 已删除，不在新文件中
```

### 3.2 测试生成流程缺失

**当前问题**:
- `generate-tests` 只生成代码字符串，不写入文件
- 缺少从 commit 获取变更的能力
- 缺少测试执行工具

**解决方案**:
1. 🆕 新增 `write-test-file` 工具
2. 🆕 新增 `fetch-commit-changes` 工具
3. 🆕 新增 `run-tests` 工具
4. 重构 TestAgent 使用这些工具组合成完整流程

### 3.3 支持 commit-based 分析

**需求**: 测试矩阵既要能从 diff 获取，也要能从 commit 获取

**解决方案**:
1. 抽象 `CodeChangeSource` 接口
2. 实现两种 source:
   - `DiffChangeSource`: 从 Phabricator Diff
   - `CommitChangeSource`: 从 git commit
3. analyze-test-matrix 支持两种 source

## 4. 实施计划

### Phase 1: 修复行数问题 (当前优先级: 最高)
- [ ] 优化 diff 格式生成，使行号更清晰
- [ ] 加强 AI prompt 中关于行号的说明
- [ ] 添加行号验证和纠正逻辑
- [ ] 测试验证

### Phase 2: 完善工具层
- [ ] 新增 `write-test-file` 工具
- [ ] 新增 `fetch-commit-changes` 工具
- [ ] 新增 `run-tests` 工具
- [ ] 新增 `run-command` 工具
- [ ] 新增 `create-merge-request` 工具

### Phase 3: 重构 Test Agent
- [ ] 实现 CodeChangeSource 抽象
- [ ] 重构 TestAgent 使用新工具
- [ ] 实现完整的测试生成→写入→执行流程

### Phase 4: HTTP/SSE Transport (可选)
- [ ] 实现 HTTP Server
- [ ] 实现 SSE transport
- [ ] 实现 Webhook handler
- [ ] 配置和部署

## 5. ReAct 模式设计示例

### 示例: TestAgent 的 ReAct 循环

```typescript
class TestAgent {
  async execute(input: { source: CodeChangeSource }) {
    let observation = { source: input.source };
    let done = false;
    
    while (!done) {
      // Thought: 分析当前状态，决定下一步
      const thought = await this.think(observation);
      
      // Action: 选择并执行工具
      const action = this.decideAction(thought);
      
      if (action.type === 'analyze-matrix') {
        observation = await this.tools.analyzeTestMatrix(action.params);
      } else if (action.type === 'generate-tests') {
        observation = await this.tools.generateTests(action.params);
      } else if (action.type === 'write-files') {
        observation = await this.tools.writeTestFiles(action.params);
      } else if (action.type === 'finish') {
        done = true;
      }
    }
    
    return observation;
  }
  
  private async think(observation: any): Promise<string> {
    // 使用 LLM 分析当前状态，生成思考
    const prompt = `
      Current state: ${JSON.stringify(observation)}
      What should I do next?
    `;
    return await this.llm.complete(prompt);
  }
  
  private decideAction(thought: string): Action {
    // 从思考中提取行动
    // 可以使用 function calling 或 structured output
    return parseAction(thought);
  }
}
```

## 6. 配置变更

新增环境变量:
```bash
# MCP 运行模式
MCP_MODE=stdio|http  # stdio: 本地开发, http: 生产环境

# HTTP 模式配置
HTTP_PORT=3000
HTTP_HOST=0.0.0.0

# Webhook 配置
WEBHOOK_SECRET=xxx
WEBHOOK_PATH=/webhooks/phabricator

# Git 配置
GIT_REPO_PATH=/path/to/repo
```

## 7. API 设计 (HTTP 模式)

### Webhook 端点
```
POST /webhooks/phabricator
Body: {
  event: "differential.revision.create",
  revisionId: "D123456"
}
```

### SSE 端点 (MCP over SSE)
```
GET /mcp/stream
Headers: Authorization: Bearer <token>
```

### 健康检查
```
GET /health
```

## 8. 向后兼容性

- 保留所有现有的 stdio 工具和 API
- 新增的工具作为扩展，不影响现有功能
- 通过环境变量 `MCP_MODE` 切换模式
- 默认 stdio 模式，确保现有用户不受影响
