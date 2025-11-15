# Monorepo 测试策略

## 概述

在 Monorepo 项目中，系统会智能识别所有受影响的子项目，并自动过滤出需要生成测试的子项目。

## 核心功能

### 1. 识别所有受影响的子项目

当你提交包含多个子项目变更的代码时，系统会：

- 分析所有变更文件
- 识别每个子项目的变更数量
- 按变更数量排序（变更最多的排在前面）

**支持的子项目目录结构：**
- `packages/*`
- `apps/*`
- `libs/*`
- `services/*`
- `modules/*`

### 2. 过滤可测试的子项目

系统会检查每个受影响的子项目是否需要生成测试：

#### ✅ 需要生成测试的条件

1. **有测试框架** - 在 `package.json` 中安装了 `vitest` 或 `jest`
2. **不是纯类型包** - 不只是类型定义
3. **不是常量包** - 不只是常量定义

#### ❌ 跳过测试的情况

系统会自动跳过以下子项目：

1. **没有测试框架**
   ```json
   // package.json 中没有 vitest 或 jest
   {
     "name": "@org/utils",
     "dependencies": {}
   }
   ```

2. **纯类型包**
   ```json
   // 只有 types 字段，没有 main 或 module
   {
     "name": "@org/types",
     "types": "index.d.ts"
   }
   ```

3. **命名模式匹配**
   - `@xxx/types` - 类型包
   - `xxx-types` - 类型包
   - `types-xxx` - 类型包
   - `@xxx/constants` - 常量包
   - `xxx-constants` - 常量包

## 使用示例

### 场景 1: 改了多个子项目

假设你的 Monorepo 结构如下：

```
repo/
├── packages/
│   ├── auth/         (有 vitest)
│   ├── ui/           (有 jest)
│   ├── types/        (纯类型包，无测试框架)
│   └── constants/    (常量包，无测试框架)
└── apps/
    └── web/          (有 vitest)
```

你修改了以下文件：
- `packages/auth/src/login.ts` (3 个文件)
- `packages/ui/src/Button.tsx` (2 个文件)
- `packages/types/src/user.ts` (1 个文件)
- `apps/web/src/App.tsx` (1 个文件)

**系统会返回：**

```json
{
  "projectConfig": {
    "isMonorepo": true,
    "affectedSubProjects": [
      "/path/to/repo/packages/auth",      // 3 个变更文件（最多）
      "/path/to/repo/packages/ui",        // 2 个变更文件
      "/path/to/repo/apps/web",           // 1 个变更文件
      "/path/to/repo/packages/types"      // 1 个变更文件
    ],
    "testableSubProjects": [
      "/path/to/repo/packages/auth",      // ✅ 有 vitest
      "/path/to/repo/packages/ui",        // ✅ 有 jest
      "/path/to/repo/apps/web"            // ✅ 有 vitest
      // ❌ packages/types 被跳过（纯类型包）
    ],
    "packageRoot": "/path/to/repo/packages/auth"  // 主要子项目
  }
}
```

### 场景 2: 只改了工具包

如果你只修改了 `packages/types/` 或 `packages/constants/`：

```json
{
  "projectConfig": {
    "isMonorepo": true,
    "affectedSubProjects": [
      "/path/to/repo/packages/types"
    ],
    "testableSubProjects": [],  // 空数组，没有需要测试的子项目
    "packageRoot": undefined
  }
}
```

**结果**：不会生成任何测试。

### 场景 3: 改了有测试框架的工具包

如果你的工具包安装了测试框架：

```json
// packages/utils/package.json
{
  "name": "@org/utils",
  "devDependencies": {
    "vitest": "^1.0.0"
  }
}
```

**结果**：即使名称包含 `utils`，也会生成测试（因为有测试框架）。

## API 响应格式

### fetch-diff-from-repo 返回

```typescript
{
  workspaceId: string;
  diff: string;
  projectConfig: {
    projectRoot: string;
    packageRoot?: string;          // 主要子项目（变更最多的可测试子项目）
    isMonorepo: boolean;
    monorepoType?: 'pnpm' | 'yarn' | 'npm' | 'lerna' | 'nx' | 'rush';
    testFramework?: 'vitest' | 'jest' | 'none';
    hasExistingTests: boolean;
    customRules?: string;
    affectedSubProjects?: string[];   // 所有受影响的子项目（按变更数量排序）
    testableSubProjects?: string[];   // 需要生成测试的子项目
  };
  changedFiles: string[];
}
```

## 工作流建议

### 1. 为每个可测试的子项目生成测试

```javascript
const result = await fetch('fetch-diff-from-repo', {
  repoUrl: 'https://github.com/org/repo.git',
  branch: 'feature/multi-package-update'
});

const { testableSubProjects } = result.projectConfig;

if (!testableSubProjects || testableSubProjects.length === 0) {
  console.log('No testable sub-projects, skip test generation');
  return;
}

// 为每个可测试的子项目生成测试
for (const subProject of testableSubProjects) {
  await generateTestsForSubProject(subProject);
}
```

### 2. 只为主要子项目生成测试

如果你只想为变更最多的子项目生成测试：

```javascript
const result = await fetch('fetch-diff-from-repo', {
  repoUrl: 'https://github.com/org/repo.git',
  branch: 'feature/auth-update'
});

const { packageRoot, testFramework } = result.projectConfig;

if (packageRoot && testFramework !== 'none') {
  await generateTests({
    workspaceId: result.workspaceId,
    packageRoot,
    testFramework
  });
}
```

## 自定义跳过规则

如果你的项目有特殊的命名规则，可以在 `.cursor/rules/test-strategy.md` 中明确说明：

```markdown
# 测试策略

## 跳过测试的包

以下包不需要生成测试：
- @org/shared-types - 纯类型定义
- @org/config - 配置文件
- @org/mocks - Mock 数据

## 需要测试的包

以下包必须有测试：
- @org/auth - 认证模块
- @org/api - API 封装
- @org/ui - UI 组件库
```

**注意**：当前实现主要基于测试框架的存在与否来判断。如果你想完全自定义规则，可以考虑在规则文件中添加更多元数据。

## 日志输出

系统会在日志中输出详细的分析信息：

```
[ProjectDetector] Sub-projects detected {
  candidates: [
    '/path/to/repo/packages/auth',
    '/path/to/repo/packages/ui',
    '/path/to/repo/packages/types'
  ],
  details: [
    ['packages/auth', { count: 3, files: [...] }],
    ['packages/ui', { count: 2, files: [...] }],
    ['packages/types', { count: 1, files: [...] }]
  ]
}

[ProjectDetector] No test framework, skipping {
  path: '/path/to/repo/packages/types'
}

[ProjectDetector] Testable sub-projects {
  total: 3,
  testable: 2,
  skipped: 1,
  testableList: [
    '/path/to/repo/packages/auth',
    '/path/to/repo/packages/ui'
  ]
}
```

## 性能考虑

- **并行检测**：所有子项目的测试框架检测是并行进行的
- **缓存友好**：package.json 的读取使用 Node.js 缓存
- **日志详细**：方便调试和理解系统决策

## 常见问题

### Q: 如果工具包也需要测试怎么办？

A: 确保在工具包的 `package.json` 中安装测试框架（vitest 或 jest），系统会自动识别。

### Q: 如何强制跳过某个子项目的测试生成？

A: 移除该子项目的测试框架依赖，或确保它匹配跳过模式（如 `xxx-types`）。

### Q: 可以自定义跳过模式吗？

A: 当前版本使用内置的跳过模式。如果需要自定义，建议在 `.cursor/rules/test-strategy.md` 中明确说明（未来版本可能会支持从规则文件中读取跳过模式）。

### Q: 如果没有变更文件会怎样？

A: 如果 `changedFiles` 为空，系统不会分析子项目，`affectedSubProjects` 和 `testableSubProjects` 都会是 undefined。
