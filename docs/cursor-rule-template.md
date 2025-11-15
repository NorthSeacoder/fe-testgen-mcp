# {{PROJECT_NAME}} · FE-MCP 工作规则

> 生成时间：{{GENERATED_AT}}

## 1. 项目信息
- 仓库地址：{{REPO_URL}}
- 当前分支：{{BRANCH}}
- 基准分支：{{BASELINE_BRANCH}}
- 项目类型：{{PROJECT_TYPE}}
- Monorepo 类型：{{MONOREPO_TYPE}}
- 主要子项目：{{PACKAGE_ROOT}}
- 受影响的子项目：
{{AFFECTED_SUBPROJECTS}}
- 可执行测试的子项目：
{{TESTABLE_SUBPROJECTS}}

## 2. 测试框架与执行策略
- 默认测试框架：{{TEST_FRAMEWORK}}
- 现有测试覆盖：{{HAS_EXISTING_TESTS}}
- 测试文件匹配模式：{{TEST_PATTERN}}
- 建议的命令行：
  - `npx {{TEST_FRAMEWORK}} run`
  - CI 模式下追加 `--runInBand`（Jest）或 `--pool=threads`（Vitest）
- 若使用 Vitest：
  - 推荐开启 `--reporter=verbose`
  - 使用 `waitFor` 处理异步逻辑
- 若使用 Jest：
  - 确认 `testEnvironment` 为 `jsdom`
  - 在需要 DOM API 的文件顶部引入 `@testing-library/jest-dom`

## 3. 测试生成配置
- 默认最大生成用例数：{{MAX_TESTS}}
- 场景优先级：
  1. **happy-path**（必选）
  2. **edge-case**（若 diff 涉及条件分支）
  3. **error-path**（涉及异常处理时）
  4. **state-change**（有状态管理或副作用时）
- 优先覆盖内容：
  - 新增或修改的导出函数/组件
  - 对用户可见的行为变更
  - 复杂条件判断或分支

## 4. 代码规范速查
- **React/组件测试**：
  - 使用 Testing Library 样式，断言用户行为
  - 避免直接断言内部实现（如 state）
  - 使用 `screen` + `getByRole` / `findByText`
- **Mock 策略**：
  - 默认使用 `vi.fn()` / `jest.fn()`
  - 对 API 调用使用 `vi.spyOn` 包裹真实模块
  - 重置顺序：`beforeEach(() => vi.clearAllMocks())`
- **断言规范**：
  - DOM 文本：`toHaveTextContent`
  - 列表长度：`toHaveLength`
  - 对象结构：`toMatchObject`
  - 数值比较：`toBeCloseTo`
- **异步测试**：
  - 加上 `await`，使用 `waitFor`
  - 需要 `act` 的场景由 Testing Library 自动处理

## 5. Monorepo 建议
- 统一在主要子项目根目录执行命令：`{{PACKAGE_ROOT}}`
- 将共享配置放置在 `packages/config` 或工具仓库
- 对于未启用测试框架的子项目：
  - 优先增加 Vitest（轻量）
  - 复用根目录 `tsconfig` 与 `setupTests`

## 6. 排除与忽略规则
- 忽略纯样式/静态资源：`*.css`, `*.scss`, `*.png`
- 忽略自动生成代码：`**/__generated__/**`
- 对第三方库的轻微封装，可选择性跳过测试，但需记录原因

## 7. 已有测试处理策略
- 若已有相关测试：
  - 尝试扩充原有文件
  - 避免重复创建文件
  - 对过期快照执行 `--update` 并人工审核
- 无相关测试：
  - 按功能组件划分新建测试文件
  - 保持与生产代码相同的目录层级

## 8. 项目特定约束
- 状态管理：优先使用真实 store，必要时使用轻量 mock
- API 调用：使用 `msw` 或轻量 fetch mock，保持接口契约
- 路由相关：通过 `MemoryRouter` / `RouterProvider` 包裹
- 国际化组件：使用默认语言或提供必要的 context

## 9. 自动修复建议（fix-failing-tests）
- 最大修复轮次：{{MAX_FIX_ATTEMPTS}}
- 置信度阈值：{{FIX_CONFIDENCE_THRESHOLD}}
- 常见修复动作：
  - 补全 Mock / 重置状态
  - 异步等待 + `waitFor`
  - 断言改为宽松匹配
  - 添加缺失的 polyfill

---

> 若需定制更多规则，可在 `.cursor/rule/fe-mcp.md` 中追加项目特定章节；同时同步更新 `project-detector` 的自定义规则，以保持自动化一致性。
