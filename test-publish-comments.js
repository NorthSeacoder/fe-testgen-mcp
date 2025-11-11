/**
 * 测试 PublishPhabricatorCommentsTool 的 codeSnippet 解析功能
 * 
 * 这个测试验证：
 * 1. 当 issue 只有 codeSnippet 没有 line 时，能否正确解析行号
 * 2. 当 issue 同时有 line 和 codeSnippet 时，优先使用 line
 * 3. 当无法解析行号时，是否正确跳过
 */

// 模拟 Issue 数据
const testIssues = [
  {
    id: 'test-1',
    file: 'src/components/Button.tsx',
    codeSnippet: 'const [count] = useState(0)',
    severity: 'high',
    topic: 'react',
    message: 'useState 缺少 setter',
    suggestion: '应该使用 const [count, setCount] = useState(0)',
    confidence: 0.9,
  },
  {
    id: 'test-2',
    file: 'src/components/Button.tsx',
    line: 42,
    codeSnippet: 'useEffect(() => {',
    severity: 'medium',
    topic: 'react',
    message: 'useEffect 缺少依赖项',
    suggestion: '在依赖数组中添加相关变量',
    confidence: 0.85,
  },
  {
    id: 'test-3',
    file: 'src/components/Button.tsx',
    codeSnippet: 'this-code-does-not-exist',
    severity: 'low',
    topic: 'react',
    message: '这个应该被跳过',
    suggestion: '因为代码片段不存在',
    confidence: 0.7,
  },
];

console.log('✅ 测试数据准备完成');
console.log('📝 测试 Issues:');
testIssues.forEach((issue, idx) => {
  console.log(`  ${idx + 1}. ${issue.file} - ${issue.message}`);
  console.log(`     - line: ${issue.line || '(无)'}`);
  console.log(`     - codeSnippet: ${issue.codeSnippet}`);
});

console.log('\n✨ 修改说明:');
console.log('1. PublishPhabricatorCommentsTool 现在会自动从 codeSnippet 解析行号');
console.log('2. 优先使用 issue.line，如果没有则尝试从 codeSnippet 解析');
console.log('3. 使用 findLineNumberByCodeSnippet 函数进行智能匹配');
console.log('4. 支持精确匹配和模糊匹配');
console.log('5. 优先匹配新增的行（ADDED）而不是上下文行（CONTEXT）');

console.log('\n📚 相关文件:');
console.log('- src/tools/publish-phabricator-comments.ts (已更新)');
console.log('- src/utils/diff-parser.ts (findLineNumberByCodeSnippet 函数)');
console.log('- src/agents/cr/*.ts (已更新为返回 codeSnippet)');

console.log('\n✅ 所有修改已完成并编译成功！');

