# Changelog

## [Unreleased]

### Added
- **write-test-file 工具**: 将生成的测试用例写入磁盘文件，支持批量写入和覆盖控制
- **架构设计文档**: `ARCHITECTURE_REDESIGN.md` 规划了 SSE/HTTP Stream 传输和 ReAct 模式智能体架构
- **实施总结文档**: `IMPLEMENTATION_SUMMARY.md` 记录了所有改进细节和测试建议

### Changed
- **优化 diff 行号格式**: 使用 `NEW_LINE_xxx` 和 `DELETED (was line xxx)` 前缀，使行号更加清晰明确
- **统一行号说明**: 在 `BaseAgent` 中新增 `getLineNumberInstructions()` 方法，为所有 CR agents 提供统一的行号格式说明
- **改进 React Agent prompt**: 强调使用新文件行号，避免混淆
- **改进 Accessibility Agent prompt**: 强调使用新文件行号，避免混淆
- **更新 README**: 添加 write-test-file 工具文档和行号格式说明

### Fixed
- **评论行数错乱问题**: 通过优化 diff 格式和 AI prompt，确保评论始终使用新文件的正确行号
- **删除行误报问题**: 明确标记已删除的行，避免 AI 对不存在的行发表评论

## 技术细节

### 行号问题根源
1. AI 混淆旧行号（`-8`）和新行号（`+10`）
2. 对已删除的行（`+n/a`）仍报告问题
3. Prompt 说明不够清晰

### 解决方案
1. **格式改进**: `NEW_LINE_42: +const foo = 1;` 一目了然
2. **删除行标记**: `DELETED (was line 8): -const old = 1;` 明确标记
3. **Prompt 强化**: 使用 emoji 和格式化强调关键规则
4. **验证机制**: `findNewLineNumber()` 过滤无效行号

### 兼容性
- ✅ 所有改动向后兼容
- ✅ 现有 API 和工具不受影响
- ✅ 新增工具是可选的

### 下一步
1. 更新剩余 CR agents (css, typescript, performance, security, i18n)
2. 实现 fetch-commit-changes 工具
3. 实现 run-tests 工具
4. 支持 HTTP/SSE transport
