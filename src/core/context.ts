/**
 * Context System - Agent 执行上下文与长期记忆
 *
 * 核心概念：
 * - AgentContext: Agent 运行时的上下文（输入、中间状态、历史等）
 * - Observation: Agent 观察到的信息（工具输出、环境状态等）
 * - Memory: 跨会话的长期记忆存储
 */

export interface Observation {
  type: 'tool_result' | 'user_input' | 'system_event' | 'error';
  source: string; // 来源（工具名、用户、系统）
  content: unknown;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface Thought {
  content: string; // Agent 的思考内容
  reasoning?: string; // 推理过程
  timestamp: number;
}

export interface Action {
  type: 'call_tool' | 'respond' | 'terminate' | 'ask_user' | 'continue';
  toolName?: string;
  parameters?: Record<string, unknown>;
  message?: string;
  timestamp: number;
}

export interface AgentContext {
  // 会话标识
  sessionId: string;
  agentName: string;

  // 输入与目标
  task: string;
  goal?: string;
  constraints?: string[];

  // 执行历史（ReAct 循环）
  history: Array<{
    thought?: Thought;
    action?: Action;
    observation?: Observation;
  }>;

  // 当前状态
  currentStep: number;
  maxSteps: number;
  isComplete: boolean;

  // 上下文数据
  data: Record<string, unknown>;

  // 元数据
  startTime: number;
  lastUpdateTime: number;
}

/**
 * ContextStore - 管理 Agent 上下文的存储与检索
 */
export class ContextStore {
  private contexts = new Map<string, AgentContext>();

  create(sessionId: string, agentName: string, task: string, options?: {
    goal?: string;
    constraints?: string[];
    maxSteps?: number;
    initialData?: Record<string, unknown>;
  }): AgentContext {
    if (this.contexts.has(sessionId)) {
      throw new Error(`Context for session ${sessionId} already exists`);
    }

    const context: AgentContext = {
      sessionId,
      agentName,
      task,
      goal: options?.goal,
      constraints: options?.constraints,
      history: [],
      currentStep: 0,
      maxSteps: options?.maxSteps || 10,
      isComplete: false,
      data: options?.initialData || {},
      startTime: Date.now(),
      lastUpdateTime: Date.now(),
    };

    this.contexts.set(sessionId, context);
    return context;
  }

  get(sessionId: string): AgentContext | undefined {
    return this.contexts.get(sessionId);
  }

  update(sessionId: string, updater: (ctx: AgentContext) => void): AgentContext {
    const context = this.contexts.get(sessionId);
    if (!context) {
      throw new Error(`Context for session ${sessionId} not found`);
    }

    updater(context);
    context.lastUpdateTime = Date.now();
    return context;
  }

  addHistory(sessionId: string, entry: {
    thought?: Thought;
    action?: Action;
    observation?: Observation;
  }): void {
    this.update(sessionId, ctx => {
      ctx.history.push(entry);
      ctx.currentStep++;
    });
  }

  delete(sessionId: string): void {
    this.contexts.delete(sessionId);
  }

  list(): AgentContext[] {
    return Array.from(this.contexts.values());
  }
}

/**
 * Memory - 长期记忆存储（跨会话）
 */
export interface MemoryEntry {
  key: string;
  value: unknown;
  timestamp: number;
  expiresAt?: number;
  tags?: string[];
}

export class Memory {
  private store = new Map<string, MemoryEntry>();

  set(key: string, value: unknown, options?: {
    ttl?: number; // 秒
    tags?: string[];
  }): void {
    const entry: MemoryEntry = {
      key,
      value,
      timestamp: Date.now(),
      expiresAt: options?.ttl ? Date.now() + options.ttl * 1000 : undefined,
      tags: options?.tags,
    };
    this.store.set(key, entry);
  }

  get(key: string): unknown | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    // 检查过期
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return entry.value;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  findByTag(tag: string): MemoryEntry[] {
    return Array.from(this.store.values()).filter(entry => entry.tags?.includes(tag));
  }

  clear(): void {
    this.store.clear();
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }
}
