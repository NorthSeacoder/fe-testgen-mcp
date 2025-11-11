# CodeSnippet 迁移修复文档

## 问题描述

在系统迁移到使用 `codeSnippet` 方式后，`PublishPhabricatorCommentsTool` 没有及时同步更新，导致：

- ✅ ReviewAgent 的各个 CR Agent 已经更新为返回 `codeSnippet` 而不是 `line`
- ✅ Issue schema 已经支持 `codeSnippet` 字段（可选）
- ✅ `findLineNumberByCodeSnippet` 函数已经实现
- ❌ **但是 `PublishPhabricatorCommentsTool` 没有调用该函数来解析行号**

### 具体表现

当 ReviewAgent 返回的 Issue 包含 `codeSnippet` 但缺少 `line` 时：
- 发布工具直接跳过该 Issue
- 日志提示: "Skipping issue without line number"
- 实际上这些 Issue 是可以通过 `codeSnippet` 解析出行号的

## 解决方案

### 修改的文件

**`src/tools/publish-phabricator-comments.ts`**

### 主要改动

#### 1. 导入必要的函数

```typescript
import { parseDiff, findLineNumberByCodeSnippet } from '../utils/diff-parser.js';
```

#### 2. 在发布前获取 diff 数据

```typescript
// 获取 diff 数据（用于 codeSnippet 解析）
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

#### 3. 对每个 Issue 进行行号解析

```typescript
// 解析行号：优先使用 issue.line，如果没有则从 codeSnippet 解析
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
    } else {
      logger.warn('[PublishPhabricatorCommentsTool] Failed to resolve line number from code snippet', {
        file: issue.file,
        codeSnippet: issue.codeSnippet.substring(0, 50),
      });
    }
  }
}
```

#### 4. 简化发布逻辑

- 移除了对 `issue.line` 的多次检查
- 统一使用解析后的 `lineNumber` 变量
- 如果最终没有行号，才跳过该 Issue

## 工作流程

### 修改前

```
Issue (codeSnippet, 无 line) 
  → 检查 issue.line 
  → 为空，跳过发布 ❌
```

### 修改后

```
Issue (codeSnippet, 无 line)
  → 检查 issue.line (无)
  → 从 codeSnippet 解析行号
  → 使用 findLineNumberByCodeSnippet 智能匹配
  → 找到行号，继续发布 ✅
```

## 行号解析特性

`findLineNumberByCodeSnippet` 函数支持：

1. **精确匹配**: 代码片段完全匹配某一行
2. **模糊匹配**: 移除空格后匹配
3. **部分匹配**: 至少 60% 的关键词匹配
4. **优先级排序**: 
   - 得分高的优先
   - 新增行（ADDED）优先于上下文行（CONTEXT）
   - 行号较小的优先

## 其他检查

检查了所有使用 `Issue` 的地方，确认没有其他需要同步更新的代码：

- ✅ `src/tools/review-frontend-diff.ts` - 只做统计，不需要行号
- ✅ `src/state/manager.ts` - 只存储数据，已支持可选的 line 和 codeSnippet
- ✅ `src/orchestrator/pipeline.ts` - 排序时使用 `issue.line ?? 0` 提供默认值
- ✅ `src/agents/cr/*.ts` - 已全部更新为返回 codeSnippet

## 测试验证

- ✅ 代码编译成功（`npm run build`）
- ✅ 无 linter 错误
- ✅ 类型检查通过

## 使用建议

### 对于 CR Agent 开发者

推荐让 LLM 返回 `codeSnippet` 而不是 `line`：

```typescript
// ✅ 推荐
{
  "file": "src/components/Button.tsx",
  "codeSnippet": "const [count] = useState(0)",
  "severity": "high",
  "message": "useState 缺少 setter",
  "suggestion": "应该使用 const [count, setCount] = useState(0)",
  "confidence": 0.9
}

// ❌ 不推荐（容易出错）
{
  "file": "src/components/Button.tsx",
  "line": 42,  // LLM 可能会错误解析行号
  "severity": "high",
  "message": "useState 缺少 setter",
  "suggestion": "应该使用 const [count, setCount] = useState(0)",
  "confidence": 0.9
}
```

### 代码片段选择技巧

1. 选择有特征的代码片段（不要太短，至少 5-10 个字符）
2. 可以是完整的一行，也可以是行的一部分
3. 优先选择问题代码的核心部分（如函数名、变量名、关键语法）
4. 如果是多行问题，选择最有代表性的那一行

## 相关文档

- `ZOD_SCHEMA_MIGRATION.md` - Schema 迁移文档
- `src/agents/base.ts` - BaseAgent 中的 `getCodeSnippetInstructions()` 方法
- `src/utils/diff-parser.ts` - `findLineNumberByCodeSnippet()` 函数实现
- `src/utils/code-snippet-matching.test.ts` - 代码片段匹配测试用例

## 总结

这次修复确保了 `PublishPhabricatorCommentsTool` 与系统的 codeSnippet 迁移保持同步，现在可以：

1. ✅ 自动从 `codeSnippet` 解析行号
2. ✅ 向后兼容直接提供 `line` 的 Issue
3. ✅ 智能匹配，支持精确和模糊匹配
4. ✅ 详细的日志记录，便于调试

## 更新记录

### 2025-11-11 - 第二次修复

**问题**: 用户撤销了第一次修改，使用了带 `CommentDeduplicator` 的版本，但该版本没有 codeSnippet 解析逻辑。

**现象**: D549461 审查时，11 条评论全部被跳过，提示"评论已存在（去重）"，但实际上 Phabricator 上没有任何评论。

**根本原因**: 
1. ReviewAgent 的各个 CR Agent 按照 prompt 返回 `codeSnippet` 但不返回 `line`
2. PublishPhabricatorCommentsTool 要求必须有 `line` 才能发布（第 242 行 `if (lineNumber)`）
3. 没有 `line` 的 Issue 在第 229-238 行被跳过

**解决方案**: 
在保留 `CommentDeduplicator` 功能的同时，添加 codeSnippet 到行号的解析逻辑：

1. 导入 `parseDiff` 和 `findLineNumberByCodeSnippet`
2. 在发布前获取 diff 数据
3. 对每个 Issue，如果没有 `line` 但有 `codeSnippet`，则自动解析行号
4. 使用解析后的 `lineNumber` 进行后续的去重和发布操作

**关键代码**:
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
      // ... 记录日志
    }
  }
}
```

---

**修改日期**: 2025-11-11  
**修改人**: AI Assistant  
**影响范围**: PublishPhabricatorCommentsTool  
**状态**: ✅ 已修复并编译通过

