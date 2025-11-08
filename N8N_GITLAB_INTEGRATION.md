# n8n + GitLab 集成优化

## 概述

针对 n8n 工作流与 GitLab 集成场景，新增了**两个专用 MCP 工具**用于测试生成，无需依赖 Phabricator 或本地 Git 操作，直接接受外部传入的 diff 内容。

> ⚠️ **关于代码审查（CR）**：  
> 代码审查功能目前仅支持 Phabricator 场景（使用 `review-frontend-diff` 工具）。  
> 原因：
> 1. Phabricator 的 diff 格式更标准，行号信息更准确
> 2. 发布评论到 Phabricator 需要 diffId（必须通过 Phabricator API 获取）
> 3. 外部传入的 diff 可能存在格式不一致导致行号偏移
>
> 如需对 GitLab MR 进行代码审查，建议：
> - 方案 A：在 n8n 中实现轻量级的规则检查（ESLint/Prettier）
> - 方案 B：通过 GitLab CI/CD 触发 MCP 工具，直接在项目仓库中执行
> - 方案 C：等待后续支持（需要增强 diff 解析和行号映射的准确性）

## 新增工具

### 1. `analyze-raw-diff-test-matrix`

从外部传入的 raw diff 内容分析测试矩阵。

#### 输入参数

```json
{
  "rawDiff": "string (必需)",          // Unified diff 格式的原始文本
  "identifier": "string (必需)",       // 唯一标识符（如 MR-123）
  "projectRoot": "string (必需)",      // 项目根目录绝对路径
  "metadata": {                         // 可选元数据
    "title": "MR 标题",
    "author": "作者名",
    "mergeRequestId": "123",
    "commitHash": "abc123",
    "branch": "feature/xyz"
  },
  "forceRefresh": false                 // 是否强制刷新缓存
}
```

#### 输出结果

```json
{
  "matrix": {
    "features": [...],                  // 功能清单
    "scenarios": [...],                 // 测试场景
    "summary": {
      "totalFeatures": 3,
      "totalScenarios": 8,
      "estimatedTests": 15,
      "coverage": {...}
    }
  },
  "metadata": {
    "diffId": "123",
    "revisionId": "MR-123",
    "framework": "vitest",
    "duration": 5234
  }
}
```

---

### 2. `generate-tests-from-raw-diff`

一次调用完成 diff 分析 + 测试生成（端到端工具）。

#### 输入参数

```json
{
  "rawDiff": "string (必需)",
  "identifier": "string (必需)",
  "projectRoot": "string (必需)",
  "metadata": {
    "title": "MR 标题",
    "author": "作者名",
    "mergeRequestId": "123",
    "commitHash": "abc123",
    "branch": "feature/xyz"
  },
  "scenarios": ["happy-path", "edge-case"],  // 可选，手动指定测试场景
  "mode": "incremental",                     // 或 "full"
  "maxTests": 10,                            // 可选，限制最大测试数量
  "analyzeMatrix": true,                     // 是否先分析矩阵（默认 true）
  "forceRefresh": false
}
```

#### 输出结果

```json
{
  "identifiedScenarios": ["happy-path", "edge-case", "error-path"],
  "tests": [
    {
      "id": "...",
      "file": "src/components/Button.tsx",
      "testFile": "src/components/Button.test.tsx",
      "testName": "Button renders correctly",
      "code": "describe('Button', () => {...});",
      "framework": "vitest",
      "scenario": "happy-path",
      "confidence": 0.85
    }
  ],
  "metadata": {
    "stack": { "unit": "vitest" },
    "embeddingUsed": true,
    "duration": 12345
  }
}
```

---

## n8n 工作流设计

### 方案 A：分步式（灵活控制）

```
[GitLab Trigger: MR Created/Updated]
  ↓
[GitLab Node: Get MR Diff]
  ↓ (输出: rawDiff, MR metadata)
[MCP Node: analyze-raw-diff-test-matrix]
  ↓ (输出: test matrix)
[Code Node: 根据 matrix 决策]
  ↓
[MCP Node: generate-tests-from-raw-diff]
  ↓ (输出: tests[])
[Code Node: 格式化为 GitLab 评论格式]
  ↓
[GitLab Node: Post MR Comment]
```

**优点**：
- 可以在分析后决定是否继续生成测试
- 可以根据功能数量、场景复杂度调整策略
- 便于调试和监控每个步骤

---

### 方案 B：端到端式（简洁高效）

```
[GitLab Trigger: MR Created/Updated]
  ↓
[GitLab Node: Get MR Diff]
  ↓ (输出: rawDiff, MR metadata)
[MCP Node: generate-tests-from-raw-diff]
  ↓ (输出: tests[])
[Code Node: 格式化为 GitLab 评论格式]
  ↓
[GitLab Node: Post MR Comment]
```

**优点**：
- 节点少，配置简单
- 一次 LLM 调用完成所有工作
- 适合标准化流程

---

## 示例：n8n 节点配置

### MCP 节点配置（analyze-raw-diff-test-matrix）

```json
{
  "toolName": "analyze-raw-diff-test-matrix",
  "parameters": {
    "rawDiff": "{{ $json.diff }}",
    "identifier": "MR-{{ $json.iid }}",
    "projectRoot": "/home/runner/work/my-project",
    "metadata": {
      "title": "{{ $json.title }}",
      "author": "{{ $json.author.username }}",
      "mergeRequestId": "{{ $json.iid }}",
      "branch": "{{ $json.source_branch }}"
    }
  }
}
```

### MCP 节点配置（generate-tests-from-raw-diff）

```json
{
  "toolName": "generate-tests-from-raw-diff",
  "parameters": {
    "rawDiff": "{{ $json.diff }}",
    "identifier": "MR-{{ $json.iid }}",
    "projectRoot": "/home/runner/work/my-project",
    "metadata": {
      "title": "{{ $json.title }}",
      "author": "{{ $json.author.username }}",
      "mergeRequestId": "{{ $json.iid }}",
      "branch": "{{ $json.source_branch }}"
    },
    "mode": "incremental",
    "maxTests": 10,
    "analyzeMatrix": true
  }
}
```

### Code 节点：格式化 GitLab 评论

```javascript
// 将测试代码转换为 Markdown 格式
const tests = $input.item.json.tests;
const markdown = tests.map(test => {
  return `### ${test.testName}\n\n` +
         `**文件**: \`${test.file}\`\n` +
         `**测试文件**: \`${test.testFile}\`\n` +
         `**场景**: ${test.scenario}\n` +
         `**置信度**: ${(test.confidence * 100).toFixed(0)}%\n\n` +
         `\`\`\`typescript\n${test.code}\n\`\`\`\n`;
}).join('\n---\n\n');

return {
  json: {
    note: `## 🧪 测试代码生成报告\n\n${markdown}`,
    noteable_type: 'MergeRequest',
    noteable_id: $json.iid
  }
};
```

---

## 与 Phabricator 工作流的对比

### Phabricator 工作流（原有）

```
[MCP: fetch-diff]
  ↓
[MCP: analyze-test-matrix]
  ↓
[MCP: generate-tests]
  ↓
[MCP: write-test-file]
  ↓
[MCP: publish-phabricator-comments]
```

### GitLab + n8n 工作流（新增）

```
[n8n GitLab: Get MR Diff]
  ↓
[MCP: generate-tests-from-raw-diff]
  ↓
[n8n GitLab: Post MR Comment]
```

**关键差异**：
- ❌ 不再需要 `fetch-diff`（n8n GitLab 节点处理）
- ❌ 不再需要 `publish-phabricator-comments`（n8n GitLab 节点处理）
- ✅ 新增 `analyze-raw-diff-test-matrix` 和 `generate-tests-from-raw-diff`
- ✅ 保留 `write-test-file` 和 `run-tests` 用于本地写入和测试执行

---

## 技术细节

### Diff 格式要求

工具接受标准的 **Unified Diff** 格式，GitLab API 返回的 diff 通常符合此格式：

```diff
diff --git a/src/components/Button.tsx b/src/components/Button.tsx
index abc123..def456 100644
--- a/src/components/Button.tsx
+++ b/src/components/Button.tsx
@@ -10,6 +10,7 @@ export const Button = () => {
   return (
     <button
+      className="btn-primary"
       onClick={handleClick}
     >
```

### 前端文件过滤

自动过滤以下扩展名的文件：
- `.js`, `.jsx`
- `.ts`, `.tsx`
- `.vue`
- `.css`, `.scss`, `.less`

### 测试框架检测

自动检测项目使用的测试框架：
- Vitest（优先）
- Jest（回退）

根据检测结果调整生成的测试代码风格。

---

## 缓存和增量模式

### 缓存机制

- 基于 diff 指纹（文件路径 + 增删行数的 hash）
- 相同 diff 会复用已分析的测试矩阵
- 使用 `forceRefresh: true` 可强制刷新

### 增量模式

```json
{
  "mode": "incremental"
}
```

- 仅生成新的测试，过滤已有测试
- 避免重复提交相同测试代码
- 适合 MR 多次更新的场景

---

## 故障排查

### 问题 1：找不到前端文件

**错误信息**：
```
No frontend files found in diff. Total files: 5. Frontend file extensions: .js, .jsx, .ts, .tsx, .vue, .css, .scss, .less
```

**解决方案**：
- 检查 diff 是否包含前端文件变更
- 确认文件扩展名是否在支持列表中
- 如果是其他类型文件，可以在 `src/schemas/diff.ts` 中添加支持

### 问题 2：项目根目录检测失败

**错误信息**：
```
无法检测到项目根目录
```

**解决方案**：
- **必须**显式传入 `projectRoot` 参数
- 使用绝对路径，例如 `/home/runner/work/my-project`
- 确保路径下包含 `package.json`

### 问题 3：测试矩阵为空

**错误信息**：
```
No feature changes detected
```

**可能原因**：
1. diff 中没有功能性变更（仅格式调整或注释）
2. AI 分析失败

**解决方案**：
- 检查日志 `logs/fe-testgen-mcp.log`
- 使用 `forceRefresh: true` 重试
- 尝试增加 diff 内容（更多文件变更）

---

## 性能优化建议

### 1. 合理使用缓存

```json
{
  "forceRefresh": false  // 默认使用缓存
}
```

相同 MR 的多次更新会复用缓存。

### 2. 限制测试数量

```json
{
  "maxTests": 10  // 避免生成过多测试
}
```

按置信度排序，只保留最重要的测试。

### 3. 手动指定场景

```json
{
  "scenarios": ["happy-path", "error-path"]  // 跳过 AI 场景识别
}
```

节省 LLM 调用开销。

---

## 未来扩展

### 计划中的功能

1. **支持 GitHub PR**
   - 添加 GitHub API 集成
   - 统一 diff 格式处理

2. **智能评论发布**
   - 将生成的测试代码分文件发布到 MR
   - 支持 inline comments

3. **测试覆盖率分析**
   - 集成 coverage 工具
   - 生成覆盖率报告

4. **自定义模板**
   - 支持项目级测试模板
   - 根据项目规范生成测试

---

## 相关文档

- [README.md](./README.md) - 完整项目文档
- [WORKFLOW_EXAMPLES.md](./WORKFLOW_EXAMPLES.md) - 工作流示例
- [ARCHITECTURE_REDESIGN.md](./ARCHITECTURE_REDESIGN.md) - 架构设计

---

## 反馈和支持

如有问题或建议，请查看日志文件 `logs/fe-testgen-mcp.log` 并提交 issue。
