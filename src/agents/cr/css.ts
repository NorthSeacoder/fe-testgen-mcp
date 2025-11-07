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

**重要说明**：
1. 下面的内容是 git diff 格式，带有行号标记，格式为 "-旧行号 +新行号: 代码内容"
   - 新增行：-n/a +10: +.button { color: red; }
   - 删除行：-8 +n/a: -.old { color: blue; }
   - 上下文行：-8 +10:  .container { }
2. **关键**：返回的 line 字段必须使用**新文件的行号**（即 + 号后面的行号）
   - 如果是新增行或修改行，使用新文件行号
   - 如果是删除的行（+n/a），不要报告问题（因为该行在新版本中不存在）
3. **样式文件行号特别注意**：
   - CSS/Less/SCSS 文件经常有空行、注释行，请务必找到**实际包含问题代码的那一行**
   - 如果问题涉及某个属性（如 !important、硬编码值），请报告**该属性所在的准确行号**，而不是空行或注释行
   - 例如：如果 \`color: red !important;\` 在第 15 行，就报告 15，不要报告其他行
4. diff 中只显示了变更的行及其上下文，未显示的行不代表不存在
5. 在判断 CSS/样式问题时，请检查完整的文件内容和上下文（如标签的开闭、样式对象的完整性）
6. 如果上下文不足以确定问题（如看不到标签闭合、样式对象结束等），请降低置信度至 0.5 以下或不报告
7. **关键**：返回的 file 字段必须使用下面"变更的文件列表"中的准确路径，不要修改扩展名（如 .less 文件不要写成 .css）

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
      }).filter((issue): issue is Issue => issue !== null && issue.file && issue.message);
    } catch (error) {
      logger.warn('Failed to parse CSSAgent response', { response, error });
      return [];
    }
  }
}

