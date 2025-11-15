# 工作区管理功能说明

## 概述

工作区管理功能提供了对 Git 仓库的智能管理，包括：

1. **自动测试分支管理** - 基于 feature 分支自动创建和维护 feature-test 分支
2. **自定义测试策略** - 从 `.cursor/rules/test-strategy.md` 读取项目特定的测试配置
3. **Monorepo 支持** - 自动识别和处理 Monorepo 子项目

## 主要特性

### 1. 测试分支自动管理

当你提交 MR 基于 `feature/xxx` 分支时，系统会：

- 检查是否存在 `feature/xxx-test` 分支
- 如果存在，切换到该分支并更新到最新的 feature 分支代码
- 如果不存在，基于 feature 分支创建新的测试分支

**示例：**

```typescript
// 输入：feature/user-login
// 输出：自动创建/切换到 feature/user-login-test 分支
```

### 2. 自定义测试策略规则

系统只会读取 `.cursor/rules/test-strategy.md` 文件来获取自定义规则。

**文件位置优先级：**

1. 对于 Monorepo 项目：先查找子项目根目录的 `.cursor/rules/test-strategy.md`
2. 如果没找到，再查找项目根目录的 `.cursor/rules/test-strategy.md`

**规则文件示例：**

```markdown
# 测试策略

## 项目配置

测试框架: vitest
测试类型: unit, integration

## 测试规则

- 所有新功能必须有单元测试
- 关键业务逻辑需要集成测试
- UI 组件需要快照测试
```

### 3. 测试框架自动检测

如果 `.cursor/rules/test-strategy.md` 中指定了测试框架，系统会优先使用该配置：

```markdown
测试框架: vitest
# 或
framework: jest
# 或
test framework: vitest
```

如果没有指定，系统会自动从 `package.json` 检测。

### 4. Monorepo 支持

对于 Monorepo 项目，系统会：

1. 自动检测项目是否为 Monorepo（pnpm、yarn、lerna、nx等）
2. 根据变更文件识别**所有**受影响的子项目
3. 自动过滤掉**不需要测试的子项目**（如纯类型包、没有测试框架的工具包）
4. 优先从子项目根目录加载 `.cursor/rules/test-strategy.md`
5. 在子项目根目录检测测试框架和已有测试

详细的 Monorepo 测试策略，请参考 [Monorepo 测试策略文档](./monorepo-testing-strategy.md)。

## API 使用示例

### fetch-diff-from-repo

```json
{
  "repoUrl": "https://github.com/org/repo.git",
  "branch": "feature/user-login",
  "baselineBranch": "main"
}
```

**返回：**

```json
{
  "workspaceId": "ws-1234567890-abc123",
  "diff": "...",
  "projectConfig": {
    "projectRoot": "/path/to/repo",
    "packageRoot": "/path/to/repo/packages/auth",  // 主要子项目（可测试且变更最多）
    "isMonorepo": true,
    "monorepoType": "pnpm",
    "testFramework": "vitest",  // 从规则文件读取或自动检测
    "hasExistingTests": true,
    "testPattern": "**/*.{test,spec}.{ts,tsx,js,jsx}",
    "customRules": "...",  // .cursor/rules/test-strategy.md 的内容
    "affectedSubProjects": [
      "/path/to/repo/packages/auth",
      "/path/to/repo/packages/ui",
      "/path/to/repo/apps/web"
    ],
    "testableSubProjects": [
      "/path/to/repo/packages/auth",
      "/path/to/repo/packages/ui"
    ]
  },
  "changedFiles": [
    "packages/auth/src/login.ts",
    "packages/auth/src/login.test.ts"
  ]
}
```

### detect-project-config

```json
{
  "workspaceId": "ws-1234567890-abc123"
}
```

**返回项目配置信息，包括从规则文件中解析的测试框架配置。**

## 工作流程

1. **创建工作区**
   - 调用 `fetch-diff-from-repo` 提供仓库 URL 和分支名
   - 系统自动创建/切换到测试分支
   - 自动识别 Monorepo 子项目

2. **检测项目配置**
   - 从正确的目录（可能是子项目根目录）加载 `.cursor/rules/test-strategy.md`
   - 解析测试框架配置（如果规则中有指定）
   - 检测已有测试和测试框架

3. **生成测试**
   - 使用检测到的配置生成测试代码
   - 测试代码写入测试分支

4. **提交**
   - 测试分支可以提交 MR
   - 保留原始 feature 分支干净

## 注意事项

1. **测试分支命名**：只支持在分支名后添加 `-test` 后缀
2. **规则文件位置**：必须是 `.cursor/rules/test-strategy.md`（新文件名）
3. **Monorepo 规则**：子项目的规则文件应该放在子项目根目录
4. **测试框架优先级**：规则文件中的配置 > 自动检测

## 配置测试策略文件

### 创建 `.cursor/rules/test-strategy.md`

对于普通项目，在项目根目录创建：

```bash
mkdir -p .cursor/rules
touch .cursor/rules/test-strategy.md
```

对于 Monorepo，在子项目根目录创建：

```bash
mkdir -p packages/your-package/.cursor/rules
touch packages/your-package/.cursor/rules/test-strategy.md
```

### 示例配置文件

```markdown
# 测试策略

## 项目信息

项目名称: 用户认证模块
测试框架: vitest

## 测试规范

### 单元测试

- 所有 service 层必须有单元测试
- 测试覆盖率要求: 80%
- Mock 外部依赖

### 组件测试

- React 组件必须有渲染测试
- 关键交互必须有事件测试
- 使用 @testing-library/react

### 测试命名

- 文件名: `*.test.ts` 或 `*.test.tsx`
- 测试用例: describe > it 结构
- 清晰的测试描述

## 特殊规则

- 登录组件需要测试所有错误场景
- API 调用必须 Mock
- 不允许真实的网络请求
```
