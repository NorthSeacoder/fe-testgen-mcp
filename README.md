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

### 测试生成
- ✅ 智能分析测试矩阵
- ✅ 生成多场景测试用例 (正常/边界/异常/状态变更)
- ✅ 支持 Vitest/Jest
- ✅ Embedding 增强的测试生成
- ✅ 参考现有测试风格

### 项目支持
- ✅ 自动检测项目根目录
- ✅ 支持 Monorepo (pnpm/yarn/npm workspaces, Lerna, Nx, Rush)
- ✅ 自动检测测试框架

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

## 使用

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

本 MCP Server 提供 8 个工具，涵盖测试生成和代码审查的完整流程。

#### 1. detect-project-test-stack

**功能：** 自动检测项目使用的测试框架（Vitest 或 Jest）。

**参数：**
```typescript
{
  repoRoot?: string  // 项目根目录路径（可选）
}
```

**返回：**
- 测试框架类型（vitest/jest/unknown）
- 检测到的配置文件
- 项目根目录路径

**使用场景：**
- 在生成测试前确认项目测试框架
- 调试项目根目录检测问题

---

#### 2. fetch-diff

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

#### 7. resolve-path

**功能：** 将相对路径解析为绝对路径，并返回检测到的项目根目录（高级工具，一般无需直接调用）。

**参数：**
```typescript
{
  paths: string[]          // 相对路径数组
  projectRoot?: string     // 项目根目录路径（可选，优先级最高）
}
```

**返回：**
- 项目根目录路径
- 解析后的绝对路径列表

**使用场景：**
- 调试路径解析问题
- 验证项目根目录检测是否正确
- 在自定义工作流中手动解析路径

**注意：** 其他工具（如 `analyze-test-matrix`、`review-frontend-diff`）已内置路径解析功能，一般情况下无需直接调用此工具。

---

#### 8. write-test-file

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
├── prompts/            # AI 提示词模板
├── schemas/            # 数据结构定义
├── utils/              # 工具函数
├── cache/              # 缓存管理
├── state/              # 状态管理
└── config/             # 配置加载
```

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
