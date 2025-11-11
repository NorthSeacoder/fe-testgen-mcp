# Changelog

## [3.1.1] - 2024-11-10

### 🐛 Bug Fixes

- **Cursor Agent 聊天窗口 Revision ID 解析失败**: 修复在 Cursor 编辑器的 Agent 聊天窗口中输入自然语言请求（如"帮我 review 一下这个 diff D12345"）时无法正确提取 Revision ID 的问题
  - 改进所有工具的 `revisionId` 参数描述，添加自然语言提取示例
  - 新增 `extractRevisionId` 工具函数，支持从多种格式中智能提取 ID（D12345、12345、"diff 12345"等）
  - 在所有相关工具的 `beforeExecute` 中自动规范化 Revision ID
  - 支持的格式：
    - `D12345` 或 `d12345` → `D12345`
    - `12345` → `D12345`
    - `"帮我 review 一下这个 diff D12345"` → `D12345`
    - `"review this diff D12345"` → `D12345`
    - `"D 12345"` (带空格) → `D12345`
    - `"diff 12345"` → `D12345`

### 📝 Documentation

- 更新所有工具的 `inputSchema.revisionId` 描述，明确说明支持的输入格式和自动规范化行为

---

## [3.1.0] - 2024-11-10

### 🎉 重大更新 - 完整工具集成

#### Agent 系统封装为 MCP 工具

- **新增**: `review-frontend-diff` - 封装 ReviewAgent 的多维度代码审查工具
- **新增**: `analyze-test-matrix` - 封装 TestMatrixAnalyzer 的测试矩阵分析工具
- **新增**: `generate-tests` - 封装 TestAgent 的测试生成工具
- **新增**: `publish-phabricator-comments` - 发布评论到 Phabricator（支持去重、dry-run）
- **新增**: `write-test-file` - 将测试代码写入磁盘（支持 dry-run、overwrite）
- **新增**: `run-tests` - 执行测试命令并解析结果（Vitest/Jest）

#### n8n/GitLab/GitHub 集成

- **新增**: `analyze-raw-diff-test-matrix` - 接受外部 raw diff 的测试矩阵分析工具
- **新增**: `generate-tests-from-raw-diff` - 一体化单元测试生成工具（支持 n8n 工作流）
- **新增**: `N8N_INTEGRATION.md` - 完整的 n8n 集成文档，包含 GitLab MR 和 GitHub PR 自动化示例

### 📊 统计

- **工具数量**: 从 2 个增加到 10 个 MCP 工具
- **代码规模**: ~68+ TypeScript 文件
- **Agent 系统**: 12 个 Agent（2 主 + 10 专业）全部封装完成

### 🚀 改进

- **统一生命周期**: 所有工具继承 BaseTool，统一错误处理和日志
- **依赖注入**: 正确的依赖注入模式（OpenAI、Embedding、StateManager 等）
- **类型安全**: 所有工具通过 TypeScript 严格类型检查
- **文档完善**: 详细的参数说明、使用场景和工作流示例

### 📝 文档

- **新增**: `N8N_INTEGRATION.md` - n8n 集成完整指南
- **更新**: `README.md` - 反映新的工具状态
- **更新**: `.project-status` - 更新项目进度

---

## [3.0.0] - 2024-11-09

### 🎉 重大变更

#### 完全迁移到 FastMCP

- **新增**: 使用 `fastmcp` 作为唯一 MCP 实现
- **新增**: 内置 HTTP Streaming 和 SSE 支持
- **移除**: 旧的 `@modelcontextprotocol/sdk` 实现
- **移除**: 自定义 HTTP Transport (`src/transports/http.ts`)
- **移除**: Prometheus Exporter
- **移除**: Express、CORS、prom-client 等依赖

#### 监控数据上报

- **新增**: 远程监控数据主动上报功能
- **新增**: 自动上报工具调用、服务器事件、错误
- **新增**: Metrics 系统与上报服务集成
- **新增**: 环境区分（dev 环境不上报）
- **配置**: tracking 配置支持（config.yaml + 环境变量）

### 🚀 改进

- **简化**: 单一入口点，统一实现
- **优化**: 更少的依赖和更清晰的代码
- **增强**: ToolRegistry 新增 `listAll()` 方法支持惰性加载

### 📝 文档

- **更新**: `README.md` - 反映新架构
- **更新**: `TRACKING_GUIDE.md` - 监控配置说明

> 说明：原 `UPDATE_SUMMARY.md`、`MIGRATION_V3.md` 等迁移文档已整合进 README，保持文档精简。

### ⚠️ 破坏性变更

1. **HTTP 端点变更**: 从 REST 风格 (`/api/*`) 改为 MCP 标准 (`/mcp`, `/sse`)
2. **启动命令**: 移除 `npm run start:fastmcp`，统一为 `npm start`
3. **监控方式**: 从被动拉取（Prometheus）改为主动推送（远程 API）
4. **依赖变更**: 移除多个依赖，新增 fastmcp

---

## [Unreleased]

### Added
- **write-test-file 工具**: 将生成的测试用例写入磁盘文件，支持批量写入和覆盖控制
- **fetch-commit-changes 工具**: 从本地 Git 仓库获取指定 commit 的变更内容
- **analyze-commit-test-matrix 工具**: 基于 commit 分析功能清单和测试矩阵
- **run-tests 工具**: 在项目中执行测试命令（支持自定义命令和超时控制）
- **Function Calling**: 自动根据工具元数据生成 OpenAI 函数定义，提升决策准确性

### Changed
- **优化 diff 行号格式**: 使用 `NEW_LINE_xxx` 和 `DELETED (was line xxx)` 前缀，使行号更加清晰明确
- **统一行号说明**: 在 `BaseAgent` 中新增 `getLineNumberInstructions()` 方法，为所有 CR agents 提供统一的行号格式说明
- **改进 React Agent prompt**: 强调使用新文件行号，避免混淆
- **改进 Accessibility Agent prompt**: 强调使用新文件行号，避免混淆

### Fixed
- **评论行数错乱问题**: 通过优化 diff 格式和 AI prompt，确保评论始终使用新文件的正确行号
- **删除行误报问题**: 明确标记已删除的行，避免 AI 对不存在的行发表评论
- **Cursor Agent Revision ID 解析失败**: 改进 Revision ID 提取和校验逻辑，支持从自然语言请求中识别如“帮我 review 一下这个 diff D12345”这类输入
