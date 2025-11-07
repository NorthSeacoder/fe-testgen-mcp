import { getProjectPath } from '../../utils/paths.js';
import { BaseAgent } from '../base.js';
import { OpenAIClient } from '../../clients/openai.js';
import type { Issue } from '../../schemas/issue.js';
import { generateIssueFingerprint } from '../../utils/fingerprint.js';
import { CRTopic } from '../../schemas/topic.js';
import { logger } from '../../utils/logger.js';

export class PerformanceAgent extends BaseAgent<Issue> {
  constructor(openai: OpenAIClient, projectContextPrompt?: string) {
    super(openai, {
      name: 'performance',
      promptPath: getProjectPath('src/prompts/cr/performance.md'),
      description: '审查性能优化相关问题',
      projectContextPrompt,
    });
  }

  async execute(context: {
    diff: string;
    files: Array<{ path: string; content: string }>;
    metadata?: Record<string, unknown>;
  }): Promise<{ items: Issue[]; confidence: number }> {
    const prompt = this.buildPrompt(context.diff, context.files);

    try {
      const response = await this.callLLM(this.prompt, prompt);
      const issues = this.parseResponse(response, context.files);

      const avgConfidence = issues.length > 0
        ? issues.reduce((sum, issue) => sum + issue.confidence, 0) / issues.length
        : 0.8;

      return {
        items: issues,
        confidence: avgConfidence,
      };
    } catch (error) {
      logger.error('PerformanceAgent failed', { error });
      return { items: [], confidence: 0 };
    }
  }

  private buildPrompt(diff: string, files: Array<{ path: string; content: string }>): string {
    // ✅ 增加上下文长度，避免截断导致误判
    const fileList = files.map(f => `文件: ${f.path}\n内容:\n${f.content.substring(0, 8000)}`).join('\n\n');
    
    return `分析以下代码变更，识别性能相关问题：

${this.getLineNumberInstructions()}

**变更的文件列表**：
- ${this.buildFilePathsList(files)}

代码变更（diff）：
\`\`\`
${diff.substring(0, 15000)}
\`\`\`

相关文件的完整 diff：
${fileList}

返回 JSON 格式的问题列表，每个问题包含：
- file: 文件路径（必须从上面的文件列表中选择，保持完全一致）
- line: **新文件的行号**（必须是 diff 中 + 号后面显示的行号，不要使用 - 号的旧行号）
- severity: critical/high/medium/low
- message: 问题描述
- suggestion: 修复建议
- confidence: 置信度 (0-1，不确定时设为 < 0.5)

示例：
\`\`\`json
[
  {
    "file": "src/components/List.tsx",
    "line": 42,
    "severity": "high",
    "message": "未使用 useMemo 缓存计算结果",
    "suggestion": "使用 useMemo 缓存计算结果",
    "confidence": 0.9
  }
]
\`\`\``;
  }

  private parseResponse(response: string, files: Array<{ path: string; content: string }>): Issue[] {
    try {
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || response.match(/\[[\s\S]*\]/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : response;
      const parsed = JSON.parse(jsonStr);

      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.map((item: any) => {
        // ✅ 验证并修正文件路径
        const filePath = this.correctFilePath(item.file || '', files);
        if (!filePath) {
          return null;
        }

        const issue: Issue = {
          id: generateIssueFingerprint(
            filePath,
            [item.line || 0, item.line || 0],
            'performance',
            item.message || ''
          ),
          file: filePath,
          line: item.line || 0,
          severity: item.severity || 'medium',
          topic: CRTopic.parse('performance'),
          message: item.message || '',
          suggestion: item.suggestion || '',
          confidence: Math.max(0, Math.min(1, item.confidence || 0.7)),
        };
        return issue;
      }).filter((issue): issue is Issue => issue !== null && !!issue.file && !!issue.message);
    } catch (error) {
      logger.warn('Failed to parse PerformanceAgent response', { response, error });
      return [];
    }
  }
}

