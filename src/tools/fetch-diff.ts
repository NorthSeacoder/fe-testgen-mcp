import { PhabricatorClient } from '../clients/phabricator.js';
import { Cache } from '../cache/cache.js';
import { parseDiff, generateNumberedDiff } from '../utils/diff-parser.js';
import { computeContentHash } from '../utils/fingerprint.js';
import { isFrontendFile } from '../schemas/diff.js';
import { logger } from '../utils/logger.js';
import type { Diff } from '../schemas/diff.js';

export interface FetchDiffOptions {
  revisionId: string;
  forceRefresh?: boolean;
}

export class FetchDiffTool {
  constructor(
    private phabClient: PhabricatorClient,
    private cache: Cache
  ) {}

  async fetch(options: FetchDiffOptions): Promise<Diff> {
    const { revisionId, forceRefresh = false } = options;
    const cacheKey = `diff:${revisionId}`;

    // 尝试从缓存获取
    if (!forceRefresh) {
      const cached = await this.cache.get<Diff>(cacheKey);
      if (cached) {
        logger.info(`Cache hit for diff ${revisionId}`);
        return cached;
      }
    }

    // 从 Phabricator 获取
    logger.info(`Fetching diff for revision ${revisionId}...`);
    const { diffId, raw } = await this.phabClient.getRawDiff(revisionId);
    const revisionInfo = await this.phabClient.getRevisionInfo(revisionId);

    // 解析 diff
    const diff = parseDiff(raw, revisionId, {
      diffId,
      title: revisionInfo.title,
      summary: revisionInfo.summary,
      author: revisionInfo.authorPHID,
    });

    // 生成带行号的 diff
    diff.numberedRaw = generateNumberedDiff(diff);

    // 缓存结果
    await this.cache.set(cacheKey, diff);

    logger.info(`Fetched diff with ${diff.files.length} files`);
    return diff;
  }

  /**
   * 过滤前端文件
   */
  filterFrontendFiles(diff: Diff): Diff {
    return {
      ...diff,
      files: diff.files.filter(file => isFrontendFile(file.path)),
    };
  }

  /**
   * 计算 diff 指纹
   */
  computeDiffFingerprint(diff: Diff): string {
    // 使用文件路径和变更内容生成指纹
    const content = diff.files.map(f => `${f.path}:${f.additions}:${f.deletions}`).join('|');
    return computeContentHash(content);
  }
}

