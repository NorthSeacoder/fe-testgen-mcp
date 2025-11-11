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
   * 使用核心内容（去除格式）来生成签名，确保格式化前后的评论能匹配
   */
  private generateSignature(comment: Comment | ExistingComment): string {
    const content = 'message' in comment ? comment.message : comment.content;
    // 提取核心内容（去除格式标记）
    const coreContent = this.extractCoreContent(content);
    const prefix = coreContent.substring(0, this.options.signaturePrefixLength).trim();
    return `${comment.file}:${comment.line}:${prefix}`;
  }

  /**
   * 提取评论的核心内容（用于 embedding）
   * 去除格式标记，只保留实际内容
   * 
   * ✅ 增强版：更激进地去除格式和元数据，只保留核心问题描述
   */
  private extractCoreContent(message: string): string {
    let content = message;
    
    // 去除 emoji（如果存在）
    content = content.replace(/^[🚨⚠️ℹ️💡]\s*/, '');
    
    // 去除 markdown 格式标记
    content = content.replace(/\*\*/g, '');
    content = content.replace(/\*\s*/g, '');
    content = content.replace(/`/g, '');
    
    // 去除等级标签 [LEVEL] 或 **LEVEL**:
    content = content.replace(/^\[(?:CRITICAL|HIGH|MEDIUM|LOW)\]\s*/i, '');
    content = content.replace(/^(?:CRITICAL|HIGH|MEDIUM|LOW):\s*/i, '');
    
    // 去除置信度信息 (confidence=x.xx) 或 **置信度**: x%
    content = content.replace(/\s*\(confidence=[\d.]+\)\s*/gi, '');
    content = content.replace(/\*\*置信度\*\*:\s*\d+%\s*/gi, '');
    content = content.replace(/\*\*Confidence\*\*:\s*\d+%\s*/gi, '');
    content = content.replace(/置信度:\s*\d+%\s*/gi, '');
    content = content.replace(/Confidence:\s*\d+%\s*/gi, '');
    
    // 去除维度信息 **维度**: xxx 或 **Topic**: xxx
    content = content.replace(/\*\*维度\*\*:\s*[^\n]+\s*/gi, '');
    content = content.replace(/\*\*Topic\*\*:\s*[^\n]+\s*/gi, '');
    content = content.replace(/维度:\s*[^\n]+\s*/gi, '');
    content = content.replace(/Topic:\s*[^\n]+\s*/gi, '');
    
    // ✅ 去除"建议:"标记及其内容（因为建议可能不同，但核心问题相同）
    content = content.replace(/\*\*建议\*\*:\s*[^\n]+/gi, '');
    content = content.replace(/\*\*Suggestion\*\*:\s*[^\n]+/gi, '');
    content = content.replace(/\n+建议:\s*[^\n]+/gi, '');
    content = content.replace(/\n+Suggestion:\s*[^\n]+/gi, '');
    content = content.replace(/^建议:\s*[^\n]+/gi, '');
    content = content.replace(/^Suggestion:\s*[^\n]+/gi, '');
    
    // ✅ 去除各种可能的分隔符和格式
    content = content.replace(/[-=_]{3,}/g, ''); // 去除分隔线
    content = content.replace(/\n{3,}/g, '\n\n'); // 去除多余的空行
    
    // ✅ 提取核心问题描述（通常在第一行）
    const lines = content.split('\n').filter(line => line.trim().length > 0);
    if (lines.length > 0) {
      // 只保留核心问题描述（通常是第一句话或第一段）
      const coreMessage = lines[0].trim();
      
      // 如果第一行太短（可能只是标题），尝试包含更多内容
      if (coreMessage.length < 20 && lines.length > 1) {
        return lines.slice(0, 2).join(' ').trim();
      }
      
      return coreMessage;
    }
    
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
   * ✅ 增强版：不仅检查精确位置，还检查附近位置（±3行）的相似评论
   * 
   * @returns true 表示重复，应该跳过；false 表示不重复，可以发布
   */
  async isDuplicate(comment: Comment): Promise<{
    isDuplicate: boolean;
    reason?: 'signature' | 'embedding' | 'nearby-embedding';
    similarity?: number;
    matchedLine?: number;
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
        // 2.1 检查精确位置
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
        
        // 2.2 ✅ 检查附近位置（±3行）的相似评论
        const coreContent = this.extractCoreContent(comment.message);
        const [newEmbedding] = await this.embeddingClient.encode([coreContent]);
        const nearbyRange = 3; // 检查前后3行
        
        for (let offset = -nearbyRange; offset <= nearbyRange; offset++) {
          if (offset === 0) continue; // 已经检查过精确位置
          
          const nearbyLine = comment.line + offset;
          const nearbyKey = `${comment.file}:${nearbyLine}`;
          const nearbyEmbedding = this.embeddingCache.get(nearbyKey);
          
          if (nearbyEmbedding) {
            const similarity = this.embeddingClient.cosineSimilarity(nearbyEmbedding, newEmbedding);
            
            // 附近位置使用稍微更严格的阈值（+5%）
            const nearbyThreshold = Math.min(0.95, this.options.similarityThreshold! + 0.05);
            
            if (similarity >= nearbyThreshold) {
              logger.debug(
                `Duplicate found by nearby embedding (similarity=${similarity.toFixed(3)}, offset=${offset}): ${comment.file}:${comment.line} (matched line ${nearbyLine})`
              );
              return { 
                isDuplicate: true, 
                reason: 'nearby-embedding', 
                similarity,
                matchedLine: nearbyLine 
              };
            }
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

