import { createHash } from 'node:crypto';

/**
 * 生成稳定指纹（SHA256 hash）
 */
export function generateFingerprint(...parts: (string | number)[]): string {
  const combined = parts.map(p => String(p)).join('|');
  return createHash('sha256').update(combined).digest('hex').substring(0, 16);
}

/**
 * 生成测试的稳定指纹
 */
export function generateTestFingerprint(
  file: string,
  testName: string,
  scenario: string
): string {
  return generateFingerprint(file, testName, scenario);
}

/**
 * 计算内容的哈希值（用于 diff 指纹）
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

