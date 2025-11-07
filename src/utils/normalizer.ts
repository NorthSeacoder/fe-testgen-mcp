import { generateFingerprint, generateIssueFingerprint, generateTestFingerprint } from './fingerprint.js';

export { generateFingerprint, generateIssueFingerprint, generateTestFingerprint };

/**
 * 规范化文件路径
 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}

/**
 * 规范化换行符
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * 规范化空白字符
 */
export function normalizeWhitespace(text: string): string {
  // 保留换行符，但规范化其他空白
  return text.replace(/[ \t]+/g, ' ').replace(/ +\n/g, '\n');
}

/**
 * 规范化输入文本
 */
export function normalizeInput(text: string): string {
  let normalized = normalizeLineEndings(text);
  normalized = normalizeWhitespace(normalized);
  return normalized.trim();
}

/**
 * 规范化输出对象（排序字段）
 */
export function normalizeOutput<T extends Record<string, unknown>>(obj: T): T {
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) {
      sorted[key] = value.map(item => 
        typeof item === 'object' && item !== null ? normalizeOutput(item as Record<string, unknown>) : item
      );
    } else if (typeof value === 'object' && value !== null) {
      sorted[key] = normalizeOutput(value as Record<string, unknown>);
    } else {
      sorted[key] = value;
    }
  }
  return sorted as T;
}

/**
 * 截断超长文本（固定策略）
 */
export function truncateText(text: string, maxLength: number = 50000): string {
  if (text.length <= maxLength) {
    return text;
  }
  // 截断到最接近的换行符
  const truncated = text.substring(0, maxLength);
  const lastNewline = truncated.lastIndexOf('\n');
  if (lastNewline > maxLength * 0.8) {
    return truncated.substring(0, lastNewline) + '\n...(truncated)';
  }
  return truncated + '\n...(truncated)';
}

