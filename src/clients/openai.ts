import OpenAI from 'openai';
import { logger } from '../utils/logger.js';

export interface OpenAIConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  timeout?: number;
  maxRetries?: number;
}

export class OpenAIClient {
  private client: OpenAI;
  private config: Required<OpenAIConfig>;

  constructor(config: OpenAIConfig) {
    this.config = {
      temperature: 0,
      topP: 1,
      maxTokens: 4096,
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
   * 完成对话（Chat Completion）
   */
  async complete(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: {
      temperature?: number;
      topP?: number;
      maxTokens?: number;
      responseFormat?: { type: 'json_object' | 'text' };
    }
  ): Promise<string> {
    try {
      const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
        model: this.config.model,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        temperature: options?.temperature ?? this.config.temperature,
        top_p: options?.topP ?? this.config.topP,
        max_tokens: options?.maxTokens ?? this.config.maxTokens,
      };

      // 如果指定了 response_format，添加到请求中
      if (options?.responseFormat) {
        requestOptions.response_format = options.responseFormat;
      }

      const response = await this.client.chat.completions.create(requestOptions);

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from OpenAI');
      }

      return content;
    } catch (error) {
      logger.error('OpenAI completion failed', { error });
      throw error;
    }
  }

  /**
   * 流式完成（可选）
   */
  async *completeStream(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: {
      temperature?: number;
      topP?: number;
      maxTokens?: number;
    }
  ): AsyncGenerator<string, void, unknown> {
    try {
      const stream = await this.client.chat.completions.create({
        model: this.config.model,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        temperature: options?.temperature ?? this.config.temperature,
        top_p: options?.topP ?? this.config.topP,
        max_tokens: options?.maxTokens ?? this.config.maxTokens,
        stream: true,
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          yield content;
        }
      }
    } catch (error) {
      logger.error('OpenAI stream failed', { error });
      throw error;
    }
  }
}

