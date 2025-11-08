/**
 * Metrics Exporter - 指标导出器
 * 
 * 提供统一的指标上传接口，支持：
 * - 批量导出
 * - 格式转换
 * - 远程上传（后续补充）
 */

import { getMetrics, MetricSnapshot } from './metrics.js';
import { logger } from './logger.js';

export interface MetricsExportOptions {
  format?: 'json' | 'prometheus' | 'custom';
  includeLabels?: boolean;
  timeRange?: {
    start?: number;
    end?: number;
  };
}

export interface MetricsUploadConfig {
  endpoint?: string;
  apiKey?: string;
  batchSize?: number;
  flushInterval?: number; // 秒
}

/**
 * MetricsExporter - 负责导出和格式化指标
 */
export class MetricsExporter {
  /**
   * 导出所有指标
   */
  export(options: MetricsExportOptions = {}): string {
    const metrics = getMetrics().export();
    
    // 按时间范围过滤
    let filtered = metrics;
    if (options.timeRange) {
      filtered = metrics.filter(m => {
        const { start, end } = options.timeRange!;
        if (start && m.timestamp < start) return false;
        if (end && m.timestamp > end) return false;
        return true;
      });
    }

    switch (options.format) {
      case 'prometheus':
        return this.toPrometheusFormat(filtered);
      case 'custom':
        return this.toCustomFormat(filtered);
      case 'json':
      default:
        return JSON.stringify(filtered, null, 2);
    }
  }

  /**
   * 导出为 Prometheus 格式
   */
  private toPrometheusFormat(metrics: MetricSnapshot[]): string {
    const lines: string[] = [];
    const grouped = this.groupByName(metrics);

    for (const [name, snapshots] of grouped.entries()) {
      const sample = snapshots[0];
      
      // TYPE & HELP
      lines.push(`# TYPE ${name} ${this.getPrometheusType(sample.type)}`);
      
      // 每个标签组合一行
      for (const snapshot of snapshots) {
        const labelsStr = snapshot.labels 
          ? Object.entries(snapshot.labels)
              .map(([k, v]) => `${k}="${v}"`)
              .join(',')
          : '';
        
        const metricLine = labelsStr 
          ? `${name}{${labelsStr}} ${snapshot.value} ${snapshot.timestamp}`
          : `${name} ${snapshot.value} ${snapshot.timestamp}`;
        
        lines.push(metricLine);
      }
    }

    return lines.join('\n');
  }

  /**
   * 导出为自定义格式（用于统一上传接口）
   */
  private toCustomFormat(metrics: MetricSnapshot[]): string {
    // 预留格式，后续根据统一接口要求调整
    return JSON.stringify({
      timestamp: Date.now(),
      source: 'fe-testgen-mcp',
      metrics: metrics.map(m => ({
        name: m.name,
        type: m.type,
        value: m.value,
        labels: m.labels || {},
        timestamp: m.timestamp,
      })),
    });
  }

  private groupByName(metrics: MetricSnapshot[]): Map<string, MetricSnapshot[]> {
    const grouped = new Map<string, MetricSnapshot[]>();
    for (const metric of metrics) {
      const existing = grouped.get(metric.name) || [];
      existing.push(metric);
      grouped.set(metric.name, existing);
    }
    return grouped;
  }

  private getPrometheusType(type: MetricSnapshot['type']): string {
    switch (type) {
      case 'counter':
        return 'counter';
      case 'gauge':
        return 'gauge';
      case 'histogram':
        return 'histogram';
      case 'timer':
        return 'histogram'; // Timer 也用 histogram
      default:
        return 'untyped';
    }
  }
}

/**
 * MetricsUploader - 负责定期上传指标（预留）
 */
export class MetricsUploader {
  private config: MetricsUploadConfig;
  private exporter: MetricsExporter;
  private timer?: NodeJS.Timeout;

  constructor(config: MetricsUploadConfig = {}) {
    this.config = {
      batchSize: 100,
      flushInterval: 60,
      ...config,
    };
    this.exporter = new MetricsExporter();
  }

  /**
   * 启动定期上传
   */
  start(): void {
    if (this.timer) {
      logger.warn('MetricsUploader already started');
      return;
    }

    this.timer = setInterval(() => {
      this.flush();
    }, this.config.flushInterval! * 1000);

    logger.info('MetricsUploader started', { 
      flushInterval: this.config.flushInterval,
      endpoint: this.config.endpoint || 'not configured',
    });
  }

  /**
   * 停止定期上传
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      logger.info('MetricsUploader stopped');
    }
  }

  /**
   * 立即上传所有指标
   */
  async flush(): Promise<void> {
    try {
      const data = this.exporter.export({ format: 'custom' });
      
      if (!this.config.endpoint) {
        logger.debug('No upload endpoint configured, skipping upload');
        return;
      }

      // 上传指标
      await this.upload(data);
      
      logger.debug('Metrics flushed', { size: data.length });
      
      // 上传后清空内存
      getMetrics().reset();
    } catch (error) {
      logger.error('Failed to flush metrics', { error });
    }
  }

  /**
   * 上传到远程端点（预留接口）
   */
  private async upload(_data: string): Promise<void> {
    if (!this.config.endpoint) {
      return;
    }

    // TODO: 补充实际的 HTTP 请求逻辑
    // 参考示例：
    // const response = await fetch(this.config.endpoint, {
    //   method: 'POST',
    //   headers: {
    //     'Content-Type': 'application/json',
    //     'Authorization': `Bearer ${this.config.apiKey}`,
    //   },
    //   body: _data,
    // });
    //
    // if (!response.ok) {
    //   throw new Error(`Upload failed: ${response.statusText}`);
    // }
    
    logger.debug('Metrics uploaded', { endpoint: this.config.endpoint, size: _data.length });
  }
}

// 全局导出器和上传器实例
let globalExporter: MetricsExporter;
let globalUploader: MetricsUploader | null = null;

export function getMetricsExporter(): MetricsExporter {
  if (!globalExporter) {
    globalExporter = new MetricsExporter();
  }
  return globalExporter;
}

export function initializeMetricsUploader(config: MetricsUploadConfig): MetricsUploader {
  if (globalUploader) {
    globalUploader.stop();
  }
  globalUploader = new MetricsUploader(config);
  return globalUploader;
}

export function getMetricsUploader(): MetricsUploader | null {
  return globalUploader;
}
