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
          changeType: 'modified', // 默认，后续会根据上下文判断
          additions: 0,
          deletions: 0,
          hunks: [],
        };
        currentHunk = null;
        hunkLines = [];
      }
      continue;
    }

    // 新文件：new file mode
    if (line.startsWith('new file mode')) {
      if (currentFile) {
        currentFile.changeType = 'added';
      }
      continue;
    }

    // 删除文件：deleted file mode
    if (line.startsWith('deleted file mode')) {
      if (currentFile) {
        currentFile.changeType = 'deleted';
      }
      continue;
    }

    // 重命名：rename from/to
    if (line.startsWith('rename from') || line.startsWith('rename to')) {
      if (currentFile) {
        currentFile.changeType = 'renamed';
      }
      continue;
    }

    // Hunk 头：@@ -oldStart,oldLines +newStart,newLines @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      // 保存上一个 hunk
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

    // 统计增删行数
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

  // 保存最后一个文件
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
 * 生成带行号的 diff 文本
 * ✅ 优化后的格式，强调新文件行号（NEW_LINE_xxx）
 * 使 AI 更容易识别应该使用的行号
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
    result += `Important: When reporting issues, use NEW_LINE_xxx numbers shown below\n\n`;

    for (const hunk of file.hunks) {
      result += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
      
      let oldLineNum = hunk.oldStart;
      let newLineNum = hunk.newStart;
      
      for (const line of hunk.lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          // 新增行：使用显眼的 NEW_LINE 前缀
          result += `NEW_LINE_${newLineNum}: ${line}\n`;
          newLineNum++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          // 删除行：明确标记为 DELETED（不在新文件中）
          result += `DELETED (was line ${oldLineNum}): ${line}\n`;
          oldLineNum++;
        } else if (!line.startsWith('\\') && !line.startsWith('@@')) {
          // 上下文行：也使用 NEW_LINE 前缀
          result += `NEW_LINE_${newLineNum}: ${line}\n`;
          oldLineNum++;
          newLineNum++;
        } else {
          // 其他行（如 "\ No newline at end of file"）
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

