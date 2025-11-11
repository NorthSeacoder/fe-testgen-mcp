# 验证指南 - CodeSnippet 解析功能

## 问题描述

在对 D549461 进行 CR 时，11 条评论全部被跳过，提示"评论已存在（去重）"，但 Phabricator 上实际没有任何评论。

## 根本原因

1. **ReviewAgent 返回的 Issue 只有 `codeSnippet`，没有 `line`**
   - 各个 CR Agent 按照 prompt 指示返回代码片段
   - LLM 没有返回行号（因为 prompt 建议使用 codeSnippet）

2. **PublishPhabricatorCommentsTool 要求必须有 `line`**
   - 第 242 行检查 `if (lineNumber)`
   - 没有行号的 Issue 在第 229-238 行被跳过

## 修复内容

### 修改的文件
`src/tools/publish-phabricator-comments.ts`

### 关键改动

#### 1. 导入解析函数
```typescript
import { parseDiff, findLineNumberByCodeSnippet } from '../utils/diff-parser.js';
```

#### 2. 获取 diff 数据（第 152-162 行）
```typescript
let diffData: ReturnType<typeof parseDiff> | null = null;
try {
  const diffResult = await this.phabricator.getDiffWithContext(revisionId, 5);
  diffData = parseDiff(diffResult.raw, revisionId);
  logger.info('[PublishPhabricatorCommentsTool] Loaded diff for code snippet matching', {
    filesCount: diffData.files.length,
  });
} catch (error) {
  logger.warn('[PublishPhabricatorCommentsTool] Failed to load diff for code snippet matching', { error });
}
```

#### 3. 解析行号（第 198-226 行）
```typescript
// 🔧 解析行号：优先使用 issue.line，如果没有则从 codeSnippet 解析
let lineNumber = issue.line;
if (!lineNumber && issue.codeSnippet && diffData) {
  const file = diffData.files.find(f => f.path === issue.file);
  if (file) {
    const resolvedLine = findLineNumberByCodeSnippet(file, issue.codeSnippet, {
      fuzzyMatch: true,
      preferAddedLines: true,
    });
    if (resolvedLine) {
      lineNumber = resolvedLine;
      logger.info('[PublishPhabricatorCommentsTool] Resolved line number from code snippet', {
        file: issue.file,
        codeSnippet: issue.codeSnippet.substring(0, 50),
        resolvedLine,
      });
    }
  }
}
```

#### 4. 统一使用 `lineNumber` 变量
- 去重检查使用 `lineNumber`（第 251、259、264、270 行）
- 发布时使用 `lineNumber`（第 294、302、308、315、325 行）

## 验证步骤

### 1. 检查编译
```bash
npm run build
```
✅ 应该编译成功，无错误

### 2. 检查日志关键词

重新对 D549461 进行 CR 后，查看日志应该包含：

**成功解析行号的日志**：
```
[PublishPhabricatorCommentsTool] Loaded diff for code snippet matching
[PublishPhabricatorCommentsTool] Resolved line number from code snippet
```

**如果解析失败**：
```
[PublishPhabricatorCommentsTool] Failed to resolve line number from code snippet
[PublishPhabricatorCommentsTool] Skipping issue without line number
```

### 3. 检查发布结果

预期结果：
- ✅ 评论应该成功发布（不再全部跳过）
- ✅ 日志显示 "published: X"（X > 0）
- ✅ Phabricator 上能看到 inline comments

### 4. 检查 Issue 数据

可以在 ReviewAgent 执行后打印 Issue 数据：
```typescript
logger.info('Issue data', {
  file: issue.file,
  line: issue.line,           // 可能为 undefined
  codeSnippet: issue.codeSnippet,  // 应该有值
  message: issue.message,
});
```

## 常见问题排查

### Q1: 所有评论仍然被跳过

**可能原因**：
1. `codeSnippet` 无法匹配到 diff 中的任何行
2. diff 数据获取失败
3. 文件路径不匹配

**排查方法**：
```bash
# 查看日志中是否有这些警告
grep "Failed to resolve line number" logs/fe-testgen-mcp.log
grep "File not found in diff" logs/fe-testgen-mcp.log
grep "Failed to load diff" logs/fe-testgen-mcp.log
```

### Q2: 部分评论被跳过

**可能原因**：
1. 某些 `codeSnippet` 太短或太模糊，无法精确匹配
2. 代码片段不在 diff 的可见范围内

**解决方法**：
- 检查被跳过的 Issue 的 `codeSnippet` 是否有特征
- 考虑调整 `findLineNumberByCodeSnippet` 的匹配参数

### Q3: 行号匹配错误

**可能原因**：
1. 代码片段在多个地方出现
2. 匹配到了上下文行而不是新增行

**解决方法**：
- 检查日志中的 `resolvedLine` 是否正确
- `preferAddedLines: true` 已经优先匹配新增行
- 可以调整 `fuzzyMatch` 参数

## 技术细节

### findLineNumberByCodeSnippet 匹配策略

1. **精确匹配**（得分 100）
   - 代码片段完全匹配某一行

2. **模糊匹配**（得分 80）
   - 移除所有空格后匹配

3. **部分匹配**（得分 0-60）
   - 至少 60% 的关键词匹配

4. **优先级排序**
   - 得分高的优先
   - 新增行（ADDED）优先于上下文行（CONTEXT）
   - 行号较小的优先

### 日志级别

- `info`: 成功解析行号
- `warn`: 解析失败、文件未找到
- `debug`: 去重检查、发布详情

## 相关文档

- `CODE_SNIPPET_MIGRATION_FIX.md` - 详细的修复文档
- `src/utils/diff-parser.ts` - 行号解析实现
- `src/utils/code-snippet-matching.test.ts` - 匹配算法测试

---

**创建日期**: 2025-11-11  
**状态**: ✅ 修复完成，待验证

