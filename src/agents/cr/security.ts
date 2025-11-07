import { getProjectPath } from '../../utils/paths.js';
import { BaseAgent } from '../base.js';
import { OpenAIClient } from '../../clients/openai.js';
import type { Issue } from '../../schemas/issue.js';
import { generateIssueFingerprint } from '../../utils/fingerprint.js';
import { CRTopic } from '../../schemas/topic.js';
import { logger } from '../../utils/logger.js';

export class SecurityAgent extends BaseAgent<Issue> {
  constructor(openai: OpenAIClient, projectContextPrompt?: string) {
    super(openai, {
      name: 'security',
      promptPath: getProjectPath('src/prompts/cr/security.md'),
      description: '审查安全漏洞和风险',
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
      logger.error('SecurityAgent failed', { error });
      return { items: [], confidence: 0 };
    }
  }

  private buildPrompt(diff: string, files: Array<{ path: string; content: string }>): string {
    // ✅ 增加上下文长度，避免截断导致误判
    const fileList = files.map(f => `文件: ${f.path}\n内容:\n${f.content.substring(0, 8000)}`).join('\n\n');
    
    return `分析以下代码变更，识别安全漏洞和风险：

**重要说明**：
1. 下面的内容是 git diff 格式，带有行号标记，格式为 "-旧行号 +新行号: 代码内容"
   - 新增行：-n/a +10: +const token = getToken();
   - 删除行：-8 +n/a: -const old = getData();
   - 上下文行：-8 +10:  const a = 1;
2. **关键**：返回的 line 字段必须使用**新文件的行号**（即 + 号后面的行号）
   - 如果是新增行或修改行，使用新文件行号
   - 如果是删除的行（+n/a），不要报告问题（因为该行在新版本中不存在）
3. diff 中只显示了变更的行及其上下文，未显示的行不代表不存在
4. 在判断安全问题时，请检查完整的文件内容和上下文
5. 如果上下文不足以确定问题，请降低置信度至 0.5 以下或不报告
6. **关键**：返回的 file 字段必须使用下面"变更的文件列表"中的准确路径，不要修改扩展名

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
- confidence: 置信度 (0-1，不确定时设为 < 0.5)`;
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
            'security',
            item.message || ''
          ),
          file: filePath,
          line: item.line || 0,
          severity: item.severity || 'high', // 安全问题默认高严重度
          topic: CRTopic.parse('security'),
          message: item.message || '',
          suggestion: item.suggestion || '',
          confidence: Math.max(0, Math.min(1, item.confidence || 0.8)),
        };
        return issue;
      }).filter((issue): issue is Issue => issue !== null && issue.file && issue.message);
    } catch (error) {
      logger.warn('Failed to parse SecurityAgent response', { response, error });
      return [];
    }
  }
}

