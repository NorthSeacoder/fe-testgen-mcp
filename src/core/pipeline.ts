/**
 * Pipeline System - 声明式工作流编排
 *
 * 支持：
 * - YAML/JSON 定义工作流
 * - 步骤间数据流转
 * - 条件执行
 * - 并行执行（future）
 * - 错误处理与重试
 */

import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { ToolRegistry } from './tool-registry.js';
import { logger } from '../utils/logger.js';
import { getMetrics } from '../utils/metrics.js';

export interface PipelineStep {
  name: string;
  type: 'tool' | 'agent' | 'condition' | 'parallel' | 'loop' | 'branch';
  ref?: string; // 工具/Agent 名称
  input?: Record<string, unknown>;
  condition?: string; // 条件表达式
  onError?: 'stop' | 'continue' | 'retry';
  retries?: number;
  steps?: PipelineStep[]; // 用于 parallel 和 branch 的子步骤
  branches?: Array<{ condition: string; steps: PipelineStep[] }>; // 用于 branch
  loopOver?: string; // 用于 loop，指向需要迭代的数组路径
  loopItem?: string; // 用于 loop，当前项的变量名
}

export interface PipelineDefinition {
  name?: string;
  description?: string;
  steps: PipelineStep[];
}

export interface PipelineContext {
  input: Record<string, unknown>;
  steps: Record<string, { data?: unknown; error?: string }>;
}

export interface PipelineResult {
  success: boolean;
  context: PipelineContext;
  finalOutput?: unknown;
  error?: string;
}

/**
 * PipelineExecutor - 执行 Pipeline
 */
export class PipelineExecutor {
  constructor(private toolRegistry: ToolRegistry) {}

  async execute(pipeline: PipelineDefinition, input: Record<string, unknown>): Promise<PipelineResult> {
    const context: PipelineContext = {
      input,
      steps: {},
    };

    logger.info(`[Pipeline] Starting: ${pipeline.name || 'unnamed'}`, { stepsCount: pipeline.steps.length });
    getMetrics().recordCounter('pipeline.execution.started', 1, { pipeline: pipeline.name });

    const startTime = Date.now();

    try {
      for (const step of pipeline.steps) {
        logger.info(`[Pipeline] Executing step: ${step.name}`);

        // 检查条件
        if (step.condition && !this.evaluateCondition(step.condition, context)) {
          logger.info(`[Pipeline] Skipping step ${step.name} (condition not met)`);
          continue;
        }

        // 执行步骤
        const stepResult = await this.executeStepByType(step, context, step.name);
        context.steps[step.name] = stepResult;

        // 错误处理
        if (stepResult.error) {
          logger.error(`[Pipeline] Step ${step.name} failed`, { error: stepResult.error });

          if (step.onError === 'stop' || !step.onError) {
            throw new Error(`Step "${step.name}" failed: ${stepResult.error}`);
          }
          // 'continue' - 继续下一步
        }
      }

      const duration = Date.now() - startTime;
      getMetrics().recordTimer('pipeline.execution.duration', duration, {
        pipeline: pipeline.name,
        status: 'success',
      });

      logger.info(`[Pipeline] Completed: ${pipeline.name}`, { duration });

      return {
        success: true,
        context,
        finalOutput: this.extractFinalOutput(context),
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      getMetrics().recordTimer('pipeline.execution.duration', duration, {
        pipeline: pipeline.name,
        status: 'error',
      });

      logger.error(`[Pipeline] Failed: ${pipeline.name}`, { error: errorMessage });

      return {
        success: false,
        context,
        error: errorMessage,
      };
    }
  }

  private async executeStepByType(
    step: PipelineStep,
    context: PipelineContext,
    stepKey: string
  ): Promise<{ data?: unknown; error?: string }> {
    switch (step.type) {
      case 'tool':
        return this.executeToolStep(step, context, stepKey);
      case 'parallel':
        return this.executeParallelStep(step, context, stepKey);
      case 'loop':
        return this.executeLoopStep(step, context, stepKey);
      case 'branch':
        return this.executeBranchStep(step, context, stepKey);
      default:
        return { error: `Unsupported step type: ${step.type}` };
    }
  }

  private async executeToolStep(
    step: PipelineStep,
    context: PipelineContext,
    stepKey: string
  ): Promise<{ data?: unknown; error?: string }> {
    if (!step.ref) {
      return { error: 'Tool step missing "ref"' };
    }

    const tool = await this.toolRegistry.get(step.ref);
    if (!tool) {
      return { error: `Tool "${step.ref}" not found` };
    }

    logger.info(`[Pipeline] Calling tool ${step.ref} for step ${stepKey}`);

    // 解析输入（支持模板变量）
    const input = this.resolveInput(step.input || {}, context);

    try {
      const result = await tool.execute(input);
      return { data: result.data };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async executeParallelStep(
    step: PipelineStep,
    context: PipelineContext,
    stepKey: string
  ): Promise<{ data?: unknown; error?: string }> {
    if (!step.steps || step.steps.length === 0) {
      return { error: 'Parallel step missing "steps"' };
    }

    logger.info(`[Pipeline] Executing ${step.steps.length} steps in parallel`);

    try {
      const results = await Promise.all(
        step.steps.map(async (subStep, index) => {
          const subStepKey = `${stepKey}.${subStep.name || index}`;
          logger.info(`[Pipeline] Parallel substep: ${subStepKey}`);
          return {
            name: subStep.name || `${index}`,
            result: await this.executeStepByType(subStep, context, subStepKey),
          };
        })
      );

      const parallelResults: Record<string, any> = {};
      for (const { name, result } of results) {
        parallelResults[name] = result.data;
      }

      return { data: parallelResults };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async executeLoopStep(
    step: PipelineStep,
    context: PipelineContext,
    stepKey: string
  ): Promise<{ data?: unknown; error?: string }> {
    if (!step.loopOver || !step.steps || step.steps.length === 0) {
      return { error: 'Loop step missing "loopOver" or "steps"' };
    }

    const arrayValue = this.getValueByPath(step.loopOver, context);
    if (!Array.isArray(arrayValue)) {
      return { error: `Loop path "${step.loopOver}" does not point to an array` };
    }

    logger.info(`[Pipeline] Looping over ${arrayValue.length} items`);

    const loopResults: any[] = [];

    for (let i = 0; i < arrayValue.length; i++) {
      const item = arrayValue[i];
      const loopContext: PipelineContext = {
        ...context,
        input: {
          ...context.input,
          [step.loopItem || 'item']: item,
          index: i,
        },
      };

      logger.info(`[Pipeline] Loop iteration ${i}`);

      for (const subStep of step.steps) {
        const subStepKey = `${stepKey}.${i}.${subStep.name}`;
        const result = await this.executeStepByType(subStep, loopContext, subStepKey);
        loopContext.steps[subStep.name] = result;
      }

      loopResults.push({
        index: i,
        item,
        steps: loopContext.steps,
      });
    }

    return { data: loopResults };
  }

  private async executeBranchStep(
    step: PipelineStep,
    context: PipelineContext,
    stepKey: string
  ): Promise<{ data?: unknown; error?: string }> {
    if (!step.branches || step.branches.length === 0) {
      return { error: 'Branch step missing "branches"' };
    }

    logger.info(`[Pipeline] Evaluating ${step.branches.length} branch conditions`);

    for (const branch of step.branches) {
      if (this.evaluateCondition(branch.condition, context)) {
        logger.info(`[Pipeline] Branch condition met: ${branch.condition}`);

        for (const subStep of branch.steps) {
          const subStepKey = `${stepKey}.${subStep.name}`;
          const result = await this.executeStepByType(subStep, context, subStepKey);
          context.steps[subStep.name] = result;

          if (result.error && subStep.onError === 'stop') {
            return { error: result.error };
          }
        }

        return { data: 'branch_executed' };
      }
    }

    logger.info(`[Pipeline] No branch condition matched`);
    return { data: 'no_branch_matched' };
  }

  /**
   * 解析输入中的模板变量
   * 支持：{{context.xxx}}, {{steps.stepName.data.xxx}}
   */
  private resolveInput(input: Record<string, unknown>, context: PipelineContext): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string' && value.startsWith('{{') && value.endsWith('}}')) {
        const path = value.slice(2, -2).trim();
        resolved[key] = this.getValueByPath(path, context);
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
  }

  private getValueByPath(path: string, context: PipelineContext): unknown {
    const parts = path.split('.');
    let current: any = { context: context.input, steps: context.steps };

    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        return undefined;
      }
    }

    return current;
  }

  private evaluateCondition(condition: string, context: PipelineContext): boolean {
    // 简化实现：仅支持简单的存在性检查
    // 生产环境应使用更安全的表达式引擎
    try {
      const value = this.getValueByPath(condition, context);
      return Boolean(value);
    } catch {
      return false;
    }
  }

  private extractFinalOutput(context: PipelineContext): unknown {
    // 默认返回最后一个步骤的输出
    const stepNames = Object.keys(context.steps);
    if (stepNames.length === 0) return undefined;

    const lastStepName = stepNames[stepNames.length - 1];
    return context.steps[lastStepName].data;
  }
}

/**
 * PipelineLoader - 加载 Pipeline 定义
 */
export class PipelineLoader {
  loadFromFile(filePath: string): Map<string, PipelineDefinition> {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = YAML.parse(content);

      if (!parsed.pipelines) {
        throw new Error('Invalid pipeline file: missing "pipelines" key');
      }

      const pipelines = new Map<string, PipelineDefinition>();

      for (const [name, def] of Object.entries(parsed.pipelines)) {
        const pipeline = def as PipelineDefinition;
        pipeline.name = name;
        pipelines.set(name, pipeline);
      }

      logger.info(`Loaded ${pipelines.size} pipelines from ${filePath}`);
      return pipelines;
    } catch (error) {
      logger.error(`Failed to load pipelines from ${filePath}`, { error });
      return new Map();
    }
  }
}
