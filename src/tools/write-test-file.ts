import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';

export interface WriteTestFileInput {
  filePath: string;
  content: string;
  overwrite?: boolean;
}

export interface WriteTestFileOutput {
  success: boolean;
  filePath: string;
  error?: string;
}

export class WriteTestFileTool {
  async write(input: WriteTestFileInput): Promise<WriteTestFileOutput> {
    const { filePath, content, overwrite = false } = input;

    try {
      // 确保目录存在
      const dir = dirname(filePath);
      mkdirSync(dir, { recursive: true });

      // 检查文件是否已存在
      if (!overwrite) {
        try {
          const fs = await import('node:fs');
          await fs.promises.access(filePath);
          logger.warn(`File ${filePath} already exists, skipping write (overwrite=false)`);
          return {
            success: false,
            filePath,
            error: 'File already exists. Set overwrite=true to replace it.',
          };
        } catch {
          // 文件不存在，继续写入
        }
      }

      // 写入文件
      writeFileSync(filePath, content, 'utf-8');
      logger.info(`Successfully wrote test file: ${filePath}`);

      return {
        success: true,
        filePath,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to write test file: ${filePath}`, { error: errorMessage });
      return {
        success: false,
        filePath,
        error: errorMessage,
      };
    }
  }

  async writeMultiple(inputs: WriteTestFileInput[]): Promise<WriteTestFileOutput[]> {
    return Promise.all(inputs.map(input => this.write(input)));
  }
}
