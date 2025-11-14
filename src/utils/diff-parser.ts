import type { Diff, DiffFile } from '../schemas/diff.js';
import { normalizeInput } from './normalizer.js';

/**
 * 解析 diff 文本
 */
export function parseDiff(rawDiff: string, revisionId: string, metadata?: {
  diffId?: string;
  title?: string;
  summary?: string;
  author?: string;
}): Diff {
  const normalized = normalizeInput(rawDiff);
  const lines = normalized.split('\n');
  
  const files: DiffFile[] = [];
  let currentFile: DiffFile | null = null;
  let currentHunk: DiffFile['hunks'][0] | null = null;
  let hunkLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // 文件头：diff --git a/path b/path
    if (line.startsWith('diff --git')) {
      // 保存上一个文件
      if (currentFile && currentHunk) {
        currentHunk.lines = hunkLines;
        currentFile.hunks.push(currentHunk);
        files.push(currentFile);
      }
      
      const match = line.match(/diff --git a\/(.+?) b\/(.+?)$/);
      if (match) {
        const newPath = match[2];
        currentFile = {
          path: newPath,
          changeType: 'modified',
          additions: 0,
          deletions: 0,
          hunks: [],
        };
        currentHunk = null;
        hunkLines = [];
      }
      continue;
    }

    if (line.startsWith('new file mode')) {
      if (currentFile) {
        currentFile.changeType = 'added';
      }
      continue;
    }

    if (line.startsWith('deleted file mode')) {
      if (currentFile) {
        currentFile.changeType = 'deleted';
      }
      continue;
    }

    if (line.startsWith('rename from') || line.startsWith('rename to')) {
      if (currentFile) {
        currentFile.changeType = 'renamed';
      }
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (currentHunk && currentFile) {
        currentHunk.lines = hunkLines;
        currentFile.hunks.push(currentHunk);
      }

      const oldStart = parseInt(hunkMatch[1], 10);
      const oldLines = parseInt(hunkMatch[2] || '1', 10);
      const newStart = parseInt(hunkMatch[3], 10);
      const newLines = parseInt(hunkMatch[4] || '1', 10);

      currentHunk = {
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: [],
      };
      hunkLines = [];
      continue;
    }

    if (currentFile && currentHunk) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentFile.additions++;
        hunkLines.push(line);
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentFile.deletions++;
        hunkLines.push(line);
      } else {
        hunkLines.push(line);
      }
    }
  }

  if (currentFile) {
    if (currentHunk) {
      currentHunk.lines = hunkLines;
      currentFile.hunks.push(currentHunk);
    }
    files.push(currentFile);
  }

  return {
    revisionId,
    diffId: metadata?.diffId,
    title: metadata?.title,
    summary: metadata?.summary,
    author: metadata?.author,
    files,
    raw: rawDiff,
  };
}

/**
 * 生成带行号的 diff 文本，突出 NEW_LINE_xxx 标记，方便测试生成阶段引用
 */
export function generateNumberedDiff(diff: Diff): string {
  let result = '';
  
  if (diff.title) {
    result += `Title: ${diff.title}\n`;
  }
  if (diff.summary) {
    result += `Summary: ${diff.summary}\n`;
  }
  result += '\n';

  for (const file of diff.files) {
    result += `File: ${file.path}\n`;
    result += `Changes: +${file.additions} -${file.deletions}\n`;
    result += `Hint: Use NEW_LINE_xxx markers when referencing lines in this file\n\n`;

    for (const hunk of file.hunks) {
      result += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
      
      let oldLineNum = hunk.oldStart;
      let newLineNum = hunk.newStart;
      
      for (const line of hunk.lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          result += `NEW_LINE_${newLineNum}: ${line} ← CHANGED (ADDED)\n`;
          newLineNum++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          result += `DELETED (was line ${oldLineNum}): ${line} ← REMOVED\n`;
          oldLineNum++;
        } else if (!line.startsWith('\\') && !line.startsWith('@@')) {
          result += `NEW_LINE_${newLineNum}: ${line} ← CONTEXT\n`;
          oldLineNum++;
          newLineNum++;
        } else {
          result += line + '\n';
        }
      }
      result += '\n';
    }
  }

  return result;
}

/**
 * 获取文件的变更行号范围
 */
export function getChangedLineRanges(file: DiffFile): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  
  for (const hunk of file.hunks) {
    const start = hunk.newStart;
    const end = hunk.newStart + hunk.newLines - 1;
    ranges.push([start, end]);
  }
  
  return ranges;
}

/**
 * 将旧行号映射到新行号
 * 优先返回新增行或修改行的新行号；如果对应的是删除的行，返回 null
 */
export function mapOldLineToNewLine(file: DiffFile, oldLine: number): number | null {
  for (const hunk of file.hunks) {
    // 检查是否在这个 hunk 的旧行范围内
    const oldEnd = hunk.oldStart + hunk.oldLines - 1;
    if (oldLine >= hunk.oldStart && oldLine <= oldEnd) {
      // 计算在 hunk 中的相对位置
      const relativeOldLine = oldLine - hunk.oldStart;
      
      // 遍历 hunk 的 lines，找到对应的新行号
      let oldLineIdx = 0;
      let newLineIdx = 0;
      
      for (const line of hunk.lines) {
        if (line.startsWith('-') && !line.startsWith('---')) {
          // 删除的行（旧版本）
          if (oldLineIdx === relativeOldLine) {
            // 这是删除的行，返回 null（新版本没有这行）
            return null;
          }
          oldLineIdx++;
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          // 新增的行（新版本）
          if (oldLineIdx === relativeOldLine) {
            // 旧行号对应新增行，返回新行号
            return hunk.newStart + newLineIdx;
          }
          newLineIdx++;
        } else if (!line.startsWith('\\') && !line.startsWith('@@')) {
          // 上下文行（不变的行）
          if (oldLineIdx === relativeOldLine) {
            // 找到对应的新行号
            return hunk.newStart + newLineIdx;
          }
          oldLineIdx++;
          newLineIdx++;
        }
      }
      
      // 如果在 hunk 范围内但没找到精确匹配，返回新起始行号
      return hunk.newStart;
    }
  }
  
  // 如果不在任何 hunk 中，可能是新增文件的旧行号
  if (file.changeType === 'added') {
    return oldLine;
  }
  
  // 找不到映射，返回 null
  return null;
}

/**
 * 查找新行号对应的新增行或修改行
 * 如果行号在新增的行上，返回该行号；如果在删除的行上，返回 null
 */
export function findNewLineNumber(file: DiffFile, targetLine: number): number | null {
  // 如果行号在新增行范围内，检查是否是新增行或上下文行
  for (const hunk of file.hunks) {
    const newEnd = hunk.newStart + hunk.newLines - 1;
    if (targetLine >= hunk.newStart && targetLine <= newEnd) {
      // 遍历 hunk 的行，找到目标行号对应的行
      let currentNewLine = hunk.newStart;
      
      for (const line of hunk.lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          // 新增的行
          if (currentNewLine === targetLine) {
            return targetLine; // 这是新增行，返回新行号
          }
          currentNewLine++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          // 删除的行，新行号不变（这些行不在新版本中）
          // 不增加 currentNewLine
        } else if (!line.startsWith('\\') && !line.startsWith('@@')) {
          // 上下文行（不变的行）
          if (currentNewLine === targetLine) {
            return targetLine; // 这是上下文行，也在新版本中，可以发布
          }
          currentNewLine++;
        }
      }
    }
  }
  
  // 如果不在任何 hunk 的新行范围内，可能是新增文件的任意行
  if (file.changeType === 'added') {
    return targetLine;
  }
  
  // 找不到映射，返回 null（可能是删除的行）
  return null;
}

/**
 * 可评论行的详细信息
 */
export interface ReviewableLineDetail {
  line: number;
  type: 'added' | 'context';
  content: string;
  raw: string;
}

/**
 * 获取文件中所有可评论行的详细信息（新增行和上下文行）
 */
export function getReviewableLineDetails(file: DiffFile): ReviewableLineDetail[] {
  const details: ReviewableLineDetail[] = [];
  
  for (const hunk of file.hunks) {
    let currentNewLine = hunk.newStart;
    
    for (const line of hunk.lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        details.push({
          line: currentNewLine,
          type: 'added',
          content: line.substring(1).trim(),
          raw: line,
        });
        currentNewLine++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        // 删除的行，不可评论
      } else if (!line.startsWith('\\') && !line.startsWith('@@')) {
        details.push({
          line: currentNewLine,
          type: 'context',
          content: line.substring(1).trim(),
          raw: line,
        });
        currentNewLine++;
      }
    }
  }
  
  return details;
}

/**
 * 获取文件中所有可评论的行号（新增行和上下文行）
 * 用于验证 AI 返回的行号是否有效
 */
export function getReviewableLines(file: DiffFile): Set<number> {
  return new Set(getReviewableLineDetails(file).map(detail => detail.line));
}

/**
 * 验证并修正行号
 * 如果行号无效，尝试在附近找到最接近的可评论行号
 * @returns { valid: boolean, line: number | null, reason?: string }
 */
export function validateAndCorrectLineNumber(
  file: DiffFile,
  targetLine: number,
  maxSearchDistance: number = 3
): { valid: boolean; line: number | null; reason?: string; suggestion?: number } {
  const reviewableLines = getReviewableLines(file);
  
  // 如果行号直接有效，返回
  if (reviewableLines.has(targetLine)) {
    return { valid: true, line: targetLine };
  }
  
  // 行号无效，尝试查找原因
  let reason = 'Line number not in any hunk';
  
  // 检查是否在某个 hunk 的范围内
  for (const hunk of file.hunks) {
    const newEnd = hunk.newStart + hunk.newLines - 1;
    if (targetLine >= hunk.newStart && targetLine <= newEnd) {
      // 在 hunk 范围内但不可评论，说明是删除的行
      reason = 'Line is in a deleted section (not reviewable)';
      
      // 尝试在附近找到可评论的行
      for (let distance = 1; distance <= maxSearchDistance; distance++) {
        // 先向后找（优先找新增行）
        const nextLine = targetLine + distance;
        if (reviewableLines.has(nextLine) && nextLine <= newEnd) {
          return {
            valid: false,
            line: null,
            reason,
            suggestion: nextLine,
          };
        }
        
        // 再向前找
        const prevLine = targetLine - distance;
        if (reviewableLines.has(prevLine) && prevLine >= hunk.newStart) {
          return {
            valid: false,
            line: null,
            reason,
            suggestion: prevLine,
          };
        }
      }
      
      break;
    }
  }
  
  return { valid: false, line: null, reason };
}

/**
 * 生成行号验证的调试信息
 */
export function generateLineValidationDebugInfo(file: DiffFile): string {
  const details = getReviewableLineDetails(file);
  let info = `File: ${file.path}\n`;
  info += `Change type: ${file.changeType}\n`;
  info += `Hunks: ${file.hunks.length}\n\n`;
  
  for (let i = 0; i < file.hunks.length; i++) {
    const hunk = file.hunks[i];
    info += `Hunk ${i + 1}: @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
    info += `  New line range: ${hunk.newStart} - ${hunk.newStart + hunk.newLines - 1}\n`;
    
    const hunkDetails = details.filter(
      d => d.line >= hunk.newStart && d.line < hunk.newStart + hunk.newLines
    );
    
    info += `  Reviewable lines (${hunkDetails.length}):\n`;
    for (const detail of hunkDetails) {
      info += `    - Line ${detail.line} (${detail.type}): ${detail.content.substring(0, 60)}\n`;
    }
    info += '\n';
  }
  
  return info;
}

/**
 * 代码片段匹配选项
 */
export interface CodeSnippetMatchOptions {
  fuzzyMatch?: boolean;        // 是否允许模糊匹配（忽略空格差异）
  maxDistance?: number;        // 最大编辑距离（用于模糊匹配）
  preferAddedLines?: boolean;  // 是否优先匹配新增行
}

/**
 * 在 diff 文件中查找代码片段对应的行号
 * 
 * @param file - DiffFile 对象
 * @param codeSnippet - 要查找的代码片段（可以是完整行或部分代码）
 * @param options - 匹配选项
 * @returns 匹配到的行号，如果找不到返回 null
 */
export function findLineNumberByCodeSnippet(
  file: DiffFile,
  codeSnippet: string,
  options: CodeSnippetMatchOptions = {}
): number | null {
  const {
    fuzzyMatch = true,
    preferAddedLines = true,
  } = options;
  
  // 规范化代码片段（移除首尾空格，统一换行符）
  const normalizedSnippet = codeSnippet.trim().replace(/\r\n/g, '\n');
  
  // 如果代码片段为空，返回 null
  if (!normalizedSnippet) {
    return null;
  }
  
  // 收集所有可评论行及其内容
  const reviewableLines = getReviewableLineDetails(file);
  
  // 用于存储匹配结果
  const matches: Array<{ line: number; type: 'added' | 'context'; score: number }> = [];
  
  for (const detail of reviewableLines) {
    // 提取行内容（去除 +/- 前缀和首尾空格）
    const lineContent = detail.content;
    const rawLineContent = detail.raw.replace(/^[+\-\s]/, '').trim();
    
    // 精确匹配
    if (lineContent.includes(normalizedSnippet) || rawLineContent.includes(normalizedSnippet)) {
      matches.push({
        line: detail.line,
        type: detail.type,
        score: 100, // 精确匹配得分最高
      });
      continue;
    }
    
    // 模糊匹配（移除所有空格后比较）
    if (fuzzyMatch) {
      const normalizedLineContent = lineContent.replace(/\s+/g, '');
      const normalizedSnippetNoSpace = normalizedSnippet.replace(/\s+/g, '');
      
      if (normalizedLineContent.includes(normalizedSnippetNoSpace)) {
        matches.push({
          line: detail.line,
          type: detail.type,
          score: 80, // 模糊匹配得分较低
        });
        continue;
      }
      
      // 部分匹配（代码片段包含行内容或行内容包含代码片段的主要部分）
      const snippetWords = normalizedSnippet.split(/\s+/).filter(w => w.length > 2);
      const lineWords = lineContent.split(/\s+/).filter(w => w.length > 2);
      
      if (snippetWords.length > 0 && lineWords.length > 0) {
        const matchingWords = snippetWords.filter(word => 
          lineWords.some(lineWord => lineWord.includes(word) || word.includes(lineWord))
        );
        
        const matchRatio = matchingWords.length / snippetWords.length;
        
        if (matchRatio >= 0.6) { // 至少 60% 的关键词匹配
          matches.push({
            line: detail.line,
            type: detail.type,
            score: Math.floor(matchRatio * 60), // 部分匹配得分更低
          });
        }
      }
    }
  }
  
  // 如果没有匹配，返回 null
  if (matches.length === 0) {
    return null;
  }
  
  // 按优先级排序：得分 > 类型（新增优先） > 行号（较小的优先）
  matches.sort((a, b) => {
    // 1. 得分高的优先
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    
    // 2. 如果优先新增行，新增行优先
    if (preferAddedLines) {
      if (a.type === 'added' && b.type !== 'added') return -1;
      if (a.type !== 'added' && b.type === 'added') return 1;
    }
    
    // 3. 行号较小的优先（通常问题出现在第一次出现的位置）
    return a.line - b.line;
  });
  
  return matches[0].line;
}

/**
 * 批量查找代码片段对应的行号
 * 
 * @param file - DiffFile 对象
 * @param codeSnippets - 代码片段数组
 * @param options - 匹配选项
 * @returns 行号数组，与输入顺序对应，找不到的为 null
 */
export function findLineNumbersByCodeSnippets(
  file: DiffFile,
  codeSnippets: string[],
  options: CodeSnippetMatchOptions = {}
): Array<number | null> {
  return codeSnippets.map(snippet => findLineNumberByCodeSnippet(file, snippet, options));
}

/**
 * 从完整 diff 中提取单个文件的 diff 片段
 */
export function extractFileDiff(rawDiff: string, filePath: string): string {
  const normalized = normalizeInput(rawDiff);
  const lines = normalized.split('\n');
  
  let result: string[] = [];
  let inTargetFile = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // 文件头：diff --git a/path b/path
    if (line.startsWith('diff --git')) {
      const match = line.match(/diff --git a\/(.+?) b\/(.+?)$/);
      if (match) {
        const currentFilePath = match[2];
        inTargetFile = currentFilePath === filePath;
        
        if (inTargetFile) {
          result = [line]; // 开始收集该文件的 diff
        } else {
          // 遇到新文件，停止收集（如果之前在处理目标文件）
          if (result.length > 0) {
            break;
          }
        }
      }
      continue;
    }
    
    // 如果当前在处理目标文件，收集所有行直到下一个文件
    if (inTargetFile) {
      result.push(line);
    }
  }
  
  const extracted = result.join('\n');
  
  // 如果提取失败（结果为空或只有文件头），返回文件路径提示
  if (!extracted || extracted.trim() === '' || result.length <= 1) {
    return `文件 ${filePath} 无变更或提取失败`;
  }
  
  return extracted;
}

