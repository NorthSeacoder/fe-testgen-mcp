/**
 * Prometheus Exporter - 将内存指标导出为 Prometheus 格式
 * 
 * 提供：
 * - 自动注册 Counter/Gauge/Histogram
 * - 支持标签（labels）
 * - 兼容 Prometheus 抓取格式
 */

import { Registry, Counter, Gauge, Histogram } from 'prom-client';
import { getMetrics } from './metrics.js';
import { logger } from './logger.js';

export interface PrometheusExporterConfig {
  prefix?: string;
  defaultLabels?: Record<string, string>;
}

/**
 * PrometheusExporter - 将内部 Metrics 转换为 Prometheus 格式
 */
export class PrometheusExporter {
  private registry: Registry;
  private counters = new Map<string, Counter>();
  private gauges = new Map<string, Gauge>();
  private histograms = new Map<string, Histogram>();
  private prefix: string;
  private counterSnapshots = new Map<string, number>();

  constructor(config: PrometheusExporterConfig = {}) {
    this.registry = new Registry();
    this.prefix = config.prefix || 'fe_testgen_mcp_';

    if (config.defaultLabels) {
      this.registry.setDefaultLabels(config.defaultLabels);
    }

    logger.info('[PrometheusExporter] Initialized', { prefix: this.prefix });
  }

  /**
   * 导出 Prometheus 格式的 metrics
   */
  async export(): Promise<string> {
    try {
      // 同步内存 metrics 到 Prometheus registry
      await this.syncMetrics();

      // 返回 Prometheus 格式
      return this.registry.metrics();
    } catch (error) {
      logger.error('[PrometheusExporter] Export failed', { error });
      throw error;
    }
  }

  /**
   * 同步内存 metrics 到 Prometheus registry
   */
  private async syncMetrics(): Promise<void> {
    const snapshots = getMetrics().export();

    for (const snapshot of snapshots) {
      const metricName = this.prefix + snapshot.name.replace(/\./g, '_');
      // 转换 labels 为 Record<string, string>
      const labels: Record<string, string> = {};
      if (snapshot.labels) {
        for (const [key, value] of Object.entries(snapshot.labels)) {
          if (value !== undefined) {
            labels[key] = String(value);
          }
        }
      }

      switch (snapshot.type) {
        case 'counter':
          this.updateCounter(metricName, snapshot.value, labels);
          break;
        case 'gauge':
          this.updateGauge(metricName, snapshot.value, labels);
          break;
        case 'histogram':
        case 'timer':
          this.updateHistogram(metricName, snapshot.value, labels);
          break;
      }
    }
  }

  private updateCounter(name: string, value: number, labels: Record<string, string>): void {
    const key = `${name}:${JSON.stringify(labels)}`;
    let counter = this.counters.get(name);
    if (!counter) {
      counter = new Counter({
        name,
        help: `Counter metric: ${name}`,
        labelNames: Object.keys(labels),
        registers: [this.registry],
      });
      this.counters.set(name, counter);
    }

    // 计算增量（Prometheus counter 必须是递增的）
    const lastValue = this.counterSnapshots.get(key) || 0;
    const increment = value - lastValue;
    if (increment > 0) {
      counter.inc(labels, increment);
      this.counterSnapshots.set(key, value);
    }
  }

  private updateGauge(name: string, value: number, labels: Record<string, string>): void {
    let gauge = this.gauges.get(name);
    if (!gauge) {
      gauge = new Gauge({
        name,
        help: `Gauge metric: ${name}`,
        labelNames: Object.keys(labels),
        registers: [this.registry],
      });
      this.gauges.set(name, gauge);
    }

    gauge.set(labels, value);
  }

  private updateHistogram(name: string, value: number, labels: Record<string, string>): void {
    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = new Histogram({
        name,
        help: `Histogram metric: ${name}`,
        labelNames: Object.keys(labels),
        buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
        registers: [this.registry],
      });
      this.histograms.set(name, histogram);
    }

    histogram.observe(labels, value);
  }

  /**
   * 获取 Registry（用于集成到 HTTP server）
   */
  getRegistry(): Registry {
    return this.registry;
  }

  /**
   * 重置所有 metrics
   */
  reset(): void {
    this.registry.clear();
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.counterSnapshots.clear();
  }
}

// 全局 exporter 实例
let globalPrometheusExporter: PrometheusExporter | null = null;

export function initializePrometheusExporter(
  config: PrometheusExporterConfig = {}
): PrometheusExporter {
  if (globalPrometheusExporter) {
    logger.warn('[PrometheusExporter] Already initialized, resetting');
    globalPrometheusExporter.reset();
  }
  globalPrometheusExporter = new PrometheusExporter(config);
  return globalPrometheusExporter;
}

export function getPrometheusExporter(): PrometheusExporter {
  if (!globalPrometheusExporter) {
    globalPrometheusExporter = new PrometheusExporter();
  }
  return globalPrometheusExporter;
}
