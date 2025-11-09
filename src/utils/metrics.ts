/**
 * Lightweight metrics facade used across the MCP server.
 *
 * Goals:
 *  - Provide a consistent interface without forcing a concrete backend
 *  - Enable integration with remote tracking services
 *  - Offer a zero-dependency in-memory implementation by default
 */

import { logger } from './logger.js';
import type { MCPTrackingService } from './tracking-service.js';

export type MetricValue = number;

export interface MetricLabels {
  [key: string]: string | number | boolean | undefined;
}

export interface MetricsClient {
  recordCounter(name: string, value?: MetricValue, labels?: MetricLabels): void;
  recordTimer(name: string, durationMs: MetricValue, labels?: MetricLabels): void;
  recordHistogram(name: string, value: MetricValue, labels?: MetricLabels): void;
  recordGauge(name: string, value: MetricValue, labels?: MetricLabels): void;
  export(): MetricSnapshot[];
  reset(): void;
}

export interface MetricSnapshot {
  name: string;
  type: 'counter' | 'timer' | 'histogram' | 'gauge';
  value: MetricValue;
  labels?: MetricLabels;
  timestamp: number;
}

/**
 * Default in-memory implementation used unless an external client is provided.
 */
export class InMemoryMetricsClient implements MetricsClient {
  private records: MetricSnapshot[] = [];
  private readonly logMetrics: boolean;

  constructor(options: { logMetrics?: boolean } = {}) {
    this.logMetrics = options.logMetrics ?? false;
  }

  recordCounter(name: string, value: MetricValue = 1, labels?: MetricLabels): void {
    this.pushRecord('counter', name, value, labels);
  }

  recordTimer(name: string, durationMs: MetricValue, labels?: MetricLabels): void {
    this.pushRecord('timer', name, durationMs, labels);
  }

  recordHistogram(name: string, value: MetricValue, labels?: MetricLabels): void {
    this.pushRecord('histogram', name, value, labels);
  }

  recordGauge(name: string, value: MetricValue, labels?: MetricLabels): void {
    this.pushRecord('gauge', name, value, labels);
  }

  export(): MetricSnapshot[] {
    return [...this.records];
  }

  reset(): void {
    this.records = [];
  }

  protected pushRecord(type: MetricSnapshot['type'], name: string, value: MetricValue, labels?: MetricLabels) {
    const snapshot: MetricSnapshot = {
      name,
      type,
      value,
      labels,
      timestamp: Date.now(),
    };
    this.records.push(snapshot);

    if (this.logMetrics) {
      logger.debug('[metrics]', snapshot);
    }
  }
}

class TrackingMetricsClient extends InMemoryMetricsClient {
  constructor(private readonly tracker: MCPTrackingService, options?: { logMetrics?: boolean }) {
    super(options);
  }

  override recordCounter(name: string, value: MetricValue = 1, labels?: MetricLabels): void {
    super.recordCounter(name, value, labels);
    this.trackMetric('counter', name, value, labels);
  }

  override recordTimer(name: string, durationMs: MetricValue, labels?: MetricLabels): void {
    super.recordTimer(name, durationMs, labels);
    this.trackMetric('timer', name, durationMs, labels);
  }

  override recordHistogram(name: string, value: MetricValue, labels?: MetricLabels): void {
    super.recordHistogram(name, value, labels);
    this.trackMetric('histogram', name, value, labels);
  }

  override recordGauge(name: string, value: MetricValue, labels?: MetricLabels): void {
    super.recordGauge(name, value, labels);
    this.trackMetric('gauge', name, value, labels);
  }

  private trackMetric(type: MetricSnapshot['type'], name: string, value: MetricValue, labels?: MetricLabels) {
    void this.tracker.track(
      {
        eventType: 'metric_recorded',
        metricType: type,
        metricName: name,
        value,
        labels: labels ?? null,
      },
      'INFO',
      `metric:${name}`
    );
  }
}

let client: MetricsClient | undefined;

export function initializeMetrics(customClient?: MetricsClient, trackingService?: MCPTrackingService): void {
  if (customClient) {
    client = customClient;
  } else if (trackingService) {
    client = new TrackingMetricsClient(trackingService, { logMetrics: process.env.LOG_METRICS === 'true' });
  } else {
    client = new InMemoryMetricsClient({ logMetrics: process.env.LOG_METRICS === 'true' });
  }
  logger.info('Metrics client initialized', { client: client.constructor.name });
}

export function getMetrics(): MetricsClient {
  if (!client) {
    initializeMetrics();
  }
  return client!;
}

/**
 * Helper to measure async execution time.
 */
export async function withTimer<T>(
  metricName: string,
  labels: MetricLabels | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    getMetrics().recordTimer(metricName, Date.now() - startedAt, { ...labels, status: 'success' });
    return result;
  } catch (error) {
    getMetrics().recordTimer(metricName, Date.now() - startedAt, { ...labels, status: 'error' });
    throw error;
  }
}
