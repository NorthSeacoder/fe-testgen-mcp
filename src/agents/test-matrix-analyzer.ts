import { OpenAIClient } from '../clients/openai.js';
import { BaseAgent } from './base.js';
import type { FeatureItem, TestScenarioItem } from '../schemas/test-matrix.js';
import { logger } from '../utils/logger.js';

/**
 * 测试矩阵分析 Agent
 * 
 * 职责：
 * 1. 分析 diff，提取功能清单（变更了哪些函数/组件）
 * 2. 为每个功能生成测试场景矩阵
 * 
 * 注意：这个 Agent 不使用外部 prompt 文件，而是在代码中定义 prompt
 */
export class TestMatrixAnalyzer extends BaseAgent<{
  features: FeatureItem[];
  scenarios: TestScenarioItem[];
}> {
  constructor(openai: OpenAIClient) {
    // TestMatrixAnalyzer 不使用外部 prompt 文件
    // 因为它的 prompt 是动态生成的，所以传递一个虚拟配置
    super(openai, {
      name: 'test-matrix-analyzer',
      promptPath: '', // 不使用外部 prompt
      description: '测试矩阵分析 Agent',
    });
  }

  getName(): string {
    return 'test-matrix-analyzer';
  }

  async execute(context: {
    diff: string;
    files: Array<{ path: string; content: string }>;
    framework?: string;
  }): Promise<{
    items: Array<{ features: FeatureItem[]; scenarios: TestScenarioItem[] }>;
    confidence: number;
  }> {
    const systemPrompt = `你是一个专业的前端测试分析专家。

你的任务是分析代码变更（diff），提取功能清单并生成测试矩阵。

# 第一步：提取功能清单

分析 diff 中的变更，识别出所有被修改的功能：
- **函数**：新增/修改的函数
- **组件**：React/Vue 组件
- **Hook**：自定义 Hook
- **类**：类定义
- **模块**：模块级别的变更

对每个功能，输出：
- \`name\`: 功能名称（函数名/组件名）
- \`type\`: 类型（function/component/hook/class/module）
- \`description\`: 简短描述（这个功能做什么）
- \`changeType\`: 变更类型（added/modified/deleted）
- \`complexity\`: 复杂度（low/medium/high）

# 第二步：生成测试矩阵

对每个功能，分析需要测试的场景：

## 场景类型

1. **happy-path**：正常路径测试
   - 正常输入、正常流程、预期输出
   
2. **edge-case**：边界情况测试
   - 空值、空数组、极值、特殊字符
   
3. **error-path**：错误处理测试
   - 异常输入、错误回调、失败情况
   
4. **state-change**：状态变化测试
   - 状态转换、副作用、异步更新

对每个场景，输出：
- \`scenario\`: 场景类型
- \`description\`: 场景描述
- \`priority\`: 优先级（high/medium/low）
- \`testCases\`: 具体测试用例列表（字符串数组）
- \`suggestedApproach\`: 建议的测试方法（可选）

# 输出格式

\`\`\`json
{
  "features": [
    {
      "id": "feature-1",
      "file": "src/utils/formatDate.ts",
      "name": "formatDate",
      "type": "function",
      "description": "格式化日期为指定格式",
      "changeType": "modified",
      "complexity": "medium"
    }
  ],
  "scenarios": [
    {
      "id": "scenario-1",
      "featureId": "feature-1",
      "scenario": "happy-path",
      "description": "正常日期格式化",
      "priority": "high",
      "testCases": [
        "应该正确格式化标准日期",
        "应该支持自定义格式字符串",
        "应该处理不同时区"
      ],
      "suggestedApproach": "使用快照测试验证输出格式"
    },
    {
      "id": "scenario-2",
      "featureId": "feature-1",
      "scenario": "edge-case",
      "description": "边界情况处理",
      "priority": "medium",
      "testCases": [
        "应该处理 null/undefined",
        "应该处理无效日期",
        "应该处理空字符串"
      ]
    }
  ]
}
\`\`\`

# 注意事项

1. **关注变更**：只分析变更的部分，不要分析未修改的代码
2. **实用性**：测试场景要实际、有意义，避免过于理论化
3. **优先级**：核心功能和高风险变更优先级高
4. **完整性**：确保每个功能都有对应的测试场景
5. **测试框架**：当前使用 ${context.framework || 'Vitest'}
6. **必须识别功能**：**重要**：如果 diff 中有代码变更（非空行），必须识别出至少一个功能。即使变更很小，也要识别出相应的功能。

# 强制要求

**你必须返回至少一个功能项（feature）**，如果 diff 中有任何代码变更：
- 即使只是修改了一个函数的一行代码，也要识别为该函数的修改
- 即使只是添加了注释，也要识别为相应的函数/组件的修改
- 如果实在无法识别具体功能，至少识别为"模块级别变更"（type: "module"）

**如果 diff 中没有代码变更（只有空白行或格式调整），返回空的 features 数组**。

请分析以下代码变更：`;

    const userPrompt = `# 代码变更

${context.diff}

${context.files.length > 0 ? `
# 相关文件内容

${context.files.map(f => `## ${f.path}\n\n\`\`\`typescript\n${f.content}\n\`\`\``).join('\n\n')}
` : ''}

请提取功能清单并生成测试矩阵。`;

    // 记录发送给 AI 的完整内容（用于调试）
    logger.info('Sending to AI for analysis', {
      diffLength: context.diff.length,
      diffPreview: context.diff.substring(0, 500),
      filesCount: context.files.length,
      userPromptLength: userPrompt.length,
    });

    try {
      const response = await this.openai.complete(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        {
          responseFormat: { type: 'json_object' },
        }
      );

      logger.info('AI response received', {
        responseLength: response.length,
        responsePreview: response.substring(0, 200),
      });

      // 清理 AI 响应：移除可能的 markdown 代码块标记
      let cleanedResponse = response.trim();
      if (cleanedResponse.startsWith('```json')) {
        cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanedResponse.startsWith('```')) {
        cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      logger.info('Cleaned response for parsing', {
        originalLength: response.length,
        cleanedLength: cleanedResponse.length,
        cleanedPreview: cleanedResponse.substring(0, 200),
      });

      const result = JSON.parse(cleanedResponse);
      
      // 记录原始响应（用于调试）
      logger.debug('AI response parsed', {
        hasFeatures: !!result.features,
        hasScenarios: !!result.scenarios,
        resultKeys: Object.keys(result),
        featuresType: Array.isArray(result.features) ? 'array' : typeof result.features,
        scenariosType: Array.isArray(result.scenarios) ? 'array' : typeof result.scenarios,
      });
      
      // 确保 features 和 scenarios 是数组
      if (!result.features) {
        logger.warn('No features field in AI response', {
          responseKeys: Object.keys(result),
          responseSample: JSON.stringify(result).substring(0, 500),
        });
        result.features = [];
      }
      
      if (!result.scenarios) {
        logger.warn('No scenarios field in AI response', {
          responseKeys: Object.keys(result),
        });
        result.scenarios = [];
      }
      
      // 生成唯一 ID
      if (result.features) {
        result.features = result.features.map((f: any, idx: number) => ({
          ...f,
          id: f.id || `feature-${idx + 1}`,
          file: f.file || context.files[0]?.path || 'unknown',
        }));
      }
      
      if (result.scenarios) {
        result.scenarios = result.scenarios.map((s: any, idx: number) => ({
          ...s,
          id: s.id || `scenario-${idx + 1}`,
        }));
      }

      logger.info('Test matrix analyzed', {
        featuresCount: result.features?.length || 0,
        scenariosCount: result.scenarios?.length || 0,
        featureNames: result.features?.map((f: any) => f.name).join(', ') || 'none',
      });

      return {
        items: [result],
        confidence: 0.9,
      };
    } catch (error) {
      logger.error('Test matrix analysis failed', { error });
      return {
        items: [{ features: [], scenarios: [] }],
        confidence: 0,
      };
    }
  }
}

