/**
 * ToolRegistry - 统一管理所有工具的注册、检索与元数据导出
 * 支持惰性加载工具（首次调用时初始化）
 */

import { BaseTool, ToolMetadata } from './base-tool.js';
import { logger } from '../utils/logger.js';

type ToolFactory = () => BaseTool<any, any> | Promise<BaseTool<any, any>>;

export class ToolRegistry {
  private tools = new Map<string, BaseTool<any, any>>();
  private lazyTools = new Map<string, ToolFactory>();
  private toolMetadata = new Map<string, ToolMetadata>();

  register(tool: BaseTool<any, any>): void {
    const metadata = tool.getMetadata();
    if (this.tools.has(metadata.name)) {
      throw new Error(`Tool "${metadata.name}" already registered`);
    }
    this.tools.set(metadata.name, tool);
    this.toolMetadata.set(metadata.name, metadata);
  }

  registerLazy(name: string, factory: ToolFactory, metadata: ToolMetadata): void {
    if (this.lazyTools.has(name) || this.tools.has(name)) {
      throw new Error(`Tool "${name}" already registered`);
    }
    this.lazyTools.set(name, factory);
    this.toolMetadata.set(name, metadata);
  }

  async get<TInput, TOutput>(name: string): Promise<BaseTool<TInput, TOutput> | undefined> {
    const existing = this.tools.get(name);
    if (existing) {
      return existing as BaseTool<TInput, TOutput>;
    }

    const factory = this.lazyTools.get(name);
    if (factory) {
      logger.info(`[ToolRegistry] Lazy loading tool: ${name}`);
      const tool = await factory();
      this.tools.set(name, tool);
      this.lazyTools.delete(name);
      return tool as BaseTool<TInput, TOutput>;
    }

    return undefined;
  }

  list(): BaseTool<any, any>[] {
    return Array.from(this.tools.values());
  }

  listMetadata(): ToolMetadata[] {
    return Array.from(this.toolMetadata.values());
  }
}
