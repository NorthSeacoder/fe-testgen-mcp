import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 项目根目录（编译后代码在 dist 目录，向上一级到项目根）
export const PROJECT_ROOT = resolve(__dirname, '..');

/**
 * 获取项目根目录下的路径
 */
export function getProjectPath(...paths: string[]): string {
  return resolve(PROJECT_ROOT, ...paths);
}

