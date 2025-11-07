import { getProjectPath } from '../../utils/paths.js';
import { BaseAgent } from '../base.js';
import { OpenAIClient } from '../../clients/openai.js';
import type { Issue } from '../../schemas/issue.js';
import { generateIssueFingerprint } from '../../utils/fingerprint.js';
import { CRTopic } from '../../schemas/topic.js';
import { logger } from '../../utils/logger.js';

export class CSSAgent extends BaseAgent<Issue> {
  constructor(openai: OpenAIClient, projectContextPrompt?: string) {
    super(openai, {
      name: 'css',
      promptPath: getProjectPath('src/prompts/cr/css.md'),
      description: '审查 CSS 样式相关问题',
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
        : 0.7;

      return {
        items: issues,
        confidence: avgConfidence,
      };
    } catch (error) {
      logger.error('CSSAgent failed', { error });
      return { items: [], confidence: 0 };
    }
  }

  private buildPrompt(diff: string, files: Array<{ path: string; content: string }>): string {
    // ✅ 增加上下文长度，避免截断导致误判
    const fileList = files.map(f => `文件: ${f.path}\n内容:\n${f.content.substring(0, 8000)}`).join('\n\n');
    
    // 🐛 调试：输出样式文件的 diff 片段（前 500 字符）
    const styleFiles = files.filter(f => 
      f.path.endsWith('.css') || f.path.endsWith('.less') || f.path.endsWith('.scss')
    );
    if (styleFiles.length > 0) {
      logger.debug('CSSAgent processing style files', {
        files: styleFiles.map(f => f.path),
        diffPreview: diff.substring(0, 500),
      });
    }
    
    return `分析以下代码变更，识别 CSS 样式相关问题：

${this.getLineNumberInstructions()}

**CSS 行号特别提示**：
- 样式文件经常包含空行或注释行，请始终报告**实际包含问题代码**的 NEW_LINE 行号
- 如果问题涉及某个属性（如 !important、硬编码值），请返回该属性所在行的 NEW_LINE 行号
- 例如：如果 \`color: red !important;\` 出现在 NEW_LINE_42，则返回 "line": 42
- 如果上下文不足以确定问题（如看不到样式块的完整定义），请降低置信度至 0.5 以下或不报告

**变更的文件列表**：
- ${this.buildFilePathsList(files)}

代码变更（diff）：
\`\`\`
${diff.substring(0, 15000)}
\`\`\`

相关文件的完整 diff：
${fileList}

返回 JSON 格式的问题列表，每个问题包含：
- file: 文件路径（必须从上面的文件列表中选择，保持完全一致，包括扩展名）
- line: **新文件的行号**（必须是 diff 中 + 号后面显示的行号，且必须是实际包含问题代码的行，不要使用空行或注释行的行号）
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
        // ✅ 验证并修正文件路径（特别重要，处理 .css vs .less 的问题）
        const filePath = this.correctFilePath(item.file || '', files);
        if (!filePath) {
          return null;
        }

        // 🐛 调试：记录 CSS/Less 文件的行号信息
        if (filePath.endsWith('.css') || filePath.endsWith('.less') || filePath.endsWith('.scss')) {
          logger.debug('CSSAgent reported issue', {
            file: filePath,
            reportedLine: item.line,
            message: item.message?.substring(0, 50),
            confidence: item.confidence,
          });
        }

        const issue: Issue = {
          id: generateIssueFingerprint(
            filePath,
            [item.line || 0, item.line || 0],
            'css',
            item.message || ''
          ),
          file: filePath,
          line: item.line || 0,
          severity: item.severity || 'medium',
          topic: CRTopic.parse('css'),
          message: item.message || '',
          suggestion: item.suggestion || '',
          confidence: Math.max(0, Math.min(1, item.confidence || 0.7)),
        };
        return issue;
      }).filter((issue): issue is Issue => {
        if (!issue) {
          return false;
        }
        return Boolean(issue.file) && Boolean(issue.message);
      });
    } catch (error) {
      logger.warn('Failed to parse CSSAgent response', { response, error });
      return [];
    }
  }
}

