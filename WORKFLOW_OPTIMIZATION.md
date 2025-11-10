# 工作流优化说明

## 问题描述

之前的工作流存在重复获取 diff 的问题：

```
用户调用 fetch-diff → 获取 diff
用户调用 review-frontend-diff → 重新获取 diff ❌
用户调用 analyze-test-matrix → 再次获取 diff ❌
用户调用 generate-tests → 又一次获取 diff ❌
```

虽然有缓存机制，但第一次调用时仍会产生多次网络请求，工作流不够清晰。

## 解决方案

为 `review-frontend-diff`、`analyze-test-matrix`、`generate-tests` 三个工具添加可选的 `diff` 参数。

### 方案 1: 传递 diff 对象（推荐）

```typescript
// 1. 先获取 diff
const diffResult = await fetchDiff({ revisionId: "D12345" });

// 2. 将 diff 传递给其他工具，避免重复请求
await reviewFrontendDiff({ 
  revisionId: "D12345", 
  diff: diffResult.diff  // ✅ 传入已获取的 diff
});

await analyzeTestMatrix({ 
  revisionId: "D12345", 
  diff: diffResult.diff,  // ✅ 传入已获取的 diff
  projectRoot: "/path/to/project"
});

await generateTests({ 
  revisionId: "D12345", 
  diff: diffResult.diff,  // ✅ 传入已获取的 diff
  projectRoot: "/path/to/project"
});
```

### 方案 2: 不传递 diff（向后兼容）

如果不传递 `diff` 参数，工具会自动获取（和之前的行为一样）：

```typescript
// 工具会自动获取 diff
await reviewFrontendDiff({ revisionId: "D12345" });
await analyzeTestMatrix({ revisionId: "D12345" });
await generateTests({ revisionId: "D12345" });
```

## 优势

✅ **避免重复请求**: 一次获取，多次使用  
✅ **向后兼容**: 不传 `diff` 参数时行为不变  
✅ **工作流清晰**: 用户可以选择先查看 diff，再决定后续操作  
✅ **性能提升**: 减少网络请求次数  

## 修改的文件

- `src/tools/fetch-diff.ts` - 更新描述，说明 diff 对象可传递给其他工具
- `src/tools/review-frontend-diff.ts` - 添加可选的 `diff` 参数
- `src/tools/analyze-test-matrix.ts` - 添加可选的 `diff` 参数
- `src/tools/generate-tests.ts` - 添加可选的 `diff` 参数

## 使用示例

### Agent 工作流示例

```typescript
// Agent 可以这样使用：
const diff = await tools.fetchDiff({ revisionId: "D12345" });

// 查看 diff 内容，决定是否需要 review
console.log(`Found ${diff.diff.files.length} files changed`);

// 如果需要 review，传入已获取的 diff
if (needsReview) {
  await tools.reviewFrontendDiff({ 
    revisionId: "D12345", 
    diff: diff.diff,
    publish: true 
  });
}

// 如果需要生成测试，传入已获取的 diff
if (needsTests) {
  await tools.analyzeTestMatrix({ 
    revisionId: "D12345", 
    diff: diff.diff,
    projectRoot: "/path/to/project"
  });
  
  await tools.generateTests({ 
    revisionId: "D12345", 
    diff: diff.diff,
    projectRoot: "/path/to/project"
  });
}
```

## 日志输出

使用提供的 diff 时，会有相应的日志：

```
[ReviewFrontendDiffTool] Using provided diff for D12345
[AnalyzeTestMatrixTool] Using provided diff for D12345
[GenerateTestsTool] Using provided diff for D12345
```

不提供 diff 时，会自动获取：

```
[ReviewFrontendDiffTool] Fetching diff for D12345...
[AnalyzeTestMatrixTool] Fetching diff for D12345...
[GenerateTestsTool] Fetching diff for D12345...
```

