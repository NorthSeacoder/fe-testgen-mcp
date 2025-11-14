# fe-testgen-mcp

Frontend Test Generation MCP Server

基于 MCP 协议的前端单元测试生成工具，支持从客户端或工作流中获取代码变更并进行智能测试生成。

## 功能特性

### 测试生成
- ✅ 智能分析测试矩阵
- ✅ 生成多场景测试用例 (正常/边界/异常/状态变更)
- ✅ 支持 Vitest/Jest
- ✅ Embedding 增强的测试生成
- ✅ 参考现有测试风格
- ✅ 支持 n8n + GitLab/GitHub 集成（接受外部 raw diff，详见下文“外部 diff 工具”小节）

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
- 🔌 **CodeChangeSource**：统一 Git / Raw diff / 工作流输入
- 💉 **AppContext**：轻量级依赖注入容器
- 📤 **监控数据上报**：自动上报工具调用、服务器事件、错误等到远程监控服务
- ⚡ **性能优化**：惰性加载、并行执行、LLM 批处理、分层缓存

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

# HTTP 传输模式配置（可选，默认在交互式终端使用 HTTP 模式）
TRANSPORT_MODE=stdio        # 设置为 stdio 强制使用标准输入输出模式
HTTP_PORT=3000              # HTTP 端口（默认 3000）
HTTP_HOST=0.0.0.0           # HTTP 监听地址（默认 localhost）
HTTP_ENDPOINT=/mcp          # HTTP MCP 接入路径（默认 /mcp）

# 监控数据上报配置（可选，默认不启用）
TRACKING_ENABLED=true                # 设置为 true 启用监控上报（默认不启用）
TRACKING_APP_ID=MCP_SERVICE          # 应用标识（默认值）
TRACKING_APP_VERSION=3.0.0           # 应用版本（可选）
TRACKING_ENV=prod                    # 环境：dev/test/prod（默认 prod）
TRACKING_MEASUREMENT=mcp_service_metrics  # 指标名称（默认值）
TRACKING_METRICS_TYPE=metricsType1   # 指标类型（默认值）

# 日志配置（可选，默认全部关闭以避免干扰 stdio 通信）
ENABLE_FILE_LOG=false                # 是否启用文件日志（默认 false，开发模式自动启用）
ENABLE_CONSOLE_LOG=false             # 是否启用控制台日志（默认 false，开发模式自动启用）
LOG_LEVEL=info                       # 日志级别：debug/info/warn/error
```

**重要提示：**
- ✅ **Node.js 版本要求**：需要 Node.js 18.0.0 或更高版本（推荐使用 Node.js 20+）
- 📝 **日志配置**：在 stdio 模式下，日志默认全部关闭以避免干扰 MCP 通信。如需调试，可在开发模式 (`NODE_ENV=development`) 下自动启用日志，或手动设置 `ENABLE_FILE_LOG=true` 和 `ENABLE_CONSOLE_LOG=true`
- ⚠️ **undici 兼容性**：如果遇到 "File is not defined" 错误，请确保使用 Node.js 18+ 并重新执行 `npm run build`

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

cache:
  ttl: 3600000  # 1小时

# 自定义项目规则 (可选)
# projectContextPrompt: "src/prompts/project-context.md"
```

### 3. 自定义项目规则 (可选)

编辑 `src/prompts/project-context.md` 添加项目特定的规则,然后在 `config.yaml` 中启用:

```yaml
projectContextPrompt: "src/prompts/project-context.md"
```

### 4. 仓库级 Prompt 配置（推荐）

`generate-tests` 会在运行时自动合并项目特定的 Prompt。系统会按以下优先级顺序查找配置文件（命中第一个非空文件即停止）：

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

- 👉 **n8n/GitLab/GitHub 工作流示例**：见下方“外部 diff 工具”章节中的推荐流程

### 运行模式

本项目基于 `fastmcp` 库实现，提供简化的 API 和内置 HTTP Streaming 支持。

#### 快速启动（自动检测模式）

```bash
npm start
```

**智能模式选择**：
- 🖥️ **交互式终端**：自动使用 HTTP Streaming 模式，显示完整的服务器 URL 和端口
- 📡 **非交互式/管道**：自动使用 Stdio 模式（适用于 MCP 客户端调用）

启动后会显示类似以下信息：

```
============================================================
🚀 fe-testgen-mcp Server Started (HTTP Streaming Mode)
============================================================
📍 Server URL: http://localhost:3000/mcp
📡 Host: localhost
📡 Port: 3000
📋 MCP Endpoint: /mcp
============================================================

📝 Add to your MCP client configuration:

  "fe-testgen-mcp": {
    "url": "http://localhost:3000/mcp"
  }

============================================================
```

只需复制 URL 到你的 MCP 客户端配置即可。

#### 强制使用 Stdio 模式

如果需要在交互式终端中使用 Stdio 模式：

```bash
# 方法 1：命令行参数
npm start -- --transport stdio

# 方法 2：环境变量
TRANSPORT_MODE=stdio npm start
```

- 通过 stdio 与客户端通信
- 兼容所有支持 MCP 协议的客户端（如 Cursor、Claude Desktop）
- **注意**：Stdio 模式下会出现 "could not infer client capabilities" 警告是正常的（如果没有 MCP 客户端连接）

#### HTTP Streaming 模式配置

HTTP Streaming 默认以 **Stateless** 模式运行，以确保与 mcp-proxy、Claude Desktop 等 SSE 客户端的兼容性。每个请求都会自动创建独立会话，无需手动管理 `Mcp-Session-Id`。

如果需要自定义 HTTP 服务器配置：

```bash
# 方法 1：命令行参数
npm start -- --transport httpStream --port 8080 --host 0.0.0.0 --endpoint /api/mcp

# 方法 2：环境变量
TRANSPORT_MODE=httpStream HTTP_PORT=8080 HTTP_HOST=0.0.0.0 HTTP_ENDPOINT=/api/mcp npm start
```

**端点说明**：
- `POST http://localhost:3000/mcp` - MCP 主端点（HTTP Streaming，默认）
- `GET http://localhost:3000/sse` - SSE 端点（自动可用）

**兼容性提示**：
- ✅ Stateless 模式会自动携带全部工具列表，避免「tools not recognized」问题
- ✅ 与 mcp-proxy 的 SSE 日志 `[mcp-proxy] establishing new SSE stream ...` 完全兼容

**FastMCP 特性**：
- ✅ 内置 HTTP Streaming / SSE 支持
- ✅ 自动工具注册和连接管理
- ✅ 简化的 API 设计
- ✅ 完整的监控数据上报功能
- ✅ 智能模式检测，开箱即用

#### 监控数据上报（可选）

本项目支持将运行状态、工具调用情况、错误信息等实时上报到远程监控服务。

**环境变量配置**（推荐方式）：

```bash
# 启用监控上报（默认不启用）
TRACKING_ENABLED=true

# 可选配置（有默认值）
TRACKING_APP_ID=MCP_SERVICE          # 默认值
TRACKING_APP_VERSION=3.0.0           # 可选
TRACKING_ENV=prod                    # dev/test/prod，默认 prod
TRACKING_MEASUREMENT=mcp_service_metrics  # 默认值
TRACKING_METRICS_TYPE=metricsType1   # 默认值
```

**配置文件方式**（`config.yaml`）：

```yaml
tracking:
  enabled: true  # 设置为 false 或不配置则禁用
  appId: MCP_SERVICE
  appVersion: 3.0.0
  env: prod  # dev（不上报）、test、prod
  measurement: mcp_service_metrics
```

**自动上报事件**：
- 🚀 服务器生命周期事件（启动、关闭）
- 🔧 工具调用事件（耗时、状态）
- 📊 Metrics 指标
- ❌ 错误事件

> **注意**：监控上报默认关闭。只有设置 `TRACKING_ENABLED=true` 或在 config.yaml 中配置 `enabled: true` 时才会启用；其余配置示例已在本节列出。

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
        "OPENAI_MODEL": "gpt-4"
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
        "OPENAI_API_KEY": "sk-xxx"
      }
    }
  }
}
```

### 可用工具

本 MCP Server 当前提供 **10 个核心工具**，完整的 Agent 系统已实现并封装为 MCP 工具。

> ✅ **开发状态**: 核心 Agent 系统和辅助工具已完整实现并封装为 MCP 工具，包括并发控制、响应缓存、n8n 集成等优化。详见 [.project-status](./.project-status) 了解当前进度。

> ✅ **已实现核心功能**:
> - **AgentCoordinator**: 多 Agent 协作框架，支持并行执行、优先级调度、自动重试
> - **TestAgent**: 完整的测试生成流程（矩阵分析 + 4 种场景并行生成）
> - **性能优化**: OpenAI 响应缓存、p-limit 并发控制、自动去重

> 📋 **工具状态**:
> - ✅ **fetch-commit-changes** – Git commit → diff
> - ✅ **analyze-test-matrix** – diff → 功能与测试矩阵
> - ✅ **generate-tests** – 矩阵 → 测试代码
> - ✅ **write-test-file** – 将测试代码写入磁盘
> - ✅ **run-tests** – 执行 Vitest/Jest 并解析结果
> - ✅ **analyze-raw-diff-test-matrix** – raw diff → 测试矩阵
> - ✅ **generate-tests-from-raw-diff** – raw diff → 测试代码

#### 1. fetch-commit-changes

**功能：** 读取本地 Git 仓库指定 commit 的 diff，自动过滤前端文件并生成带 `NEW_LINE_xxx` 行号的 `numberedRaw`。

```typescript
{
  commitHash: string;   // 支持短 hash
  repoPath?: string;    // 默认当前工作目录
}
```

**输出亮点：** commit 基本信息、仅包含前端文件的 diff、`numberedRaw` 便于直接送入 LLM 或测试矩阵分析。

#### 2. analyze-test-matrix

**功能：** 基于 diff 分析功能清单与测试矩阵，是测试生成的第一步。

```typescript
{
  rawDiff: string;
  identifier?: string;
  projectRoot?: string;
  metadata?: {
    title?: string;
    author?: string;
    mergeRequestId?: string;
    commitHash?: string;
    branch?: string;
  };
}
```

**输出：** `features`、`scenarios`、`statistics`、检测到的测试框架以及最终的 `projectRoot`。若 diff 为空或无前端文件，会给出清晰的错误信息。

#### 3. generate-tests

**功能：** 调用 TestAgent 并行生成 happy-path / edge-case / error-path / state-change 四类测试场景，支持增量/全量、限量输出等配置。

```typescript
{
  rawDiff: string;
  identifier?: string;
  projectRoot?: string;
  metadata?: Record<string, string>;
  scenarios?: ('happy-path' | 'edge-case' | 'error-path' | 'state-change')[];
  mode?: 'incremental' | 'full';
  maxTests?: number;
  analyzeMatrix?: boolean; // 默认 true
  framework?: 'vitest' | 'jest';
}
```

**输出：** `tests`（包含 testFile、testName、代码、置信度等）、`summary`（按场景/文件统计）以及可选的 `matrix`。

#### 4. write-test-file

**功能：** 将 `generate-tests` 产生的结果写入磁盘，自动创建目录并提供 dry-run 预览模式。

```typescript
{
  tests: TestCase[];
  projectRoot?: string;   // 默认当前目录
  dryRun?: boolean;       // 仅打印将写入的文件
  overwrite?: boolean;    // 默认 false，避免覆盖已有测试
}
```

**输出：** 写入/跳过/失败文件列表以及按框架统计的摘要。

#### 5. run-tests

**功能：** 执行 Vitest/Jest 并返回结构化的执行结果，支持覆盖率、监听模式以及定制测试文件列表。

```typescript
{
  testFiles?: string[];
  projectRoot?: string;
  framework?: 'vitest' | 'jest';
  watch?: boolean;
  coverage?: boolean;
  timeout?: number; // 默认 30000
}
```

**输出：** `success`、`summary`（total/passed/failed/skipped/duration）、`stdout`、`stderr`、`exitCode`。

#### 6. analyze-raw-diff-test-matrix

**功能：** 面向 n8n/GitLab/GitHub 等工作流，直接接受 raw diff 并输出测试矩阵。

```typescript
{
  rawDiff: string;
  identifier: string;
  projectRoot: string;
  metadata?: { title?: string; author?: string; mergeRequestId?: string; commitHash?: string; branch?: string; };
  forceRefresh?: boolean;
}
```

**使用场景：** 外部系统已获取 diff，希望在 MCP 中完成分析再决定后续步骤。

#### 7. generate-tests-from-raw-diff

**功能：** raw diff 场景的一体化方案，可选分析矩阵后立即生成测试。

```typescript
{
  rawDiff: string;
  identifier: string;
  projectRoot: string;
  metadata?: Record<string, string>;
  scenarios?: string[];
  mode?: 'incremental' | 'full';
  maxTests?: number;
  analyzeMatrix?: boolean; // 默认 true
  framework?: 'vitest' | 'jest';
}
```

**推荐工作流：**
1. 在 n8n / CI 中获取 MR/PR diff
2. 调用 `generate-tests-from-raw-diff` 生成测试与统计信息
3. （可选）将结果写入文件或发布到代码托管平台

---

## 架构

```
src/
├── agents/             # 测试生成 Agents
│   └── tests/          # 不同测试场景（happy-path / edge-case 等）
├── clients/            # 外部服务客户端
│   ├── openai.ts       # OpenAI LLM 客户端
│   └── embedding.ts    # Embedding 客户端
├── tools/              # MCP 工具实现
│   ├── analyze-test-matrix.ts
│   ├── generate-tests.ts
│   ├── fetch-commit-changes.ts
│   ├── analyze-raw-diff-test-matrix.ts
│   └── generate-tests-from-raw-diff.ts
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

测试生成支持增量模式，通过 Diff 指纹和 Embedding 相似度计算，避免重复生成相同的测试用例。

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
