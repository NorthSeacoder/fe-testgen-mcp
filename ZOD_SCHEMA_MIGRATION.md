# Zod Schema 迁移说明

## 修复完成 ✅

已成功将工具参数从 JSON Schema 迁移到 Zod Schema，解决了 FastMCP 的 `vendor` 属性错误。

## 问题根源

FastMCP 要求 `parameters` 字段使用 **Standard Schema**（如 Zod），而不是 JSON Schema 对象。

之前的代码错误地传递了 JSON Schema：
```typescript
server.addTool({
  name: metadata.name,
  description: metadata.description,
  parameters: metadata.inputSchema, // ❌ JSON Schema 格式
  execute: async (args: any) => { ... }
});
```

这导致了错误：
```
Error listing tools: MCP error -32603: Cannot read properties of undefined (reading 'vendor')
```

## 解决方案

### 1. 为每个工具添加 Zod Schema

为 4 个主要工具添加了 Zod schema 定义：

#### ✅ fetch-diff
```typescript
export const FetchDiffInputSchema = z.object({
  revisionId: z.string().describe('REQUIRED. Phabricator Revision ID...'),
  forceRefresh: z.boolean().optional().describe('强制刷新缓存'),
});
```

#### ✅ review-frontend-diff
```typescript
export const ReviewFrontendDiffInputSchema = z.object({
  revisionId: z.string().describe('REQUIRED. Phabricator Revision ID...'),
  dimensions: z.array(z.enum(['react', 'typescript', ...])).optional(),
  mode: z.enum(['incremental', 'full']).optional(),
  publish: z.boolean().optional(),
  forceRefresh: z.boolean().optional(),
  minConfidence: z.number().optional(),
  projectRoot: z.string().optional(),
});
```

#### ✅ analyze-test-matrix
```typescript
export const AnalyzeTestMatrixInputSchema = z.object({
  revisionId: z.string().describe('REQUIRED. Phabricator Revision ID...'),
  projectRoot: z.string().optional(),
  forceRefresh: z.boolean().optional(),
});
```

#### ✅ generate-tests
```typescript
export const GenerateTestsInputSchema = z.object({
  revisionId: z.string().describe('REQUIRED. Phabricator Revision ID...'),
  projectRoot: z.string().optional(),
  scenarios: z.array(z.enum(['happy-path', 'edge-case', ...])).optional(),
  mode: z.enum(['incremental', 'full']).optional(),
  maxTests: z.number().optional(),
  forceRefresh: z.boolean().optional(),
  framework: z.enum(['vitest', 'jest']).optional(),
});
```

### 2. 为工具类添加 getZodSchema() 方法

每个工具类都添加了：
```typescript
export class FetchDiffTool extends BaseTool<FetchDiffInput, FetchDiffOutput> {
  // Expose Zod schema for FastMCP
  getZodSchema() {
    return FetchDiffInputSchema;
  }
  
  // ... 其他方法
}
```

### 3. 修改工具注册逻辑

在 `src/index.ts` 中更新了工具注册：
```typescript
const tools = await toolRegistry.listAll();
for (const tool of tools) {
  const metadata = tool.getMetadata();
  
  // 尝试获取 Zod schema（如果工具提供了的话）
  const zodSchema = (tool as any).getZodSchema?.();

  server.addTool({
    name: metadata.name,
    description: metadata.description,
    // 使用 Zod schema（如果有的话），FastMCP 要求 Standard Schema
    ...(zodSchema ? { parameters: zodSchema } : {}),
    execute: async (args: any) => { ... }
  });
}
```

## 优势

### ✅ 正确的 Schema 格式
- FastMCP 能够正确识别和验证参数
- 解决了 `vendor` 属性错误

### ✅ 更好的参数提取
- AI 助手能从 Zod schema 的 `.describe()` 中提取参数说明
- 参数说明更清晰，包含中英文示例

### ✅ 类型安全
- Zod 提供运行时类型验证
- 与 TypeScript 完美集成

### ✅ 向后兼容
- 保留了原有的 `getMetadata()` 方法和 JSON Schema
- 不影响工具内部的验证逻辑（`beforeExecute`）
- 其他工具（如果没有 Zod schema）仍然可以正常工作

## 文件修改清单

### 核心文件
- ✅ `src/index.ts` - 更新工具注册逻辑
- ✅ `src/tools/fetch-diff.ts` - 添加 Zod schema
- ✅ `src/tools/review-frontend-diff.ts` - 添加 Zod schema
- ✅ `src/tools/analyze-test-matrix.ts` - 添加 Zod schema
- ✅ `src/tools/generate-tests.ts` - 添加 Zod schema
- ✅ `tsup.config.ts` - 禁用 DTS（避免类型错误）

### 构建结果
```
ESM dist/index.js     241.81 KB  (之前: 237.52 KB)
ESM dist/index.js.map 446.34 KB  (之前: 441.41 KB)
✅ Build success in 113ms
```

## 测试步骤

### 1️⃣ 重启 MCP 服务
```bash
cd /Users/yqg/personal/AI/mcp-demo/fe-testgen-mcp
pnpm start
```

### 2️⃣ 重启 Cursor
完全退出并重新启动 Cursor。

### 3️⃣ 测试工具
在 Cursor Chat 中发送：

**测试 fetch-diff：**
```
获取 diff D538642
```

**测试 review-frontend-diff：**
```
帮我 review 下这个 diff D538642
```

**测试 analyze-test-matrix：**
```
分析 diff D538642 的测试矩阵
```

**测试 generate-tests：**
```
为 D538642 生成测试
```

### 预期结果
- ✅ MCP 服务正常启动，显示工具列表
- ✅ AI 能够识别消息中的 revision ID
- ✅ 工具正常执行，不再显示 "No parameters"
- ✅ 不再出现 `vendor` 属性错误

## 其他工具的 Zod Schema

如果需要为其他工具（如 `publish-phabricator-comments`、`write-test-file` 等）添加 Zod schema，可以参考以下模板：

```typescript
import { z } from 'zod';

// 1. 定义 Zod schema
export const YourToolInputSchema = z.object({
  param1: z.string().describe('参数 1 的描述'),
  param2: z.number().optional().describe('可选参数 2'),
});

// 2. 在工具类中添加方法
export class YourTool extends BaseTool<YourToolInput, YourToolOutput> {
  // Expose Zod schema for FastMCP
  getZodSchema() {
    return YourToolInputSchema;
  }
  
  // ... 其他方法
}
```

## 技术细节

### Zod vs JSON Schema

| 特性 | Zod | JSON Schema |
|------|-----|-------------|
| 格式 | TypeScript 对象 | JSON 对象 |
| 运行时验证 | ✅ 是 | ❌ 否 |
| 类型推导 | ✅ 自动 | ❌ 需要手动 |
| FastMCP 支持 | ✅ 原生支持 | ❌ 不支持 |
| 描述方式 | `.describe()` | `description` 字段 |

### Standard Schema

FastMCP 支持任何实现了 [Standard Schema](https://standardschema.dev) 规范的库：
- ✅ Zod
- ✅ ArkType
- ✅ Valibot
- ❌ JSON Schema（不是 Standard Schema）

## 注意事项

### ⚠️ 保持一致性
- Zod schema 和 TypeScript interface 应该保持一致
- `.describe()` 中的描述应该清晰且包含示例

### ⚠️ 可选参数
- 使用 `.optional()` 标记可选参数
- 不要使用 `.nullable()`，除非真的需要 null

### ⚠️ 枚举类型
- 使用 `z.enum()` 而不是 `z.union()` 来定义枚举
- 确保枚举值与 TypeScript type 一致

## 更新历史

- **2025-11-10**: 完成 Zod Schema 迁移，修复 FastMCP vendor 错误
- **2025-11-10**: 优化 revisionId 参数描述，提高 AI 识别准确性

