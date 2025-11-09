/**
 * ReAct Engine - Agent 执行引擎（Reasoning + Acting）
 *
 * 核心循环：
 * 1. Thought: Agent 思考（调用 LLM）
 * 2. Action: Agent 决定行动（调用工具或返回结果）
 * 3. Observation: 记录观察结果（工具输出）
 * 4. 重复直到任务完成或达到最大步数
 */

import { OpenAIClient } from '../clients/openai.js';
import { ToolRegistry } from './tool-registry.js';
import { AgentContext, ContextStore, Thought, Action, Observation } from './context.js';
import { logger } from '../utils/logger.js';
import { getMetrics } from '../utils/metrics.js';

export interface ReActConfig {
  maxSteps: number;
  temperature: number;
  stopReasons: string[];
  useFunctionCalling?: boolean; // 是否使用 Function Calling（默认 true）
}

export interface ReActResult {
  success: boolean;
  finalAnswer?: unknown;
  error?: string;
  context: AgentContext;
}

/**
 * ReActEngine - 核心执行引擎
 */
export class ReActEngine {
  constructor(
    private llm: OpenAIClient,
    private toolRegistry: ToolRegistry,
    private contextStore: ContextStore,
    private config: ReActConfig
  ) {}

  /**
   * 执行 ReAct 循环
   */
  async run(params: {
    agentName: string;
    task: string;
    systemPrompt: string;
    goal?: string;
    constraints?: string[];
    initialData?: Record<string, unknown>;
  }): Promise<ReActResult> {
    const sessionId = this.generateSessionId();

    // 创建上下文
    const context = this.contextStore.create(sessionId, params.agentName, params.task, {
      goal: params.goal,
      constraints: params.constraints,
      maxSteps: this.config.maxSteps,
      initialData: params.initialData,
    });

    logger.info(`[ReActEngine] Starting session ${sessionId}`, {
      agent: params.agentName,
      task: params.task,
    });

    getMetrics().recordCounter('react.session.started', 1, { agent: params.agentName });

    try {
      while (!context.isComplete && context.currentStep < context.maxSteps) {
        // Step 1: Thought
        const thought = await this.think(context, params.systemPrompt);
        logger.debug(`[ReActEngine] Thought: ${thought.content}`);

        // Step 2: Action
        const action = await this.decide(context, thought);
        logger.debug(`[ReActEngine] Action: ${action.type}`);

        // Step 3: Execute & Observe
        const observation = await this.act(action, context);
        logger.debug(`[ReActEngine] Observation: ${observation.type}`);

        // Record history
        this.contextStore.addHistory(sessionId, { thought, action, observation });

        // Check termination
        if (action.type === 'terminate' || action.type === 'respond') {
          context.isComplete = true;
          break;
        }
      }

      if (context.currentStep >= context.maxSteps) {
        logger.warn(`[ReActEngine] Max steps reached for session ${sessionId}`);
      }

      getMetrics().recordCounter('react.session.completed', 1, {
        agent: params.agentName,
        status: 'success',
      });
      getMetrics().recordHistogram('react.session.steps', context.currentStep, {
        agent: params.agentName,
      });

      return {
        success: true,
        finalAnswer: context.data.finalAnswer,
        context,
      };
    } catch (error) {
      logger.error(`[ReActEngine] Session ${sessionId} failed`, { error });
      getMetrics().recordCounter('react.session.completed', 1, {
        agent: params.agentName,
        status: 'error',
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        context,
      };
    }
  }

  /**
   * Thought: Agent 思考下一步
   */
  private async think(context: AgentContext, systemPrompt: string): Promise<Thought> {
    const historyText = this.formatHistory(context);
    const userPrompt = `
Task: ${context.task}
${context.goal ? `Goal: ${context.goal}` : ''}

History:
${historyText}

Current Step: ${context.currentStep + 1}/${context.maxSteps}

What should I do next? Think step by step.
`;

    const response = await this.llm.complete(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { temperature: this.config.temperature }
    );

    return {
      content: response,
      timestamp: Date.now(),
    };
  }

  /**
   * Action: 从 Thought 中提取行动
   */
  private async decide(context: AgentContext, thought: Thought): Promise<Action> {
    void context; // 当前实现未使用，可用于未来增强
    // 简化版：解析 LLM 输出中的行动指令
    // 生产环境应使用 function calling 或 structured output
    const content = thought.content.toLowerCase();

    if (content.includes('call tool:') || content.includes('use tool:')) {
      // 提取工具名和参数（简化解析）
      const toolMatch = content.match(/(?:call tool|use tool):\s*(\w+)/i);
      const toolName = toolMatch ? toolMatch[1] : '';

      return {
        type: 'call_tool',
        toolName,
        parameters: {}, // TODO: 解析参数
        timestamp: Date.now(),
      };
    }

    if (content.includes('final answer:') || content.includes('complete')) {
      return {
        type: 'terminate',
        message: thought.content,
        timestamp: Date.now(),
      };
    }

    // 默认继续思考
    return {
      type: 'respond',
      message: thought.content,
      timestamp: Date.now(),
    };
  }

  /**
   * Act: 执行行动并返回观察结果
   */
  private async act(action: Action, context: AgentContext): Promise<Observation> {
    if (action.type === 'call_tool' && action.toolName) {
      const tool = await this.toolRegistry.get(action.toolName);
      if (!tool) {
        return {
          type: 'error',
          source: 'system',
          content: `Tool "${action.toolName}" not found`,
          timestamp: Date.now(),
        };
      }

      try {
        const result = await tool.execute(action.parameters || {});
        return {
          type: 'tool_result',
          source: action.toolName,
          content: result,
          timestamp: Date.now(),
        };
      } catch (error) {
        return {
          type: 'error',
          source: action.toolName,
          content: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        };
      }
    }

    if (action.type === 'terminate' || action.type === 'respond') {
      context.data.finalAnswer = action.message;
      return {
        type: 'system_event',
        source: 'engine',
        content: 'Task completed',
        timestamp: Date.now(),
      };
    }

    return {
      type: 'error',
      source: 'engine',
      content: `Unknown action type: ${action.type}`,
      timestamp: Date.now(),
    };
  }

  private formatHistory(context: AgentContext): string {
    return context.history
      .map((entry, idx) => {
        const parts: string[] = [`Step ${idx + 1}:`];
        if (entry.thought) parts.push(`Thought: ${entry.thought.content}`);
        if (entry.action) parts.push(`Action: ${entry.action.type}`);
        if (entry.observation) parts.push(`Observation: ${JSON.stringify(entry.observation.content)}`);
        return parts.join('\n');
      })
      .join('\n\n');
  }

  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }
}
