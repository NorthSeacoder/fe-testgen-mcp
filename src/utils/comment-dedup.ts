/**
 * 评论去重工具
 * 
 * 使用混合策略识别重复评论：
 * 1. 快速路径：签名匹配（文件路径 + 行号 + 内容前缀）
 * 2. 智能路径：Embedding 相似度匹配（语义相似）
 */

import type { EmbeddingClient } from '../clients/embedding.js';
import { logger } from './logger.js';

export interface Comment {
  file: string;
  line: number;
  message: string;
}

export interface ExistingComment {
  file: string;
  line: number;
  content: string;
}

/**
 * 评论签名（用于快速精确匹配）
 */
export interface CommentSignature {
  file: string;
  line: number;
  contentPrefix: string; // 内容前100字符
}

/**
 * 评论去重器
 */
export class CommentDeduplicator {
  private signatureCache: Set<string>;
  private embeddingCache: Map<string, number[]>;
  
  constructor(
    private embeddingClient: EmbeddingClient | null,
    private options: {
      /** 签名匹配的内容前缀长度 */
      signaturePrefixLength?: number;
      /** Embedding 相似度阈值（0-1） */
      similarityThreshold?: number;
      /** 是否启用 embedding 匹配 */
      enableEmbedding?: boolean;
    } = {}
  ) {
    this.signatureCache = new Set();
    this.embeddingCache = new Map();
    
    this.options = {
      signaturePrefixLength: 100,
      similarityThreshold: 0.90, // 90% 相似度认为是重复
      enableEmbedding: true,
      ...options,
    };
  }

  /**
   * 生成评论签名
   */
  private generateSignature(comment: Comment | ExistingComment): string {
    const content = 'message' in comment ? comment.message : comment.content;
    const prefix = content.substring(0, this.options.signaturePrefixLength).trim();
    return `${comment.file}:${comment.line}:${prefix}`;
  }

  /**
   * 提取评论的核心内容（用于 embedding）
   * 去除格式标记，只保留实际内容
   */
  private extractCoreContent(message: string): string {
    // 去除等级标签 [LEVEL]
    let content = message.replace(/^\[(?:CRITICAL|HIGH|MEDIUM|LOW)\]\s*/i, '');
    
    // 去除置信度信息 (confidence=x.xx)
    content = content.replace(/\s*\(confidence=[\d.]+\)\s*$/i, '');
    
    // 去除"建议:"标记
    content = content.replace(/\n建议:\s*/g, '\n');
    content = content.replace(/\nSuggestion:\s*/g, '\n');
    
    return content.trim();
  }

  /**
   * 加载已有评论
   */
  async loadExisting(existingComments: ExistingComment[]): Promise<void> {
    logger.info(`Loading ${existingComments.length} existing comments for deduplication`);
    
    // 1. 构建签名缓存
    this.signatureCache.clear();
    for (const comment of existingComments) {
      const sig = this.generateSignature(comment);
      this.signatureCache.add(sig);
    }
    
    // 2. 构建 embedding 缓存（如果启用）
    if (this.options.enableEmbedding && this.embeddingClient) {
      this.embeddingCache.clear();
      
      try {
        // 批量编码所有已有评论
        const contents = existingComments.map(c => this.extractCoreContent(c.content));
        const embeddings = await this.embeddingClient.encode(contents);
        
        for (let i = 0; i < existingComments.length; i++) {
          const key = `${existingComments[i].file}:${existingComments[i].line}`;
          this.embeddingCache.set(key, embeddings[i]);
        }
        
        logger.info(`Cached ${embeddings.length} comment embeddings`);
      } catch (error) {
        logger.warn('Failed to generate embeddings for existing comments', { error });
      }
    }
  }

  /**
   * 检查评论是否重复
   * 
   * @returns true 表示重复，应该跳过；false 表示不重复，可以发布
   */
  async isDuplicate(comment: Comment): Promise<{
    isDuplicate: boolean;
    reason?: 'signature' | 'embedding';
    similarity?: number;
  }> {
    // 1. 快速路径：签名匹配
    const sig = this.generateSignature(comment);
    if (this.signatureCache.has(sig)) {
      logger.debug(`Duplicate found by signature: ${comment.file}:${comment.line}`);
      return { isDuplicate: true, reason: 'signature' };
    }

    // 2. 智能路径：Embedding 相似度匹配
    if (this.options.enableEmbedding && this.embeddingClient && this.embeddingCache.size > 0) {
      try {
        const key = `${comment.file}:${comment.line}`;
        const existingEmbedding = this.embeddingCache.get(key);
        
        if (existingEmbedding) {
          // 同一位置有评论，检查内容相似度
          const coreContent = this.extractCoreContent(comment.message);
          const [newEmbedding] = await this.embeddingClient.encode([coreContent]);
          
          const similarity = this.embeddingClient.cosineSimilarity(existingEmbedding, newEmbedding);
          
          logger.debug(
            `Embedding similarity for ${comment.file}:${comment.line}: ${similarity.toFixed(3)}`
          );
          
          if (similarity >= this.options.similarityThreshold!) {
            logger.debug(
              `Duplicate found by embedding (similarity=${similarity.toFixed(3)}): ${comment.file}:${comment.line}`
            );
            return { isDuplicate: true, reason: 'embedding', similarity };
          }
        }
      } catch (error) {
        logger.warn('Failed to check embedding similarity', { error });
        // 失败时不影响发布流程
      }
    }

    return { isDuplicate: false };
  }

  /**
   * 批量检查评论是否重复
   */
  async filterDuplicates(comments: Comment[]): Promise<{
    unique: Comment[];
    duplicates: Array<Comment & { reason: string; similarity?: number }>;
  }> {
    const unique: Comment[] = [];
    const duplicates: Array<Comment & { reason: string; similarity?: number }> = [];

    for (const comment of comments) {
      const result = await this.isDuplicate(comment);
      if (result.isDuplicate) {
        duplicates.push({
          ...comment,
          reason: result.reason || 'unknown',
          similarity: result.similarity,
        });
      } else {
        unique.push(comment);
      }
    }

    logger.info(
      `Deduplication result: ${unique.length} unique, ${duplicates.length} duplicates (signature: ${
        duplicates.filter(d => d.reason === 'signature').length
      }, embedding: ${duplicates.filter(d => d.reason === 'embedding').length})`
    );

    return { unique, duplicates };
  }

  /**
   * 重置缓存
   */
  reset(): void {
    this.signatureCache.clear();
    this.embeddingCache.clear();
  }
}

