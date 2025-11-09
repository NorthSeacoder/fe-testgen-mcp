# fe-testgen-mcp

Frontend Phabricator Diff Review and Unit Test Generation MCP Server

基于 MCP 协议的前端代码审查和单元测试生成工具,支持从 Phabricator 获取 Diff 并进行智能分析。

## 功能特性

### 代码审查
- ✅ 多维度代码审查 (React/TypeScript/性能/安全/可访问性/CSS/国际化)
- ✅ 自动识别审查主题
- ✅ 多 Agent 并行执行
- ✅ 增量去重,避免重复评论
- ✅ 智能合并同行评论
- ✅ 自动发布到 Phabricator

> ⚠️ **注意**：代码审查工具仅支持 Phabricator Diff（需要通过 `fetch-diff` 获取 diffId，确保行号准确）。

### 测试生成
- ✅ 智能分析测试矩阵
- ✅ 生成多场景测试用例 (正常/边界/异常/状态变更)
- ✅ 支持 Vitest/Jest
- ✅ Embedding 增强的测试生成
- ✅ 参考现有测试风格
- ✅ 支持 n8n + GitLab/GitHub 集成（接受外部 raw diff）

### 项目支持
- ✅ 自动检测项目根目录
- ✅ 支持 Monorepo (pnpm/yarn/npm workspaces, Lerna, Nx, Rush)
- ✅ 自动检测测试框架

### 核心架构
- 🧠 **ReAct Agent 引擎**：支持 Thought → Action → Observation 循环
- 🧰 **Function Calling**：自动根据工具元数据生成 OpenAI 函数定义，失败时回退到正则解析
- 🛠️ **BaseTool 基类**：统一生命周期管理（beforeExecute, executeImpl, afterExecute, onError）
- 📊 **Metrics 体系**：自动埋点，支持 Counter/Timer/Histogram/Gauge
- 🗂️ **ToolRegistry**：集中管理所有工具，支持惰性加载和动态注册
- 🧱 **Pipeline DSL**：声明式工作流编排（支持并行执行、循环、分支）
- 🧠 **Context & Memory**：短期上下文与长期记忆管理
- 🔌 **CodeChangeSource**：统一 Phabricator / Git / Raw diff 接入
- 💉 **AppContext**：轻量级依赖注入容器
- 📤 **Metrics 导出**：支持 JSON / Prometheus / Custom 格式，预留远程上传接口
- ⚡ **性能优化**：惰性加载、并行执行、LLM 批处理、分层缓存

**文档**：
- `MIGRATION_COMPLETED.md` - 架构迁移完成报告（v3.0.0）
- `REFACTOR_SUMMARY.md` - 重构总结
- `ARCHITECTURE_REDESIGN.md` - 架构设计文档
- `WORKFLOW_EXAMPLES.md` - 工作流示例
- `FUNCTION_CALLING_GUIDE.md` - Function Calling 使用指南
- `HTTP_TRANSPORT_GUIDE.md` - HTTP Transport 使用指南

## 安装

```bash
npm install
npm run build
```

## 配置

### 1. 环境变量

在 MCP 客户端配置中设置：

#### 必需变量

```bash
# OpenAI API Key（必需）
OPENAI_API_KEY=sk-xxx

# Phabricator 配置（必需）
PHABRICATOR_HOST=https://phabricator.example.com
PHABRICATOR_TOKEN=api-xxx
```

#### 可选变量

```bash
# LLM 配置
OPENAI_BASE_URL=https://api.openai.com/v1  # 默认值
OPENAI_MODEL=gpt-4                          # 默认值

# Embedding 配置（用于增强测试生成和去重）
EMBEDDING_BASE_URL=https://api.openai.com/v1  # 默认使用 OPENAI_BASE_URL
EMBEDDING_MODEL=text-embedding-3-small        # 默认值

# 模型参数
MODEL_TEMPERATURE=0    # 默认值，范围 0-2
MODEL_TOP_P=1          # 默认值，范围 0-1

# 缓存和状态
CACHE_DIR=.cache       # 默认值
STATE_DIR=.state       # 默认值

# 安全开关
ALLOW_PUBLISH_COMMENTS=false  # 默认值，设为 true 允许发布评论
```

**注意：** 不需要设置 `MCP_MODE` 或 `LOG_LEVEL`，这些是其他项目的配置。

### 2. 配置文件

修改 `config.yaml` (可选):

```yaml
llm:
  model: gpt-4
  temperature: 0.3
  maxTokens: 4000

embedding:
  enabled: true
  model: text-embedding-3-small

orchestrator:
  parallelAgents: true
  maxConcurrency: 3

filter:
  minConfidence: 0.7
  
cache:
  ttl: 3600000  # 1小时

# 自定义项目规则 (可选)
# projectContextPrompt: "src/prompts/project-context.md"
```

### 3. 自定义审查规则 (可选)

编辑 `src/prompts/project-context.md` 添加项目特定的审查规则,然后在 `config.yaml` 中启用:

```yaml
projectContextPrompt: "src/prompts/project-context.md"
```

### 4. 仓库级 Prompt 配置（推荐）

`review-frontend-diff` 和 `generate-tests` 会在运行时自动合并项目特定的 Prompt。系统会按以下优先级顺序查找配置文件（命中第一个非空文件即停止）：

1. `fe-mcp` / `fe-mcp.md` / `fe-mcp.mdc` （**FE MCP 专用配置，推荐**）
2. `.cursorrules` （Cursor AI 编辑器规则）
3. `.ai/rules.md` 或 `.ai/prompt.md`
4. `.mcp/prompt.md` 或 `.mcp/rules.md`
5. `.llmrules`
6. `.codingconvention.md` 或 `CODING_CONVENTIONS.md`

Prompt 合并优先级为 **工具参数 `projectRoot` 指定路径 > 仓库级配置 > 全局 `config.yaml` 配置**。这意味着可以通过工具调用显式切换项目根目录，或在配置文件中提供默认规则作为后备。

#### Monorepo 支持

对于 monorepo 项目，系统会智能查找配置：

1. **子项目配置优先**：如果变更的文件位于子项目（如 `packages/foo`），会先在子项目根目录查找配置
2. **回退到根配置**：如果子项目没有配置，使用 monorepo 根目录的配置
3. **共享配置**：可以在根目录放置通用规则，在子项目放置特定规则

示例结构：

```
monorepo-root/
├── fe-mcp.md           # 全局规则（所有子项目共享）
├── packages/
│   ├── ui-components/
│   │   └── fe-mcp.md   # UI 组件库专用规则（优先级更高）
│   └── business-logic/
│       └── fe-mcp.md   # 业务逻辑专用规则
└── apps/
    └── web/
        └── fe-mcp.md   # Web 应用专用规则
```

**快速上手**：

```bash
# 在项目根目录创建 FE MCP 专用配置文件（推荐）
touch fe-mcp.md

cat >> fe-mcp.md <<'EOF'
# 前端编码规范

## React 组件
- 必须使用函数式组件 + Hooks
- 所有组件需要 TypeScript 类型定义
- Props 使用 interface 定义，不使用 type

## 样式规范
- 使用 Tailwind CSS
- 禁止内联样式
- 组件样式文件使用 .module.css 后缀

## 状态管理
- 使用 Zustand 进行全局状态管理
- 本地状态优先使用 useState
- 复杂状态逻辑使用 useReducer
EOF

# 对于 Monorepo，可以在子项目中创建特定规则
mkdir -p packages/ui-components
cat >> packages/ui-components/fe-mcp.md <<'EOF'
# UI 组件库规范

继承根目录规则，额外要求：
- 所有组件必须导出 Props 类型
- 必须提供 Storybook 示例
- 必须有单元测试覆盖
EOF
```

执行审查或测试生成时，日志中会输出 `Using package-level prompt config` 或 `Using repo-level prompt config` 信息，用于确认配置来源。若自动识别失败，可：

- 在工具输入中显式传入 `projectRoot`
- 或预先设置环境变量 `PROJECT_ROOT`

**提示**：当仓库级 Prompt 更新后，可通过 `forceRefresh: true` 参数强制重新加载。

## 使用

### 运行模式

#### 1. Stdio（默认）

```bash
npm start
```

- 通过 stdio 与客户端通信
- 兼容所有支持 MCP 协议的客户端（如 Cursor）

#### 2. HTTP API

```bash
# 方法 1：命令行参数
npm start -- --transport=http

# 方法 2：环境变量
TRANSPORT_MODE=http HTTP_PORT=3000 npm start
```

**默认端点**：
- `GET  /api/tools` - 列出可用工具
- `POST /api/tools/call` - 调用工具（JSON 请求）
- `GET  /api/metrics` - Prometheus 指标
- `GET  /api/health` - 健康检查

> 详细用法请参阅 [HTTP_TRANSPORT_GUIDE.md](./HTTP_TRANSPORT_GUIDE.md)

#### 3. Prometheus Metrics

HTTP 模式自动暴露 `/api/metrics` 端点，支持 Prometheus 抓取：

```yaml
scrape_configs:
  - job_name: 'fe-testgen-mcp'
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: '/api/metrics'
```

Prometheus 指标前缀默认为 `fe_testgen_mcp_`，并自动附带 `service`、`version` 标签。

### 作为 MCP Server

在 Cursor/Claude Desktop 等 MCP 客户端中配置:

#### Cursor 配置

编辑 `~/.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "fe-testgen-mcp": {
      "command": "node",
      "args": ["/path/to/fe-testgen-mcp/dist/index.js"],
      "env": {
        "OPENAI_API_KEY": "sk-xxx",
        "OPENAI_BASE_URL": "https://api.openai.com/v1",
        "OPENAI_MODEL": "gpt-4",
        "PHABRICATOR_HOST": "https://phabricator.example.com",
        "PHABRICATOR_TOKEN": "api-xxx"
      }
    }
  }
}
```

#### Claude Desktop 配置

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`（macOS）：

```json
{
  "mcpServers": {
    "fe-testgen-mcp": {
      "command": "node",
      "args": ["/path/to/fe-testgen-mcp/dist/index.js"],
      "env": {
        "OPENAI_API_KEY": "sk-xxx",
        "PHABRICATOR_HOST": "https://phabricator.example.com",
        "PHABRICATOR_TOKEN": "api-xxx"
      }
    }
  }
}
```

### 可用工具

本 MCP Server 提供 **11 个工具**，涵盖测试生成和代码审查的完整流程。

> 💡 **新增 n8n/GitLab 集成工具**: 为支持 n8n 工作流与 GitLab 集成，新增 `analyze-raw-diff-test-matrix` 和 `generate-tests-from-raw-diff` 两个专用工具，直接接受外部传入的 diff 内容，无需依赖 Phabricator 或 Git 操作。详见 [N8N_GITLAB_INTEGRATION.md](./N8N_GITLAB_INTEGRATION.md)。

> 💡 **架构优化**: 移除了 `detect-project-test-stack` 和 `resolve-path` 这两个内部工具，它们的功能已集成到需要它们的工具中（如 `analyze-test-matrix`），简化了 API 并提高了代码复用性。

#### 1. fetch-diff

**功能：** 从 Phabricator 获取完整的 Diff 内容，包括所有文件变更、hunks 和统计信息。

**参数：**
```typescript
{
  revisionId: string      // Revision ID（如 D123456）
  forceRefresh?: boolean  // 强制刷新缓存（默认 false）
}
```

**返回：**
- Revision 标题和描述
- 文件路径列表
- 变更类型（新增/修改/删除）
- 增删行数统计
- 每个文件的 hunks（具体变更内容）
- 完整的 diff 文本（unified diff 格式）

**使用场景：**
- 在执行其他操作前先查看 diff 内容
- 了解变更的具体细节
- 仅需查看 diff，不执行审查或测试生成

**注意：** 此工具返回的信息已包含所有变更细节，无需使用 `git show` 等命令。

---

#### 2. fetch-commit-changes

**功能：** 从本地 Git 仓库获取指定 commit 的变更内容。

**参数：**
```typescript
{
  commitHash: string  // Git commit hash（支持短 hash）
  repoPath?: string   // 本地仓库路径（默认当前工作目录）
}
```

**返回：**
- commit 信息（hash、作者、提交时间、标题）
- 变更文件列表（仅保留前端文件）
- 每个文件的 hunks（NEW_LINE_xxx 标记新行）
- 完整的 diff 文本

**使用场景：**
- 代码合并后，根据 commit 生成功能清单和测试矩阵
- 无需 Phabricator 的环境下获取 diff
- 作为增量分析的基础数据源

---

#### 3. review-frontend-diff

**功能：** 对前端代码变更进行多维度智能审查，支持自动识别审查主题并生成评论。

> 💡 **行号说明**：diff 中所有新行都以 `NEW_LINE_XX` 开头；所有已删除的行会标记为 `DELETED (was line XX)`。
> 发布评论时将始终使用 `NEW_LINE_XX` 对应的新文件行号，避免出现行数偏移。

**参数：**
```typescript
{
  revisionId: string                 // Revision ID
  topics?: string[]                  // 手动指定审查主题（可选）
  mode?: 'incremental' | 'full'      // 增量或全量模式（默认 incremental）
  publish?: boolean                  // 是否发布评论到 Phabricator（默认 false）
  forceRefresh?: boolean             // 强制刷新缓存（默认 false）
}
```

**审查维度：**
- React 最佳实践
- TypeScript 类型安全
- 性能优化
- 安全性检查
- 可访问性（a11y）
- CSS/样式规范
- 国际化（i18n）
- 测试建议

**返回：**
- 识别的审查主题
- 发现的问题列表（文件、行号、描述、严重程度）
- 是否已发布到 Phabricator

**特性：**
- ✅ 自动识别需要审查的主题
- ✅ 多 Agent 并行执行
- ✅ 增量去重，避免重复评论
- ✅ 智能合并同行评论

**推荐工作流：**
1. 调用 `fetch-diff` 查看变更内容
2. 调用 `review-frontend-diff` 进行审查
3. 设置 `publish: true` 自动发布评论

---

#### 4. analyze-test-matrix

**功能：** 分析代码变更的功能清单和测试矩阵，这是测试生成的第一步。

**参数：**
```typescript
{
  revisionId: string       // Revision ID
  projectRoot?: string     // 项目根目录绝对路径（强烈推荐提供）
  forceRefresh?: boolean   // 强制刷新缓存（默认 false）
}
```

**返回：**
- 功能清单（变更涉及的功能点）
- 测试矩阵（每个功能需要的测试场景）
- 测试框架信息（Vitest/Jest）
- 项目根目录路径
- 统计信息（总功能数、总场景数、预估测试数）

**自动执行的步骤：**
1. 获取 diff 内容
2. 使用 projectRoot 解析文件路径
3. 检测测试框架
4. 分析功能清单和测试矩阵

**推荐工作流：**
1. 调用 `fetch-diff` 查看 diff 内容和文件路径
2. 执行 `pwd` 命令获取当前工作目录
3. 调用此工具，传入 `projectRoot` 参数
4. 保存返回的 `projectRoot` 值，供 `generate-tests` 使用

**注意：** projectRoot 参数虽然可选，但强烈建议提供，否则可能导致路径解析失败。

---

#### 5. generate-tests

**功能：** 基于测试矩阵生成具体的单元测试代码，支持多种测试场景。

**参数：**
```typescript
{
  revisionId: string                 // Revision ID
  projectRoot?: string               // 项目根目录（必须与 analyze-test-matrix 使用相同值）
  scenarios?: string[]               // 手动指定测试场景（可选）
  mode?: 'incremental' | 'full'      // 增量或全量模式（默认 incremental）
  maxTests?: number                  // 最大测试数量（可选）
  forceRefresh?: boolean             // 强制刷新缓存（默认 false）
}
```

**测试场景类型：**
- **happy-path**: 正常流程测试
- **edge-case**: 边界条件测试
- **error-path**: 异常处理测试
- **state-change**: 状态变更测试

**返回：**
- 生成的测试用例列表
- 每个测试的代码、文件路径、场景类型
- 识别的测试场景
- 统计信息

**特性：**
- ✅ 基于现有测试风格生成（通过 Embedding 查找相似测试）
- ✅ 支持 Vitest 和 Jest
- ✅ 增量去重，避免生成重复测试
- ✅ 智能识别需要的测试场景

**推荐工作流：**
1. 先调用 `analyze-test-matrix` 生成测试矩阵
2. 从返回结果中获取 `projectRoot` 字段的值
3. 调用此工具，传入相同的 `projectRoot` 值

**重要：** 必须先调用 `analyze-test-matrix`，且 projectRoot 参数必须与其保持一致。

---

#### 6. publish-phabricator-comments

**功能：** 手动发布评论到 Phabricator（通常由 `review-frontend-diff` 自动调用）。

**参数：**
```typescript
{
  revisionId: string       // Revision ID
  comments: Array<{
    file: string           // 文件路径
    line: number           // 行号
    message: string        // 评论内容
    issueId: string        // 问题 ID（用于去重）
  }>
  message?: string         // 总体评论（可选）
  incremental?: boolean    // 增量模式，启用去重（默认 true）
}
```

**返回：**
- 发布成功的评论数量
- 跳过的评论数量（已存在）
- 详细结果列表

**特性：**
- ✅ 增量去重，避免重复发布
- ✅ 智能合并同行评论
- ✅ 支持批量发布

**使用场景：**
- 手动发布自定义评论
- 重新发布之前生成的评论
- 调试评论发布问题

---

#### 7. write-test-file

**功能：** 将生成的测试用例写入磁盘文件。

**参数：**
```typescript
{
  files: Array<{
    filePath: string;   // 测试文件的绝对路径
    content: string;    // 要写入的测试代码
    overwrite?: boolean // 是否覆盖已存在的文件（默认 false）
  }>
}
```

**返回：**
- success: 写入成功的文件数量
- total: 处理的文件总数
- results: 每个文件的写入结果（success/error）

**使用场景：**
- 将 `generate-tests` 生成的测试代码落盘
- 批量创建多个测试文件
- 控制是否覆盖已有文件（默认不覆盖，避免误删）

---

#### 8. analyze-commit-test-matrix

**功能：** 分析 commit 的功能清单和测试矩阵。

**参数：**
```typescript
{
  commitHash: string      // Git commit hash
  repoPath?: string       // 仓库路径
  projectRoot?: string    // 项目根目录
}
```

**使用场景：**
- 代码合并后自动生成测试矩阵
- CI/CD 流程中根据 commit 分析测试需求

---

#### 9. run-tests

**功能：** 在项目中执行测试命令。

**参数：**
```typescript
{
  projectRoot?: string    // 项目根目录
  command?: string        // 命令（默认 npm）
  args?: string[]         // 参数（默认 ["test", "--", "--runInBand"]）
  timeoutMs?: number      // 超时时间（默认 600000）
}
```

**使用场景：**
- 生成测试后自动执行验证
- CI/CD 流程中执行测试套件
- 验证代码质量门控

---

#### 10. analyze-raw-diff-test-matrix 🆕

**功能：** 从外部传入的 raw diff 内容分析测试矩阵（专为 n8n/GitLab 工作流设计）。

**参数：**
```typescript
{
  rawDiff: string             // Unified diff 格式的原始文本（必需）
  identifier: string          // 唯一标识符，如 MR ID（必需）
  projectRoot: string         // 项目根目录绝对路径（必需）
  metadata?: {                // 可选元数据
    title?: string            // MR 标题
    author?: string           // 作者
    mergeRequestId?: string   // MR ID
    commitHash?: string       // commit hash
    branch?: string           // 分支名
  }
  forceRefresh?: boolean      // 强制刷新缓存（默认 false）
}
```

**返回：**
- 功能清单和测试矩阵
- 测试框架信息（Vitest/Jest）
- 统计信息（功能数、场景数、预估测试数）

**使用场景：**
- n8n 工作流中，GitLab 节点已获取 diff
- 支持 GitLab MR、GitHub PR 等平台的 diff
- 分步式工作流，先分析后决策

**推荐 n8n 工作流：**
1. [GitLab 节点] 获取 MR diff
2. [此工具] 分析测试矩阵
3. [Code 节点] 根据矩阵决策
4. [MCP: generate-tests-from-raw-diff] 生成测试

---

#### 11. generate-tests-from-raw-diff 🆕

**功能：** 从外部传入的 raw diff 一次性完成分析 + 测试生成（端到端工具）。

**参数：**
```typescript
{
  rawDiff: string             // Unified diff 格式的原始文本（必需）
  identifier: string          // 唯一标识符（必需）
  projectRoot: string         // 项目根目录（必需）
  metadata?: {                // 可选元数据
    title?: string
    author?: string
    mergeRequestId?: string
    commitHash?: string
    branch?: string
  }
  scenarios?: string[]        // 手动指定测试场景（可选）
  mode?: 'incremental' | 'full'  // 增量或全量模式
  maxTests?: number           // 最大测试数量
  analyzeMatrix?: boolean     // 是否先分析矩阵（默认 true）
  forceRefresh?: boolean      // 强制刷新缓存
}
```

**返回：**
- 生成的测试用例列表
- 识别的测试场景
- 测试代码、文件路径、场景类型
- 统计信息

**使用场景：**
- n8n 工作流中，GitLab 节点已获取 diff
- 希望直接生成测试代码，无需额外步骤
- 端到端式工作流，简洁高效

**推荐 n8n 工作流：**
1. [GitLab 节点] 获取 MR diff
2. [此工具] 直接生成测试代码
3. [Code 节点] 格式化为 GitLab 评论
4. [GitLab 节点] 发布 MR 评论

**详细文档：** 查看 [N8N_GITLAB_INTEGRATION.md](./N8N_GITLAB_INTEGRATION.md) 了解完整的 n8n 工作流配置和示例。

---

## 完整工作流示例

查看 [WORKFLOW_EXAMPLES.md](./WORKFLOW_EXAMPLES.md) 了解完整的使用示例。

## 架构

```
src/
├── agents/              # 审查和测试生成 Agents
│   ├── cr/             # 代码审查 Agents
│   └── tests/          # 测试生成 Agents
├── clients/            # 外部服务客户端
│   ├── openai.ts       # OpenAI LLM 客户端
│   ├── embedding.ts    # Embedding 客户端
│   └── phabricator.ts  # Phabricator API 客户端
├── orchestrator/       # 工作流编排
├── tools/              # MCP 工具实现
│   ├── base-analyze-test-matrix.ts  # 测试矩阵分析基类（共享逻辑）
│   ├── analyze-test-matrix.ts       # Phabricator diff 分析
│   ├── analyze-commit-test-matrix.ts # Git commit 分析
│   └── ...
├── prompts/            # AI 提示词模板
├── schemas/            # 数据结构定义
├── utils/              # 工具函数
│   ├── response-formatter.ts  # MCP 响应格式化（统一）
│   └── ...
├── cache/              # 缓存管理
├── state/              # 状态管理
└── config/             # 配置加载
```

### 代码优化亮点

- **统一响应格式化**: `utils/response-formatter.ts` 提供统一的 MCP 响应格式化，减少重复代码
- **共享分析逻辑**: `tools/base-analyze-test-matrix.ts` 基类封装测试矩阵分析的通用逻辑，避免 85% 的代码重复
- **精简工具层**: 移除冗余的内部工具（`detect-project-test-stack`、`resolve-path`），集成到需要它们的工具中
- **清晰的关注点分离**: 工具层专注业务逻辑，格式化和共享逻辑独立维护

## 开发

```bash
# 构建
npm run build

# 开发模式 (watch)
npm run dev

# 类型检查
npm run typecheck
```

## 日志

日志文件位于 `logs/fe-testgen-mcp.log`,包含详细的执行信息。

## 高级功能

### 增量去重

代码审查和测试生成都支持增量模式,通过 Diff 指纹和 Embedding 相似度计算,避免重复生成相同的评论或测试。

### Embedding 增强

启用 Embedding 后,系统会:
- 查找相关的现有测试文件作为参考
- 对新生成的内容进行相似度去重
- 提高生成质量和一致性

### Monorepo 支持

自动检测 Monorepo 结构并正确解析文件路径:
- 支持 pnpm/yarn/npm workspaces
- 支持 Lerna, Nx, Rush
- 自动识别子包和项目根目录

## 故障排查

### 项目根目录检测失败

如果遇到 "Failed to detect project root" 错误:
1. 确保在正确的项目目录下运行
2. 手动传入 `projectRoot` 参数 (使用 `pwd` 获取绝对路径)
3. 检查项目是否包含 `package.json`

### API 调用失败

检查 `.env` 文件中的配置:
- `OPENAI_API_KEY` 是否正确
- `OPENAI_BASE_URL` 是否可访问
- `PHABRICATOR_HOST` 和 `PHABRICATOR_TOKEN` 是否有效

### 缓存问题

使用 `forceRefresh: true` 强制刷新缓存,或手动删除 `.cache` 目录。

## 性能优化

- **并行执行**: 多个 Agent 并行运行,提高效率
- **智能缓存**: Diff 和状态缓存,减少重复请求
- **批量处理**: 评论合并和批量发布
- **增量更新**: 只处理变更的部分

## 监控统计

查看 `METRICS_MONITORING.md` 了解如何收集使用统计并在 Grafana 上展示。

## License

MIT
