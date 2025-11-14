/**
 * CodeChangeSource - 统一的代码变更来源抽象
 *
 * 目标：无论变更来自 git、外部工作流还是直接传入的 diff，都以一致的方式提供数据。
 */

import type { Diff } from '../schemas/diff.js';

export interface CodeChangeMetadata {
  source: 'git' | 'raw' | 'workflow';
  identifier: string;
  title?: string;
  author?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface CodeChangeSource {
  fetchChanges(): Promise<Diff>;
  getMetadata(): CodeChangeMetadata;
  getIdentifier(): string;
}

/**
 * Raw Diff Source（外部传入）
 */
export class RawDiffSource implements CodeChangeSource {
  constructor(
    private identifier: string,
    private diff: Diff,
    private metadata?: Partial<CodeChangeMetadata>
  ) {}

  async fetchChanges(): Promise<Diff> {
    return this.diff;
  }

  getMetadata(): CodeChangeMetadata {
    return {
      source: this.metadata?.source ?? 'raw',
      identifier: this.identifier,
      ...this.metadata,
    };
  }

  getIdentifier(): string {
    return this.identifier;
  }
}
