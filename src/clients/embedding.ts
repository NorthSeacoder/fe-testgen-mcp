import OpenAI from 'openai';
import { logger } from '../utils/logger.js';

export interface EmbeddingConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  timeout?: number;
  maxRetries?: number;
}

export class EmbeddingClient {
  private client: OpenAI;
  private config: Required<EmbeddingConfig>;

  constructor(config: EmbeddingConfig) {
    this.config = {
      timeout: 60000,
      maxRetries: 3,
      baseURL: 'https://api.openai.com/v1',
      ...config,
    };

    this.client = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL,
      timeout: this.config.timeout,
      maxRetries: this.config.maxRetries,
    });
  }

  /**
   * 编码文本为向量
   */
  async encode(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    // 过滤和清理输入文本
    const validTexts = texts.filter(t => t && t.trim().length > 0);
    if (validTexts.length === 0) {
      logger.warn('All input texts are empty, skipping embedding');
      return texts.map(() => []);
    }

    // 如果有被过滤的文本，记录警告
    if (validTexts.length < texts.length) {
      logger.warn(`Filtered out ${texts.length - validTexts.length} empty texts from embedding input`);
    }

    try {
      const response = await this.client.embeddings.create({
        model: this.config.model,
        input: validTexts,
      });

      // 如果有被过滤的文本，需要在返回结果中补充空数组
      const embeddings = response.data.map(item => item.embedding);
      
      // 重新映射结果，为空文本返回空数组
      let embeddingIndex = 0;
      return texts.map(text => {
        if (!text || text.trim().length === 0) {
          return [];
        }
        return embeddings[embeddingIndex++];
      });
    } catch (error: any) {
      logger.error('Embedding encoding failed', { 
        error,
        errorMessage: error?.message,
        errorResponse: error?.response?.data,
        errorCode: error?.code,
        errorStatus: error?.status,
        model: this.config.model,
        baseURL: this.config.baseURL,
        textsCount: texts.length,
        validTextsCount: validTexts.length,
        textsPreview: validTexts.slice(0, 2).map(t => t.substring(0, 100))
      });
      throw error;
    }
  }

  /**
   * 编码单个文本为向量
   */
  async encodeOne(text: string): Promise<number[]> {
    const result = await this.encode([text]);
    return result[0] || [];
  }

  /**
   * 计算余弦相似度
   */
  cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) {
      throw new Error('Vectors must have the same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) {
      return 0;
    }

    return dotProduct / denominator;
  }
}

