import { readFileSync } from 'node:fs';
import { OpenAIClient } from '../clients/openai.js';
import { retry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

export interface AgentResult<T> {
  items: T[];
  confidence: number; // 平均置信度
}

export interface BaseAgentConfig {
  name: string;
  promptPath: string;
  description: string;
  projectContextPrompt?: string; // 项目特定规则 prompt（可选）
}

export abstract class BaseAgent<T> {
  protected openai: OpenAIClient;
  protected config: BaseAgentConfig;
  protected prompt: string;
  protected basePrompt: string;
  private currentProjectContext?: string;

  constructor(openai: OpenAIClient, config: BaseAgentConfig) {
    this.openai = openai;
    this.config = config;
    
    // 如果 promptPath 为空，说明该 Agent 不使用外部 prompt 文件
    if (config.promptPath) {
      this.basePrompt = this.loadPrompt(config.promptPath);
      this.currentProjectContext = config.projectContextPrompt;
      this.prompt = this.buildFullPrompt(this.basePrompt, this.currentProjectContext);
    } else {
      // 不使用外部 prompt，设置为空字符串
      this.basePrompt = '';
      this.prompt = '';
      this.currentProjectContext = undefined;
    }
  }

  /**
   * 构建完整的 prompt（基础 prompt + 项目特定规则）
   */
  private buildFullPrompt(base: string, projectContext?: string): string {
    if (projectContext) {
      if (base) {
        return `${base}\n\n## 项目特定规则\n\n${projectContext}`;
      }
      return projectContext;
    }
    return base;
  }

  /**
   * 动态更新项目上下文 prompt
   * 这允许在运行时更新 agent 的配置，而无需重新创建 agent 实例
   */
  updateProjectContext(projectContextPrompt?: string): void {
    if (this.currentProjectContext === projectContextPrompt) {
      return; // 没有变化，跳过更新
    }
    
    this.currentProjectContext = projectContextPrompt;
    this.prompt = this.buildFullPrompt(this.basePrompt, projectContextPrompt);
    
    logger.debug(`Updated project context for agent ${this.config.name}`, {
      hasContext: !!projectContextPrompt,
      contextLength: projectContextPrompt?.length || 0,
    });
  }

  /**
   * 加载提示词文件
   */
  protected loadPrompt(path: string): string {
    try {
      return readFileSync(path, 'utf-8');
    } catch (error) {
      logger.error(`Failed to load prompt from ${path}`, { error });
      throw error;
    }
  }

  /**
   * 获取 Agent 描述
   */
  getDescription(): string {
    return this.config.description;
  }

  /**
   * 获取 Agent 名称
   */
  getName(): string {
    return this.config.name;
  }

  /**
   * 执行 Agent（抽象方法）
   */
  abstract execute(context: {
    diff: string;
    files: Array<{ path: string; content: string }>;
    metadata?: Record<string, unknown>;
  }): Promise<AgentResult<T>>;

  /**
   * 带重试的执行
   */
  protected async executeWithRetry<TResult>(
    fn: () => Promise<TResult>
  ): Promise<TResult> {
    return retry(fn, {
      maxRetries: 3,
      initialDelay: 1000,
      maxDelay: 10000,
    });
  }

  /**
   * 调用 LLM
   */
  protected async callLLM(
    systemPrompt: string,
    userPrompt: string,
    options?: {
      temperature?: number;
      topP?: number;
      maxTokens?: number;
    }
  ): Promise<string> {
    return this.executeWithRetry(async () => {
      return this.openai.complete(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        options
      );
    });
  }

  /**
   * 生成文件路径列表字符串
   */
  protected buildFilePathsList(files: Array<{ path: string; content: string }>): string {
    return files.map(f => f.path).join('\n- ');
  }

  /**
   * 修正文件路径（处理 AI 可能返回的错误扩展名）
   * @param reportedPath AI 返回的文件路径
   * @param files 实际的文件列表
   * @returns 修正后的路径，如果找不到则返回 null
   */
  protected correctFilePath(
    reportedPath: string,
    files: Array<{ path: string; content: string }>
  ): string | null {
    // 如果路径完全匹配，直接返回
    if (files.some(f => f.path === reportedPath)) {
      return reportedPath;
    }

    // 创建路径映射（不带扩展名 -> 实际路径）
    const filePathMap = new Map<string, string>();
    for (const file of files) {
      const pathWithoutExt = file.path.replace(/\.(tsx?|jsx?|vue|svelte|css|scss|less|json|ya?ml|mdx)$/, '');
      filePathMap.set(pathWithoutExt, file.path);
    }

    // 尝试修正：去掉扩展名后匹配
    const pathWithoutExt = reportedPath.replace(/\.(tsx?|jsx?|vue|svelte|css|scss|less|json|ya?ml|mdx)$/, '');
    const correctedPath = filePathMap.get(pathWithoutExt);
    
    if (correctedPath) {
      logger.warn(`Correcting file path from "${reportedPath}" to "${correctedPath}"`);
      return correctedPath;
    }

    logger.warn(`File path "${reportedPath}" not found in diff`);
    return null;
  }
}

