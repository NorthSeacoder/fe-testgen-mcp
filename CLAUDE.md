# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

**fe-testgen-mcp** 是一个基于 MCP (Model Context Protocol) 协议的前端代码审查和单元测试生成工具。它能够：

- 从 Phabricator 获取代码差异并进行智能审查
- 自动分析测试矩阵并生成单元测试用例
- 支持 commit-based 和 diff-based 两种分析模式
- 集成多种 AI 智能体进行并行审查

## 快速开始

### 常用命令

```bash
# 构建项目
npm run build

# 开发模式（监听文件变化）
npm run dev

# 运行测试
npm run test

# 类型检查
npm run typecheck

# 启动 MCP 服务器
npm start
```

### 环境配置

必需的環境變量：
- `OPENAI_API_KEY` - OpenAI API 密钥
- `PHABRICATOR_HOST` - Phabricator 服务器地址
- `PHABRICATOR_TOKEN` - Phabricator API token

可选配置详见 `config.yaml` 和 `.env.example`。

## 代码架构

### 核心目录结构

```
src/
├── agents/                 # AI 智能体层
│   ├── cr/                # 代码审查智能体
│   │   ├── react.ts       # React 最佳实践审查
│   │   ├── typescript.ts  # TypeScript 类型安全审查
│   │   ├── performance.ts # 性能优化审查
│   │   ├── security.ts    # 安全性审查
│   │   ├── accessibility.ts # 可访问性审查
│   │   ├── css.ts         # CSS 规范审查
│   │   └── i18n.ts        # 国际化审查
│   ├── tests/             # 测试生成智能体
│   └── base.ts            # 智能体基类
├── tools/                 # MCP 工具层（原子化）
│   ├── fetch-diff.ts              # 从 Phabricator 获取 diff
│   ├── fetch-commit-changes.ts    # 从 Git 获取 commit 变更
│   ├── review-diff.ts             # 代码审查工具
│   ├── analyze-test-matrix.ts     # 分析测试矩阵（Phabricator）
│   ├── analyze-commit-test-matrix.ts # 分析测试矩阵（Git）
│   ├── generate-tests.ts          # 生成测试用例
│   ├── write-test-file.ts         # 写入测试文件
│   ├── run-tests.ts               # 执行测试
│   ├── publish-comments.ts        # 发布审查评论
│   └── base-analyze-test-matrix.ts # 共享分析基类
├── clients/               # 外部服务客户端
│   ├── openai.ts         # OpenAI LLM 客户端
│   ├── phabricator.ts    # Phabricator API 客户端
│   └── embedding.ts      # Embedding 客户端
├── orchestrator/          # 工作流编排
├── utils/                 # 工具函数
│   ├── response-formatter.ts # MCP 响应格式化（统一）
│   ├── diff-parser.ts    # Diff 解析和格式化
│   └── logger.ts         # 日志工具
├── cache/                 # 缓存管理
├── state/                 # 状态管理
└── config/                # 配置加载和验证
```

### 关键设计模式

#### 1. 三层架构
- **传输层 (Transport)**: MCP 协议通信
- **工具层 (Tool)**: 原子化、可组合的工具
- **智能体层 (Agent)**: ReAct 模式智能体

#### 2. 共享逻辑提取
- `src/tools/base-analyze-test-matrix.ts` - 测试矩阵分析的共享基类，减少 85% 代码重复
- `src/utils/response-formatter.ts` - 统一的 MCP 响应格式化

#### 3. 增量去重机制
- 使用 Diff 指纹和 Embedding 相似度计算
- 避免重复生成相同的评论或测试
- 支持增量模式和全量模式

#### 4. NEW_LINE_xxx 行号格式
- **问题**: AI 容易混淆旧行号和新行号
- **解决**: 使用 `NEW_LINE_xxx` 明确标记新行，使用 `DELETED (was line xxx)` 标记已删除行
- **位置**: `src/utils/diff-parser.ts:generateNumberedDiff`

## 核心工作流

### 工作流 1: 代码审查流程
```typescript
fetch-diff → review-frontend-diff → (可选) publish-comments
```

### 工作流 2: 测试生成流程
```typescript
// Phabricator 模式
fetch-diff → analyze-test-matrix → generate-tests → write-test-file

// Git Commit 模式
fetch-commit-changes → analyze-commit-test-matrix → generate-tests → write-test-file
```

### 工作流 3: 完整 CI/CD
```typescript
fetch-commit-changes → analyze-commit-test-matrix → generate-tests → write-test-file → run-tests
```

### 工作流 4: n8n + GitLab 测试生成
```typescript
// n8n 工作流
[GitLab: Get MR Diff] → [MCP: generate-tests-from-raw-diff] → [GitLab: Post Comment]
```

**注意**：代码审查（CR）仅支持 Phabricator，因为需要 diffId 才能发布评论，且行号映射更准确。

## 关键工具

### 代码获取
- **fetch-diff**: 从 Phabricator 获取完整 diff 内容
- **fetch-commit-changes**: 从 Git 仓库获取 commit 变更

### 代码分析
- **review-frontend-diff**: 多维度智能审查（React/TypeScript/性能/安全等）
- **analyze-test-matrix**: 分析功能清单和测试矩阵
- **analyze-commit-test-matrix**: 基于 commit 的分析

### 生成和执行
- **generate-tests**: 生成单元测试代码
- **write-test-file**: 将测试写入文件
- **run-tests**: 执行测试命令

### 发布和集成
- **publish-comments**: 发布审查评论到 Phabricator

### n8n Test Generation
- **analyze-raw-diff-test-matrix**: 接受外部 raw diff，分析功能与测试矩阵（GitLab/GitHub 集成）
- **generate-tests-from-raw-diff**: 一次调用完成 raw diff 分析与测试生成，适合 n8n 工作流

## 重要文件

### 配置文件
- `config.yaml` - 主配置（LLM、Embedding、Orchestrator 设置）
- `.env.example` - 环境变量模板
- `tsconfig.json` - TypeScript 配置（严格模式）
- `tsup.config.ts` - 构建配置

### 文档
- `README.md` - 完整使用指南和 API 文档
- `N8N_GITLAB_INTEGRATION.md` - n8n + GitLab 集成文档（测试生成专用）
- `WORKFLOW_EXAMPLES.md` - 完整工作流示例
- `ARCHITECTURE_REDESIGN.md` - 架构设计文档（ReAct 模式规划）
- `IMPLEMENTATION_SUMMARY.md` - 实施总结和问题修复

## 关键技术点

### 1. 项目根目录检测
- 自动检测 Monorepo 结构（pnpm/yarn/npm workspaces, Lerna, Nx, Rush）
- 关键位置：`src/tools/resolve-path.ts`
- 如果自动检测失败，需手动传入 `projectRoot` 参数

### 2. 测试框架检测
- 自动识别 Vitest 或 Jest
- 关键位置：`src/tools/detect-stack.ts`
- 根据框架调整测试生成策略

### 3. 缓存策略
- Diff 缓存：避免重复获取相同 diff
- 状态缓存：存储测试矩阵和分析结果
- 位置：`src/cache/cache.ts`, `src/state/manager.ts`

### 4. 行号验证
- 使用 `findNewLineNumber()` 验证评论行号是否在新文件中存在
- 过滤无效行号，避免发布到已删除的行
- 关键位置：`src/tools/review-diff.ts`

## 开发注意事项

### 1. 调试日志
- 日志文件：`logs/fe-testgen-mcp.log`
- 使用 `logger` 工具进行结构化日志记录
- 关键位置：`src/utils/logger.ts`

### 2. 错误处理
- 所有工具都有完整的错误处理和日志记录
- 统一通过 `formatErrorResponse` 返回错误
- 关键位置：`src/utils/response-formatter.ts`

### 3. 性能优化
- 多 Agent 并行执行
- 智能缓存减少重复请求
- 批量处理和合并操作

### 4. 测试框架
- 使用 Vitest 进行单元测试
- 命令：`npm run test`
- 测试文件命名：`*.test.ts` 或 `*.spec.ts`

## 常见问题

### 1. 项目根目录检测失败
- 手动传入 `projectRoot` 参数（使用 `pwd` 获取绝对路径）
- 确保项目包含 `package.json`

### 2. API 调用失败
- 检查 `OPENAI_API_KEY` 是否正确
- 验证 `PHABRICATOR_HOST` 和 `PHABRICATOR_TOKEN` 是否有效

### 3. 缓存问题
- 使用 `forceRefresh: true` 强制刷新缓存
- 或手动删除 `.cache` 目录

## 扩展开发

### 添加新的审查维度
1. 在 `src/agents/cr/` 下创建新文件
2. 继承 `BaseAgent` 类
3. 实现 `analyze` 方法
4. 在 `src/agents/cr/index.ts` 中导出

### 添加新的测试场景
1. 在 `src/agents/tests/` 下创建新文件
2. 实现特定场景的测试生成逻辑
3. 在 `generate-tests` 工具中集成

### 支持新的 VCS
1. 创建新的 fetch 工具（如 `fetch-pr-changes.ts`）
2. 实现 `CodeChangeSource` 接口
3. 创建对应的分析工具

## 架构演进

当前架构正向 ReAct 模式演进：
- **当前**: 线性工具调用
- **目标**: 智能体自主决策（Thought → Action → Observation）
- **参考**: `ARCHITECTURE_REDESIGN.md` 了解详细规划

## 许可证

MIT License
