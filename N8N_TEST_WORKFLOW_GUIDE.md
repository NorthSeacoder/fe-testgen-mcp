# n8n 测试工具完整调用指南

本文档详细说明如何在 n8n 工作流中调用 fe-testgen-mcp 的测试相关工具。

## 概述

假设您的 MCP 服务地址为：`www.demo.com/mcp`

Git 相关数据（如 diff）在 n8n 的前置节点中获取，然后传递给 MCP 工具。

## 可用的测试工具

fe-testgen-mcp 提供了三个核心测试工具：

| 工具名称 | 功能 | 适用场景 |
|---------|------|---------|
| `analyze-raw-diff-test-matrix` | 分析代码变更，生成测试矩阵 | 预览测试需求、人工审批 |
| `generate-tests-from-raw-diff` | 从 diff 生成单元测试代码 | 自动化生成测试 |
| `run-tests` | 执行测试并返回结果 | 验证生成的测试 |

---

## 完整工作流示例

### 场景：GitLab MR 自动生成并验证测试

```
┌─────────────────────┐
│ GitLab Webhook 触发  │
│  (MR 创建/更新)      │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 步骤1: 获取 MR Diff  │ ← 前置节点，在这里获取 Git 信息
│  (GitLab API)       │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 步骤2: 转换 Diff 格式│
│  (Code 节点)        │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 步骤3: 分析测试矩阵  │ ← 调用 www.demo.com/mcp
│  (analyze-raw-diff) │    工具: analyze-raw-diff-test-matrix
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 步骤4: 判断是否需要  │
│   生成测试           │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 步骤5: 生成测试代码  │ ← 调用 www.demo.com/mcp
│  (generate-tests)   │    工具: generate-tests-from-raw-diff
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 步骤6: 写入测试文件  │
│  (Git 操作)         │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 步骤7: 运行测试验证  │ ← 调用 www.demo.com/mcp
│  (run-tests)        │    工具: run-tests
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 步骤8: 根据测试结果  │
│   创建 MR 评论       │
└─────────────────────┘
```

---

## 详细节点配置

### 步骤 1: 获取 MR Diff (前置节点)

**节点类型**: `GitLab` → `Get Merge Request Changes`

**配置示例**:
```json
{
  "resource": "mergeRequest",
  "operation": "get",
  "projectId": "{{ $('Webhook').item.json.project.id }}",
  "mergeRequestIid": "{{ $('Webhook').item.json.object_attributes.iid }}"
}
```

**输出示例**:
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

---

### 步骤 2: 转换 Diff 格式

**节点类型**: `Code`

> **为什么需要这个步骤？**  
> 不同平台返回的 diff 格式略有差异：
> - **GitLab API** 的 `changes[].diff` 通常只包含 `@@ ... @@` 块，缺少 `diff --git` 头部
> - **Phabricator / 原始 git diff** 通常是完整的 unified diff 格式
> 
> 本步骤会自动检测并统一格式，确保 MCP 工具能正确解析。

**JavaScript 代码**:
```javascript
// 将不同来源的 diff 统一为标准 unified diff 格式
// 支持：GitLab API changes[].diff、git diff 原始输出、Phabricator diff
const changes = $input.item.json.changes || [];
const diffSegments = [];

for (const change of changes) {
  const originalDiff = (change.diff || '').trim();

  if (!originalDiff) {
    continue;
  }

  // 如果已经包含 diff --git 头部，说明是完整的 unified diff，直接使用
  if (/^diff --git\b/m.test(originalDiff)) {
    diffSegments.push(originalDiff.endsWith('\n') ? originalDiff : `${originalDiff}\n`);
    continue;
  }

  // GitLab API 返回的 diff 只有 @@ 块，需要补齐文件头
  const header = [
    `diff --git a/${change.old_path} b/${change.new_path}`,
    `--- a/${change.old_path}`,
    `+++ b/${change.new_path}`,
  ];

  // 如果 diff 内容已经包含 ---/+++ 头部，删除一次以避免重复
  const body = originalDiff.startsWith('--- ')
    ? originalDiff.replace(/^---[^\n]*\n\+\+\+[^\n]*\n/, '')
    : originalDiff;

  diffSegments.push([...header, body].join('\n').trimEnd() + '\n');
}

const rawDiff = diffSegments.join('\n');

// 从 webhook 数据中提取元信息
const mrInfo = $('Webhook').item.json.object_attributes;

return {
  json: {
    rawDiff: rawDiff,
    identifier: `MR-${mrInfo.iid}`,
    projectId: $('Webhook').item.json.project.id,
    metadata: {
      title: mrInfo.title,
      author: mrInfo.author?.name || 'Unknown',
      mergeRequestId: mrInfo.iid.toString(),
      branch: mrInfo.source_branch,
      commitHash: mrInfo.last_commit?.id
    }
  }
};
```

> 🔍 调试提示：可以暂时在代码中加入 `console.log(originalDiff.slice(0, 200))`，先确认上游返回的 diff 是否已经包含 `diff --git` 头部，再决定是否需要转换。

---

### 步骤 3: 分析测试矩阵

**节点类型**: `HTTP Request`

**配置**:
- **Method**: `POST`
- **URL**: `https://www.demo.com/mcp`
- **Authentication**: 根据需要配置
- **Content-Type**: `application/json`

**Body (JSON)**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "analyze-raw-diff-test-matrix",
    "arguments": {
      "rawDiff": "={{ $json.rawDiff }}",
      "identifier": "={{ $json.identifier }}",
      "projectRoot": "/path/to/your/project",
      "metadata": {
        "title": "={{ $json.metadata.title }}",
        "author": "={{ $json.metadata.author }}",
        "mergeRequestId": "={{ $json.metadata.mergeRequestId }}",
        "branch": "={{ $json.metadata.branch }}"
      },
      "forceRefresh": false
    }
  }
}
```

**返回结果示例**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "identifier": "MR-123",
    "features": [
      {
        "file": "src/components/Button.tsx",
        "type": "new_function",
        "description": "添加了新的 onClick 处理逻辑"
      }
    ],
    "scenarios": [
      {
        "scenario": "点击按钮触发事件",
        "type": "behavior",
        "priority": "high"
      }
    ],
    "framework": "vitest",
    "projectRoot": "/path/to/your/project",
    "statistics": {
      "totalFeatures": 3,
      "totalScenarios": 5,
      "estimatedTests": 8
    }
  }
}
```

---

### 步骤 4: 判断是否需要生成测试

**节点类型**: `IF`

**条件配置**:
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

**逻辑**: 
- **True**: 如果有需要测试的功能，继续执行
- **False**: 跳过测试生成，直接结束或添加评论

---

### 步骤 5: 生成测试代码

**节点类型**: `HTTP Request`

**配置**:
- **Method**: `POST`
- **URL**: `https://www.demo.com/mcp`
- **Content-Type**: `application/json`

**Body (JSON)**:
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "generate-tests-from-raw-diff",
    "arguments": {
      "rawDiff": "={{ $('Code').item.json.rawDiff }}",
      "identifier": "={{ $('Code').item.json.identifier }}",
      "projectRoot": "/path/to/your/project",
      "metadata": {
        "title": "={{ $('Code').item.json.metadata.title }}",
        "author": "={{ $('Code').item.json.metadata.author }}",
        "mergeRequestId": "={{ $('Code').item.json.metadata.mergeRequestId }}"
      },
      "mode": "incremental",
      "maxTests": 50,
      "analyzeMatrix": false,
      "framework": "vitest"
    }
  }
}
```

**返回结果示例**:
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "identifier": "MR-123",
    "tests": [
      {
        "testFile": "src/components/__tests__/Button.test.tsx",
        "sourceFile": "src/components/Button.tsx",
        "scenario": "点击按钮触发事件",
        "code": "import { describe, it, expect } from 'vitest';\nimport { Button } from '../Button';\n\ndescribe('Button', () => {\n  it('should handle click event', () => {\n    // test code\n  });\n});"
      }
    ],
    "framework": "vitest",
    "summary": {
      "totalTests": 8,
      "byScenario": {
        "behavior": 5,
        "edge_case": 3
      },
      "byFile": {
        "Button.test.tsx": 8
      }
    }
  }
}
```

---

### 步骤 6: 写入测试文件

**节点类型**: `Code`

**JavaScript 代码**:
```javascript
// 解析生成的测试代码
const result = $json.result;
const tests = result.tests || [];

// 按文件分组测试
const testsByFile = {};
for (const test of tests) {
  if (!testsByFile[test.testFile]) {
    testsByFile[test.testFile] = [];
  }
  testsByFile[test.testFile].push(test);
}

// 准备要提交到 Git 的文件列表
const filesToCommit = [];
for (const [filePath, testCases] of Object.entries(testsByFile)) {
  // 合并同一文件的所有测试
  const allCode = testCases.map(tc => tc.code).join('\n\n');
  
  filesToCommit.push({
    file_path: filePath,
    content: allCode,
    action: 'create' // 或 'update' 如果文件已存在
  });
}

return {
  json: {
    filesToCommit,
    testSummary: result.summary,
    projectId: $('Code').item.json.projectId,
    branch: $('Code').item.json.metadata.branch
  }
};
```

**接下来使用 GitLab 节点提交文件**:

**节点类型**: `GitLab` → `Create Commit`

**配置**:
```json
{
  "resource": "repository",
  "operation": "createCommit",
  "projectId": "={{ $json.projectId }}",
  "branch": "={{ $json.branch }}",
  "commitMessage": "test: 自动生成单元测试 [skip ci]",
  "actions": "={{ $json.filesToCommit }}"
}
```

---

### 步骤 7: 运行测试验证

**节点类型**: `HTTP Request`

**配置**:
- **Method**: `POST`
- **URL**: `https://www.demo.com/mcp`
- **Content-Type**: `application/json`

**Body (JSON)**:
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "run-tests",
    "arguments": {
      "testFiles": [
        "={{ $('Code 1').item.json.filesToCommit[0].file_path }}",
        "={{ $('Code 1').item.json.filesToCommit[1]?.file_path }}"
      ],
      "projectRoot": "/path/to/your/project",
      "framework": "vitest",
      "coverage": false,
      "timeout": 60000
    }
  }
}
```

**说明**:
- `testFiles`: 可以指定具体的测试文件，或者不传（运行所有测试）
- `projectRoot`: 项目根目录路径
- `framework`: 测试框架，vitest 或 jest
- `coverage`: 是否生成覆盖率报告
- `timeout`: 超时时间（毫秒）

**返回结果示例**:
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "success": true,
    "framework": "vitest",
    "summary": {
      "total": 8,
      "passed": 8,
      "failed": 0,
      "skipped": 0,
      "duration": 1234
    },
    "stdout": "Test Files  1 passed (1)...",
    "stderr": "",
    "exitCode": 0
  }
}
```

---

### 步骤 8: 创建 MR 评论

**节点类型**: `Code`

**JavaScript 代码**:
```javascript
const testResult = $json.result;
const testSummary = $('Code 1').item.json.testSummary;

// 构建评论内容
let comment = '## 🤖 自动生成测试完成\n\n';

// 测试生成统计
comment += '### 📊 生成统计\n\n';
comment += `- **总测试数**: ${testSummary.totalTests}\n`;
comment += `- **测试框架**: ${testResult.framework}\n`;
comment += `- **按场景分布**:\n`;
for (const [scenario, count] of Object.entries(testSummary.byScenario)) {
  comment += `  - ${scenario}: ${count}\n`;
}

// 测试执行结果
comment += '\n### ✅ 测试执行结果\n\n';
if (testResult.success) {
  comment += `✅ **所有测试通过** (${testResult.summary.passed}/${testResult.summary.total})\n`;
  comment += `⏱️ 耗时: ${testResult.summary.duration}ms\n`;
} else {
  comment += `❌ **测试失败** (${testResult.summary.failed}/${testResult.summary.total})\n`;
  comment += `\n<details>\n<summary>查看错误详情</summary>\n\n\`\`\`\n${testResult.stderr}\n\`\`\`\n</details>\n`;
}

// 生成的文件列表
comment += '\n### 📝 生成的文件\n\n';
const files = $('Code 1').item.json.filesToCommit;
for (const file of files) {
  comment += `- \`${file.file_path}\`\n`;
}

return {
  json: {
    comment,
    projectId: $('Code').item.json.projectId,
    mergeRequestIid: $('Code').item.json.metadata.mergeRequestId
  }
};
```

**接下来使用 GitLab 节点添加评论**:

**节点类型**: `GitLab` → `Create MR Note`

**配置**:
```json
{
  "resource": "mergeRequestNote",
  "operation": "create",
  "projectId": "={{ $json.projectId }}",
  "mergeRequestIid": "={{ $json.mergeRequestIid }}",
  "body": "={{ $json.comment }}"
}
```

---

## 高级用例

### 用例 1: 测试失败时的自动修复

如果 `run-tests` 返回失败，可以添加额外的流程：

```
run-tests 失败
    ↓
调用 AI 分析失败原因
    ↓
重新生成测试（带上失败信息）
    ↓
再次运行测试
    ↓
如果仍失败，通知开发者
```

**IF 节点判断测试结果**:
```json
{
  "conditions": {
    "boolean": [
      {
        "value1": "={{ $json.result.success }}",
        "operation": "equal",
        "value2": false
      }
    ]
  }
}
```

---

### 用例 2: 分步式人工审批

在生成测试之前，先让人工审批测试矩阵：

```
分析测试矩阵
    ↓
发送 Slack 通知（包含测试矩阵）
    ↓
等待人工审批
    ↓
审批通过 → 生成测试
    ↓
审批拒绝 → 结束流程
```

**Slack 节点示例**:
```json
{
  "channel": "#test-review",
  "text": "测试矩阵分析完成，请审批",
  "attachments": [
    {
      "title": "测试统计",
      "text": "总功能: {{ $json.result.statistics.totalFeatures }}\n预计测试: {{ $json.result.statistics.estimatedTests }}",
      "actions": [
        {
          "name": "approve",
          "text": "批准生成",
          "type": "button",
          "value": "approve"
        },
        {
          "name": "reject",
          "text": "拒绝",
          "type": "button",
          "value": "reject"
        }
      ]
    }
  ]
}
```

---

### 用例 3: 仅运行现有测试（不生成新测试）

如果只想验证现有测试是否通过，可以跳过生成步骤：

```
获取 Git 变更
    ↓
检测影响的测试文件
    ↓
运行相关测试
    ↓
报告结果
```

**检测影响的测试文件 (Code 节点)**:
```javascript
const changes = $input.item.json.changes || [];
const testFiles = [];

for (const change of changes) {
  // 假设测试文件在 __tests__ 目录
  const sourceFile = change.new_path;
  const testFile = sourceFile.replace(/\.tsx?$/, '.test.ts');
  testFiles.push(testFile);
}

return {
  json: {
    testFiles,
    projectRoot: '/path/to/your/project'
  }
};
```

---

## 环境配置

### MCP Server 环境变量

确保 MCP Server 已配置以下环境变量：

```bash
# OpenAI API (必需)
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4

# 项目路径 (推荐)
PROJECT_ROOT=/path/to/your/project

# HTTP Server
HTTP_HOST=0.0.0.0
HTTP_PORT=3000
HTTP_ENDPOINT=/mcp
```

### n8n 环境变量

在 n8n 工作流中，可以使用环境变量：

```javascript
// 在 Code 节点中访问
const mcpUrl = process.env.MCP_SERVER_URL || 'https://www.demo.com/mcp';
const projectRoot = process.env.PROJECT_ROOT || '/home/user/project';
```

---

## 错误处理

### 处理 MCP 调用失败

**在 HTTP Request 节点后添加 IF 节点**:

```json
{
  "conditions": {
    "string": [
      {
        "value1": "={{ $json.error }}",
        "operation": "isEmpty"
      }
    ]
  }
}
```

### 处理测试执行超时

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "run-tests",
    "arguments": {
      "timeout": 300000  // 5分钟超时
    }
  }
}
```

---

## 性能优化建议

### 1. 并行执行

对于多个独立的测试文件，可以使用 n8n 的 Split In Batches 节点并行运行：

```
生成多个测试文件
    ↓
Split In Batches
    ↓
并行运行测试 (每个批次独立)
    ↓
汇总结果
```

### 2. 增量模式

使用 `mode: 'incremental'` 只生成变更相关的测试：

```json
{
  "mode": "incremental",
  "maxTests": 30
}
```

### 3. 缓存策略

首次分析后，MCP Server 会自动缓存结果。除非代码有新变更，否则使用：

```json
{
  "forceRefresh": false
}
```

---

## 调试技巧

### 1. 添加 Debug 节点

在关键步骤后添加 Debug 节点，查看中间数据：

```javascript
console.log('Raw diff:', $json.rawDiff);
console.log('Test result:', JSON.stringify($json.result, null, 2));
return $json;
```

### 2. 使用 Postman 测试

在配置 n8n 之前，先用 Postman 测试 MCP 调用：

```bash
curl -X POST https://www.demo.com/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "run-tests",
      "arguments": {
        "projectRoot": "/path/to/project"
      }
    }
  }'
```

### 3. 查看 MCP Server 日志

检查 MCP Server 的控制台输出，查看详细的执行日志。

---

## 常见问题

### Q1: 如何处理大型项目的测试运行？

**建议**:
- 设置合理的 `timeout` 值（如 5-10 分钟）
- 使用 `testFiles` 参数只运行相关测试
- 考虑在独立的 CI 环境运行测试

### Q2: 测试文件应该提交到哪个分支？

**建议**:
- 提交到 MR 的源分支（feature branch）
- 在 commit message 中添加 `[skip ci]` 避免触发额外的 CI

### Q3: 如何避免重复生成测试？

**建议**:
- 使用 `identifier` 参数（如 MR ID）作为缓存键
- MCP Server 会自动缓存已分析的 diff
- 设置 `forceRefresh: false`（默认值）

### Q4: run-tests 工具需要项目安装测试框架吗？

**是的**。`run-tests` 工具会在项目目录执行 `npx vitest` 或 `npx jest`，因此需要：
- 项目已安装 vitest 或 jest
- 项目有正确的测试配置文件

### Q5: 可以在本地运行 n8n 工作流测试吗？

**可以**。步骤：
1. 在本地启动 MCP Server: `npm start`
2. 使用 `http://localhost:3000/mcp` 作为 URL
3. 在 n8n 中手动触发工作流
4. 检查每个节点的输入输出

---

## 总结

通过上述配置，您可以在 n8n 中完整地调用 fe-testgen-mcp 的测试工具：

1. **analyze-raw-diff-test-matrix**: 分析代码变更，生成测试计划
2. **generate-tests-from-raw-diff**: 自动生成单元测试代码
3. **run-tests**: 执行测试并验证结果

这三个工具可以组合使用，构建完整的自动化测试生成和验证流程。

---

## 参考资源

- [MCP Protocol Specification](https://github.com/modelcontextprotocol/specification)
- [n8n Documentation](https://docs.n8n.io/)
- [完整工作流示例](./N8N_INTEGRATION.md#完整示例工作流-json)
