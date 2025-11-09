# n8n 集成指南

本文档介绍如何在 n8n 工作流中使用 fe-testgen-mcp 的 Raw Diff 集成工具。

## 目录

- [概述](#概述)
- [前置条件](#前置条件)
- [工具说明](#工具说明)
- [使用场景](#使用场景)
- [GitLab MR 自动化](#gitlab-mr-自动化)
- [GitHub PR 自动化](#github-pr-自动化)
- [工作流示例](#工作流示例)
- [常见问题](#常见问题)

---

## 概述

n8n 是一个开源的工作流自动化工具，支持通过节点组合实现复杂的自动化流程。本 MCP Server 提供了两个专为 n8n 集成设计的工具：

1. **analyze-raw-diff-test-matrix** - 仅分析测试矩阵（轻量级，用于决策）
2. **generate-tests-from-raw-diff** - 一体化生成单元测试（包含矩阵分析 + 测试生成）

这两个工具接受外部传入的 raw diff 文本，无需依赖 Phabricator，适合与 GitLab、GitHub 等平台集成。

---

## 前置条件

### 1. 安装并运行 MCP Server

```bash
cd fe-testgen-mcp
npm install
npm run build

# 启动 HTTP Streaming 模式（推荐用于 n8n）
TRANSPORT_MODE=httpStream HTTP_PORT=3000 npm start
```

### 2. 配置环境变量

确保以下环境变量已设置：

```bash
# OpenAI API（必需）
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4

# Embedding（可选，用于增强测试生成）
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_MODEL=text-embedding-3-small

# 项目路径（推荐）
PROJECT_ROOT=/path/to/your/project
```

### 3. 验证 MCP Server

```bash
# 测试 MCP 端点
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

应该返回包含 `analyze-raw-diff-test-matrix` 和 `generate-tests-from-raw-diff` 的工具列表。

---

## 工具说明

### analyze-raw-diff-test-matrix

**用途**: 仅分析测试矩阵，返回功能清单和测试场景

**适用场景**:
- 需要先查看测试矩阵，再决定是否生成测试
- 分步式工作流（分析 → 人工审批 → 生成）
- 轻量级预览

**输入参数**:
```typescript
{
  rawDiff: string        // unified diff 格式的文本（必需）
  identifier: string     // 唯一标识符，如 MR ID（必需）
  projectRoot: string    // 项目根目录绝对路径（必需）
  metadata?: {           // 可选元数据
    title?: string
    author?: string
    mergeRequestId?: string
    commitHash?: string
    branch?: string
  }
  forceRefresh?: boolean // 强制刷新缓存（默认 false）
}
```

**返回结果**:
```typescript
{
  identifier: string
  features: FeatureItem[]    // 功能清单
  scenarios: TestScenarioItem[]  // 测试场景
  framework: string          // 检测到的测试框架
  projectRoot: string
  statistics: {              // 统计信息
    totalFeatures: number
    totalScenarios: number
    estimatedTests: number
    featuresByType: Record<string, number>
    scenariosByType: Record<string, number>
  }
}
```

### generate-tests-from-raw-diff

**用途**: 一体化生成单元测试（可选先分析矩阵）

**适用场景**:
- 一次性完成分析 + 单元测试生成
- 自动化 CI/CD 流程
- 快速生成单元测试代码

**输入参数**:
```typescript
{
  rawDiff: string
  identifier: string
  projectRoot: string
  metadata?: {
    title?: string
    author?: string
    mergeRequestId?: string
    commitHash?: string
    branch?: string
  }
  scenarios?: string[]       // 指定测试场景（可选）
  mode?: 'incremental' | 'full'  // 增量或全量模式
  maxTests?: number          // 最大测试数量
  analyzeMatrix?: boolean    // 是否返回测试矩阵（默认 true）
  framework?: 'vitest' | 'jest'  // 测试框架（可选）
}
```

**返回结果**:
```typescript
{
  identifier: string
  tests: TestCase[]          // 生成的测试用例
  framework: string
  projectRoot: string
  summary: {
    totalTests: number
    byScenario: Record<string, number>
    byFile: Record<string, number>
  }
  matrix?: {                 // 可选的测试矩阵
    features: FeatureItem[]
    scenarios: TestScenarioItem[]
    statistics: { ... }
  }
}
```

---

## 使用场景

### 场景 1: GitLab MR 触发测试生成

**工作流**: GitLab MR 创建 → 获取 diff → 分析矩阵 → 生成测试 → 创建 MR 评论

### 场景 2: GitHub PR 自动化

**工作流**: GitHub PR 打开 → 获取 diff → 生成测试 → 提交测试文件 → PR 评论

### 场景 3: 分步式审批流程

**工作流**: 代码变更 → 分析矩阵 → Slack 通知审批 → 人工确认 → 生成测试

---

## GitLab MR 自动化

### 完整工作流示例

```
触发器: GitLab Webhook (MR 事件)
     ↓
步骤 1: 获取 MR Diff
     ↓
步骤 2: 调用 analyze-raw-diff-test-matrix
     ↓
步骤 3: 判断是否需要生成测试
     ↓
步骤 4: 调用 generate-tests-from-raw-diff
     ↓
步骤 5: 写入测试文件到 Git 仓库
     ↓
步骤 6: 在 MR 中添加评论
```

### n8n 节点配置

#### 1. 触发器节点 - GitLab Webhook

**节点类型**: `GitLab Trigger`

**配置**:
- Events: `Merge Request Events`
- Filter: `opened, updated`

**输出数据结构**:
```json
{
  "object_attributes": {
    "id": 123,
    "iid": 456,
    "title": "feat: 添加新功能",
    "description": "...",
    "source_branch": "feature/new-feature",
    "target_branch": "main",
    "author_id": 789,
    "state": "opened"
  }
}
```

#### 2. GitLab 节点 - 获取 MR Diff

**节点类型**: `GitLab` → `Get Merge Request Changes`

**配置**:
```json
{
  "resource": "mergeRequest",
  "operation": "get",
  "projectId": "{{ $('Webhook').item.json.project.id }}",
  "mergeRequestIid": "{{ $('Webhook').item.json.object_attributes.iid }}"
}
```

**输出**:
```json
{
  "changes": [
    {
      "old_path": "src/components/Button.tsx",
      "new_path": "src/components/Button.tsx",
      "diff": "@@ -1,5 +1,10 @@\n import React from 'react';\n+import { useState } from 'react';\n..."
    }
  ]
}
```

#### 3. Code 节点 - 转换 Diff 格式

**节点类型**: `Code`

**JavaScript 代码**:
```javascript
// 将 GitLab changes 转换为 unified diff 格式
const changes = $input.item.json.changes;

let unifiedDiff = '';
for (const change of changes) {
  // GitLab 返回的 diff 已经是 unified diff 格式
  unifiedDiff += change.diff + '\n';
}

return {
  json: {
    rawDiff: unifiedDiff,
    mergeRequestId: $('Webhook').item.json.object_attributes.iid,
    title: $('Webhook').item.json.object_attributes.title,
    author: $('Webhook').item.json.object_attributes.author.name,
    branch: $('Webhook').item.json.object_attributes.source_branch,
    projectId: $('Webhook').item.json.project.id
  }
};
```

#### 4. HTTP Request 节点 - 调用 MCP 工具（分析矩阵）

**节点类型**: `HTTP Request`

**配置**:
```json
{
  "method": "POST",
  "url": "http://localhost:3000/mcp",
  "sendHeaders": true,
  "headerParameters": {
    "Content-Type": "application/json"
  },
  "sendBody": true,
  "bodyParameters": {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "analyze-raw-diff-test-matrix",
      "arguments": {
        "rawDiff": "={{ $json.rawDiff }}",
        "identifier": "MR-{{ $json.mergeRequestId }}",
        "projectRoot": "/path/to/your/project",
        "metadata": {
          "title": "={{ $json.title }}",
          "author": "={{ $json.author }}",
          "mergeRequestId": "={{ $json.mergeRequestId }}",
          "branch": "={{ $json.branch }}"
        }
      }
    }
  }
}
```

#### 5. IF 节点 - 判断是否需要生成测试

**节点类型**: `IF`

**配置**:
```json
{
  "conditions": {
    "number": [
      {
        "value1": "={{ $json.result.statistics.totalFeatures }}",
        "operation": "larger",
        "value2": 0
      }
    ]
  }
}
```

#### 6. HTTP Request 节点 - 生成测试

**节点类型**: `HTTP Request`

**配置**:
```json
{
  "method": "POST",
  "url": "http://localhost:3000/mcp",
  "bodyParameters": {
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "generate-tests-from-raw-diff",
      "arguments": {
        "rawDiff": "={{ $('Code').item.json.rawDiff }}",
        "identifier": "MR-{{ $('Code').item.json.mergeRequestId }}",
        "projectRoot": "/path/to/your/project",
        "metadata": {
          "title": "={{ $('Code').item.json.title }}",
          "author": "={{ $('Code').item.json.author }}",
          "mergeRequestId": "={{ $('Code').item.json.mergeRequestId }}"
        },
        "mode": "incremental",
        "analyzeMatrix": false
      }
    }
  }
}
```

#### 7. Code 节点 - 格式化测试代码

**节点类型**: `Code`

**JavaScript 代码**:
```javascript
const tests = $json.result.tests;
const testsByFile = {};

// 按文件分组
for (const test of tests) {
  if (!testsByFile[test.testFile]) {
    testsByFile[test.testFile] = [];
  }
  testsByFile[test.testFile].push(test);
}

// 生成文件列表
const filesToCommit = [];
for (const [filePath, testCases] of Object.entries(testsByFile)) {
  let content = `import { describe, it, expect } from 'vitest';\n\n`;
  
  for (const test of testCases) {
    content += test.code + '\n\n';
  }
  
  filesToCommit.push({
    file_path: filePath,
    content: content,
    action: 'create'
  });
}

return {
  json: {
    filesToCommit,
    summary: $json.result.summary
  }
};
```

#### 8. GitLab 节点 - 提交测试文件

**节点类型**: `GitLab` → `Create Commit`

**配置**:
```json
{
  "resource": "repository",
  "operation": "createCommit",
  "projectId": "={{ $('Webhook').item.json.project.id }}",
  "branch": "={{ $('Code').item.json.branch }}",
  "commitMessage": "test: 自动生成测试用例",
  "actions": "={{ $json.filesToCommit }}"
}
```

#### 9. GitLab 节点 - 添加 MR 评论

**节点类型**: `GitLab` → `Create MR Note`

**配置**:
```json
{
  "resource": "mergeRequestNote",
  "operation": "create",
  "projectId": "={{ $('Webhook').item.json.project.id }}",
  "mergeRequestIid": "={{ $('Webhook').item.json.object_attributes.iid }}",
  "body": "🤖 **自动生成测试完成**\n\n📊 统计信息：\n- 总测试数：{{ $('Code 2').item.json.summary.totalTests }}\n- 按场景分布：{{ JSON.stringify($('Code 2').item.json.summary.byScenario) }}\n\n✅ 测试文件已提交到分支"
}
```

---

## GitHub PR 自动化

### 工作流示例

与 GitLab 类似，主要区别在于：

1. **触发器**: 使用 `GitHub Trigger` 节点，监听 `pull_request` 事件
2. **获取 Diff**: 使用 GitHub API 获取 PR diff
3. **提交测试**: 使用 GitHub API 创建 commit
4. **PR 评论**: 使用 GitHub API 添加 PR comment

### GitHub 节点配置差异

#### 获取 PR Diff

**节点类型**: `HTTP Request`

**配置**:
```json
{
  "method": "GET",
  "url": "https://api.github.com/repos/{{ $json.repository.full_name }}/pulls/{{ $json.number }}",
  "headers": {
    "Accept": "application/vnd.github.v3.diff",
    "Authorization": "token YOUR_GITHUB_TOKEN"
  }
}
```

#### 创建 Commit

使用 `GitHub` 节点的 `File` → `Create` 操作，或直接使用 GitHub API。

---

## 工作流示例

### 简化版：一键生成测试

如果不需要分步决策，可以使用简化工作流：

```
GitLab MR 触发
    ↓
获取 MR Diff
    ↓
调用 generate-tests-from-raw-diff（一次性完成）
    ↓
写入测试文件
    ↓
添加 MR 评论
```

**核心节点配置**:
```json
{
  "method": "tools/call",
  "params": {
    "name": "generate-tests-from-raw-diff",
    "arguments": {
      "rawDiff": "={{ $json.rawDiff }}",
      "identifier": "MR-{{ $json.mergeRequestId }}",
      "projectRoot": "/path/to/your/project",
      "metadata": {
        "title": "={{ $json.title }}",
        "mergeRequestId": "={{ $json.mergeRequestId }}"
      },
      "analyzeMatrix": true,
      "mode": "incremental",
      "maxTests": 50
    }
  }
}
```

---

## 常见问题

### Q1: 如何获取项目根目录路径？

**方案 1**: 在 n8n 工作流中使用环境变量

```javascript
// Code 节点中
const projectRoot = process.env.PROJECT_ROOT || '/home/user/project';
```

**方案 2**: 在 MCP Server 启动时设置环境变量

```bash
PROJECT_ROOT=/path/to/project npm start
```

**方案 3**: 在工作流中动态获取

```javascript
// 如果项目在 GitLab Runner 中
const projectRoot = process.env.CI_PROJECT_DIR;
```

### Q2: 如何处理大型 diff？

**建议**:
1. 设置 `maxTests` 限制生成的测试数量
2. 使用 `mode: 'incremental'` 增量模式
3. 在 n8n 中添加 timeout 配置（HTTP Request 节点）

```json
{
  "timeout": 300000,  // 5 分钟超时
  "sendBody": true,
  "bodyParameters": {
    "params": {
      "arguments": {
        "maxTests": 30,
        "mode": "incremental"
      }
    }
  }
}
```

### Q3: 如何处理错误？

在 n8n 中使用 `Error Trigger` 节点捕获错误：

```
主工作流 → [失败] → Error Trigger → Slack 通知
```

### Q4: 如何验证生成的测试？

添加额外的验证步骤：

```
生成测试
    ↓
写入到临时分支
    ↓
运行测试（使用 run-tests 工具）
    ↓
如果通过 → 合并到目标分支
    ↓
如果失败 → 通知开发者
```

### Q5: MCP Server 如何部署？

**开发环境**: 本地运行
```bash
npm start -- --transport=httpStream
```

**生产环境**: 使用 Docker 或 systemd 服务

**Docker 示例**:
```dockerfile
FROM node:18
WORKDIR /app
COPY . .
RUN npm install && npm run build
CMD ["npm", "start", "--", "--transport=httpStream"]
EXPOSE 3000
```

**n8n 配置**:
- 使用 Docker Compose 将 n8n 和 MCP Server 放在同一网络
- n8n 通过 `http://mcp-server:3000/mcp` 访问

### Q6: 如何调试 n8n 工作流？

1. **使用 n8n 的执行日志**: 查看每个节点的输入输出
2. **添加 Debug 节点**: 在关键步骤后添加，打印中间数据
3. **MCP Server 日志**: 查看 MCP Server 的控制台输出
4. **使用 Postman 测试**: 先用 Postman 测试 MCP 调用，确保参数正确

---

## 最佳实践

### 1. 缓存策略

MCP Server 会自动缓存分析结果，建议：
- 首次分析使用 `forceRefresh: false`（默认）
- 手动触发时使用 `forceRefresh: true`

### 2. 错误处理

在 n8n 中添加错误处理节点：
```javascript
try {
  // 调用 MCP
} catch (error) {
  // 发送通知
  // 记录日志
  // 回退策略
}
```

### 3. 性能优化

- **并行处理**: 对于多个 MR，使用 n8n 的并行执行
- **批量处理**: 将多个小 diff 合并后再分析
- **增量模式**: 优先使用 `mode: 'incremental'`

### 4. 安全性

- **API Token**: 使用 n8n 的凭证系统管理 GitLab/GitHub token
- **MCP Server**: 部署在内网，不对外暴露
- **环境变量**: 敏感信息（OpenAI API Key）通过环境变量传递

### 5. 监控和告警

- 记录每次工具调用的耗时
- 监控失败率
- 设置 Slack/Email 告警

---

## 完整示例工作流 JSON

以下是一个完整的 n8n 工作流 JSON（可直接导入 n8n）：

```json
{
  "name": "GitLab MR 自动测试生成",
  "nodes": [
    {
      "parameters": {
        "events": ["merge_request_events"],
        "repository": "your-repo"
      },
      "name": "GitLab Trigger",
      "type": "n8n-nodes-base.gitLabTrigger",
      "position": [250, 300]
    },
    {
      "parameters": {
        "url": "http://localhost:3000/mcp",
        "method": "POST",
        "bodyParameters": {
          "parameters": [
            {
              "name": "jsonrpc",
              "value": "2.0"
            },
            {
              "name": "id",
              "value": "1"
            },
            {
              "name": "method",
              "value": "tools/call"
            },
            {
              "name": "params",
              "value": "={{ { \"name\": \"generate-tests-from-raw-diff\", \"arguments\": { \"rawDiff\": $json.diff, \"identifier\": \"MR-\" + $json.iid, \"projectRoot\": \"/path/to/project\" } } }}"
            }
          ]
        },
        "options": {
          "timeout": 300000
        }
      },
      "name": "Generate Tests",
      "type": "n8n-nodes-base.httpRequest",
      "position": [450, 300]
    }
  ],
  "connections": {
    "GitLab Trigger": {
      "main": [
        [
          {
            "node": "Generate Tests",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  }
}
```

---

## 总结

通过 n8n 集成 fe-testgen-mcp 的 Raw Diff 工具，可以实现：

✅ **自动化测试生成**: MR/PR 创建时自动生成测试  
✅ **质量保障**: 确保每次代码变更都有相应的测试  
✅ **开发者友好**: 减少手动编写测试的工作量  
✅ **灵活配置**: 支持分步决策和一键生成两种模式  

如有更多问题，请参考主 README 或提交 Issue。
