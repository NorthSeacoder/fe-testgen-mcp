import { logger } from '../utils/logger.js';

export interface PhabricatorConfig {
  host: string;
  token: string;
  timeout?: number;
}

export interface RevisionInfo {
  id: string;
  title?: string;
  summary?: string;
  authorPHID?: string;
  diffs?: number[];
}

export interface InlineComment {
  id: string;
  file: string;
  line: number;
  content: string;
}

export class PhabricatorClient {
  private baseUrl: string;
  private apiToken: string;
  private timeout: number;

  constructor(config: PhabricatorConfig) {
    let host = config.host;
    if (!host.startsWith('http')) {
      host = `https://${host}`;
    }
    this.baseUrl = host.replace(/\/$/, '') + '/api';
    this.apiToken = config.token;
    this.timeout = config.timeout || 30000;
  }

  private async post(endpoint: string, data: Record<string, unknown>): Promise<unknown> {
    const url = `${this.baseUrl}/${endpoint}`;
    const formData = new URLSearchParams();
    formData.append('api.token', this.apiToken);

    // Phabricator Conduit API 需要特殊处理数组参数
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          formData.append(`${key}[${i}]`, String(value[i]));
        }
      } else {
        formData.append(key, String(value));
      }
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const content = await response.json();

      // Phabricator wraps errors in JSON
      // 注意：正常响应也包含 error_code: null，所以需要检查值不为 null
      if (typeof content === 'object' && content !== null && 'error_code' in content && (content as { error_code?: string | null }).error_code !== null) {
        const errorInfo = (content as { error_info?: string }).error_info || 'Phabricator API error';
        logger.error(`Phabricator API error: code=${(content as { error_code?: string }).error_code} info=${errorInfo}`);
        throw new Error(errorInfo);
      }

      return content;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(`Phabricator request failed: ${url}`, { 
        error: errorMessage,
        stack: errorStack,
        url 
      });
      throw error;
    }
  }

  /**
   * 获取 Revision 信息
   */
  async getRevisionInfo(revisionId: string | number): Promise<RevisionInfo> {
    const revisionIdStr = String(revisionId).replace(/^D/i, '');
    
    const result = await this.post('differential.query', {
      ids: [parseInt(revisionIdStr, 10)],
    }) as { result?: RevisionInfo[] };

    if (!result.result || result.result.length === 0) {
      throw new Error(`Revision D${revisionIdStr} not found`);
    }

    return result.result[0];
  }

  /**
   * 获取原始 diff 内容
   */
  async getRawDiff(revisionId: string | number): Promise<{ diffId: string; raw: string }> {
    const revisionIdStr = String(revisionId).replace(/^D/i, '');
    
    logger.info(`获取 Revision D${revisionIdStr} 的信息...`);
    const revisionInfo = await this.getRevisionInfo(revisionIdStr);
    
    const diffs = revisionInfo.diffs || [];
    if (diffs.length === 0) {
      throw new Error(`No diff found for Revision D${revisionIdStr}`);
    }

    const diffId = String(diffs[diffs.length - 1]); // 最新的 diff
    logger.info(`找到最新的 Diff ID: ${diffId}`);

    const result = await this.post('differential.getrawdiff', {
      diffID: diffId,
    }) as { result?: string };

    const rawDiff = result.result;
    if (!rawDiff) {
      throw new Error(`Failed to get raw diff for Diff ID ${diffId}`);
    }

    logger.info(`成功获取 diff 内容，大小: ${rawDiff.length} 字节`);
    return { diffId, raw: rawDiff };
  }

  /**
   * 获取 diff 的详细信息（包含更多上下文）
   * 
   * 可以通过 context 参数控制上下文行数
   */
  async getDiffWithContext(
    revisionId: string | number,
    contextLines: number = 3
  ): Promise<{ diffId: string; raw: string; changes: unknown[] }> {
    const revisionIdStr = String(revisionId).replace(/^D/i, '');
    
    logger.info(`获取 Revision D${revisionIdStr} 的详细 diff 信息（上下文行数: ${contextLines}）...`);
    const revisionInfo = await this.getRevisionInfo(revisionIdStr);
    
    const diffs = revisionInfo.diffs || [];
    if (diffs.length === 0) {
      throw new Error(`No diff found for Revision D${revisionIdStr}`);
    }

    const diffId = String(diffs[diffs.length - 1]);
    logger.info(`找到最新的 Diff ID: ${diffId}`);

    // 获取原始 diff
    const rawResult = await this.post('differential.getrawdiff', {
      diffID: diffId,
    }) as { result?: string };

    const rawDiff = rawResult.result;
    if (!rawDiff) {
      throw new Error(`Failed to get raw diff for Diff ID ${diffId}`);
    }

    // 获取 diff 详细信息（包含文件列表和变更详情）
    const diffInfoResult = await this.post('differential.querydiffs', {
      ids: [parseInt(diffId, 10)],
    }) as { result?: Record<string, { changes?: unknown[] }> };

    const diffInfo = diffInfoResult.result?.[diffId];
    const changes = diffInfo?.changes || [];

    logger.info(`成功获取 diff 详细信息，文件数: ${changes.length}`);
    return { diffId, raw: rawDiff, changes };
  }

  /**
   * 创建 inline comment
   */
  async createInline(
    revisionId: string | number,
    filePath: string,
    isNewFile: boolean,
    lineNumber: number,
    content: string,
    lineLength: number = 0
  ): Promise<unknown> {
    const revisionIdStr = String(revisionId).replace(/^D/i, '');
    
    return this.post('differential.createinline', {
      revisionID: revisionIdStr,
      filePath,
      isNewFile: isNewFile ? 1 : 0,
      lineNumber,
      lineLength,
      content,
    });
  }

  /**
   * 提交评论
   */
  async submitComments(
    revisionId: string | number,
    message: string = 'reviewed by AI',
    attachInlines: boolean = true
  ): Promise<unknown> {
    const revisionIdStr = String(revisionId).replace(/^D/i, '');
    
    return this.post('differential.createcomment', {
      revision_id: revisionIdStr,
      message,
      attach_inlines: attachInlines ? 1 : 0,
    });
  }

  /**
   * 获取已有的 inline comments
   */
  async getExistingInlines(revisionId: string | number): Promise<InlineComment[]> {
    const revisionIdStr = String(revisionId).replace(/^D/i, '');
    
    try {
      const revisionInfo = await this.getRevisionInfo(revisionIdStr);
      const diffs = revisionInfo.diffs || [];
      
      if (diffs.length === 0) {
        logger.warning(`No diff found for Revision D${revisionIdStr}`);
        return [];
      }

      const diffId = String(diffs[diffs.length - 1]);
      const result = await this.post('differential.getdiff', {
        diffID: diffId,
      }) as { result?: { properties?: { 'arc:inlines'?: InlineComment[] } } };

      const diffInfo = result.result || {};
      const properties = diffInfo.properties || {};
      const inlines = properties['arc:inlines'] || [];

      logger.info(`Found ${inlines.length} existing inline comments for D${revisionIdStr}`);
      return inlines;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.warning(`Failed to get existing inlines for D${revisionIdStr}`, { 
        error: errorMessage,
        stack: errorStack
      });
      return [];
    }
  }
}

