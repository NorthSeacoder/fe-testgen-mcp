# MCP 使用统计与监控方案

## 概述

本文档描述 fe-testgen-mcp 的使用统计数据收集方案,用于在 Grafana 上展示和分析。

## 统计指标设计

### 1. 基础使用指标

#### 1.1 工具调用统计
- **指标名称**: `mcp_tool_calls_total`
- **类型**: Counter
- **标签**:
  - `tool_name`: 工具名称 (fetch-diff, review-frontend-diff, generate-tests, etc.)
  - `status`: 调用状态 (success, error)
  - `user_id`: 用户标识 (可选)
- **说明**: 记录每个工具的调用次数

#### 1.2 工具调用耗时
- **指标名称**: `mcp_tool_duration_seconds`
- **类型**: Histogram
- **标签**:
  - `tool_name`: 工具名称
  - `status`: 调用状态
- **Buckets**: [0.5, 1, 2, 5, 10, 30, 60, 120, 300]
- **说明**: 记录工具执行时间分布

#### 1.3 工具调用错误
- **指标名称**: `mcp_tool_errors_total`
- **类型**: Counter
- **标签**:
  - `tool_name`: 工具名称
  - `error_type`: 错误类型 (network, timeout, validation, ai_error, etc.)
- **说明**: 记录各类错误发生次数

### 2. 业务指标

#### 2.1 代码审查指标

**审查执行统计**
- **指标名称**: `mcp_code_review_total`
- **类型**: Counter
- **标签**:
  - `mode`: 模式 (incremental, full)
  - `published`: 是否发布 (true, false)
- **说明**: 代码审查执行次数

**发现问题统计**
- **指标名称**: `mcp_issues_found_total`
- **类型**: Counter
- **标签**:
  - `severity`: 严重程度 (error, warning, info)
  - `topic`: 审查主题 (react, typescript, performance, etc.)
  - `confidence_level`: 置信度等级 (high>=0.8, medium>=0.6, low<0.6)
- **说明**: 发现的问题数量

**Agent 执行统计**
- **指标名称**: `mcp_agent_executions_total`
- **类型**: Counter
- **标签**:
  - `agent_type`: Agent类型 (react, typescript, performance, etc.)
  - `status`: 执行状态 (success, error)
- **说明**: 各个 Agent 的执行次数

**问题发布统计**
- **指标名称**: `mcp_comments_published_total`
- **类型**: Counter
- **标签**:
  - `status`: 发布状态 (published, skipped, failed)
- **说明**: 评论发布情况

#### 2.2 测试生成指标

**测试生成统计**
- **指标名称**: `mcp_test_generation_total`
- **类型**: Counter
- **标签**:
  - `mode`: 模式 (incremental, full)
  - `framework`: 测试框架 (vitest, jest)
- **说明**: 测试生成执行次数

**生成测试用例数量**
- **指标名称**: `mcp_tests_generated_total`
- **类型**: Counter
- **标签**:
  - `scenario`: 测试场景 (happy-path, edge-case, error-path, state-change)
  - `framework`: 测试框架
- **说明**: 生成的测试用例数量

**测试矩阵分析**
- **指标名称**: `mcp_test_matrix_features`
- **类型**: Gauge
- **标签**:
  - `revision_id`: Revision ID
- **说明**: 识别的功能点数量

- **指标名称**: `mcp_test_matrix_scenarios`
- **类型**: Gauge
- **标签**:
  - `revision_id`: Revision ID
- **说明**: 识别的测试场景数量

#### 2.3 Diff 处理指标

**Diff 获取统计**
- **指标名称**: `mcp_diff_fetches_total`
- **类型**: Counter
- **标签**:
  - `cache_hit`: 是否命中缓存 (true, false)
  - `force_refresh`: 是否强制刷新 (true, false)
- **说明**: Diff 获取次数

**Diff 文件统计**
- **指标名称**: `mcp_diff_files_total`
- **类型**: Histogram
- **Buckets**: [1, 3, 5, 10, 20, 50, 100]
- **说明**: 每次 Diff 包含的文件数量分布

**Diff 代码行数**
- **指标名称**: `mcp_diff_lines_total`
- **类型**: Histogram
- **标签**:
  - `type`: 变更类型 (additions, deletions)
- **Buckets**: [10, 50, 100, 200, 500, 1000, 2000, 5000]
- **说明**: Diff 代码行数分布

### 3. 资源使用指标

#### 3.1 AI 调用统计

**LLM 调用次数**
- **指标名称**: `mcp_llm_calls_total`
- **类型**: Counter
- **标签**:
  - `model`: 模型名称
  - `purpose`: 调用目的 (review, test_generation, topic_identification, etc.)
  - `status`: 调用状态 (success, error)
- **说明**: LLM API 调用次数

**LLM Token 使用**
- **指标名称**: `mcp_llm_tokens_total`
- **类型**: Counter
- **标签**:
  - `model`: 模型名称
  - `type`: Token 类型 (prompt, completion)
- **说明**: Token 消耗统计

**LLM 调用耗时**
- **指标名称**: `mcp_llm_duration_seconds`
- **类型**: Histogram
- **标签**:
  - `model`: 模型名称
  - `purpose`: 调用目的
- **Buckets**: [0.5, 1, 2, 5, 10, 20, 30, 60]
- **说明**: LLM 调用耗时分布

**Embedding 调用统计**
- **指标名称**: `mcp_embedding_calls_total`
- **类型**: Counter
- **标签**:
  - `model`: Embedding 模型名称
  - `status`: 调用状态
- **说明**: Embedding API 调用次数

#### 3.2 缓存统计

**缓存命中率**
- **指标名称**: `mcp_cache_hits_total`
- **类型**: Counter
- **标签**:
  - `cache_type`: 缓存类型 (diff, state, etc.)
  - `hit`: 是否命中 (true, false)
- **说明**: 缓存命中情况

**缓存大小**
- **指标名称**: `mcp_cache_size_bytes`
- **类型**: Gauge
- **标签**:
  - `cache_type`: 缓存类型
- **说明**: 缓存占用空间

### 4. 项目检测指标

**项目类型统计**
- **指标名称**: `mcp_project_types_total`
- **类型**: Counter
- **标签**:
  - `is_monorepo`: 是否为 Monorepo (true, false)
  - `workspace_type`: 工作空间类型 (npm, pnpm, yarn, lerna, nx, rush, none)
- **说明**: 检测到的项目类型分布

**测试框架统计**
- **指标名称**: `mcp_test_frameworks_total`
- **类型**: Counter
- **标签**:
  - `framework`: 测试框架 (vitest, jest, none)
- **说明**: 检测到的测试框架分布

## 数据收集方式

### 方案一: HTTP API 上报

#### 架构
```
MCP Server → HTTP POST → Metrics Collector API → Time Series DB → Grafana
```

#### 实现要点
1. 在 MCP Server 中添加 MetricsCollector 类
2. 异步上报,不阻塞主流程
3. 批量上报,减少网络开销
4. 失败重试机制

#### API 接口设计
```typescript
POST /api/v1/metrics
Content-Type: application/json

{
  "timestamp": 1699999999000,
  "metrics": [
    {
      "name": "mcp_tool_calls_total",
      "type": "counter",
      "value": 1,
      "labels": {
        "tool_name": "review-frontend-diff",
        "status": "success",
        "user_id": "user123"
      }
    },
    {
      "name": "mcp_tool_duration_seconds",
      "type": "histogram",
      "value": 12.5,
      "labels": {
        "tool_name": "review-frontend-diff",
        "status": "success"
      }
    }
  ]
}
```

#### 配置示例
```yaml
# config.yaml
metrics:
  enabled: true
  endpoint: "https://metrics.example.com/api/v1/metrics"
  apiKey: "your-api-key"
  batchSize: 100
  flushInterval: 10000  # 10秒
  retryAttempts: 3
```

### 方案二: Prometheus Exporter

#### 架构
```
MCP Server (Exporter) ← Prometheus (Pull) → Grafana
```

#### 实现要点
1. 在 MCP Server 中启动 HTTP 服务器
2. 暴露 `/metrics` 端点
3. 使用 prom-client 库
4. Prometheus 定期拉取

#### 优缺点
- ✅ 标准化,生态成熟
- ✅ 不需要额外的 API 服务
- ❌ 需要 MCP Server 暴露端口
- ❌ 可能不适合 MCP 的运行环境

### 方案三: 日志文件 + Collector

#### 架构
```
MCP Server → Structured Logs → Log Collector → Time Series DB → Grafana
```

#### 实现要点
1. 使用结构化日志(JSON格式)
2. 特定前缀标识指标日志
3. 外部 Collector 解析日志
4. 推送到时序数据库

#### 日志格式示例
```json
{
  "level": "info",
  "timestamp": "2024-11-05T10:30:00.000Z",
  "type": "metric",
  "metric": {
    "name": "mcp_tool_calls_total",
    "type": "counter",
    "value": 1,
    "labels": {
      "tool_name": "review-frontend-diff",
      "status": "success"
    }
  }
}
```

## 推荐方案

**推荐使用方案一: HTTP API 上报**

理由:
1. ✅ 实现简单,不影响 MCP Server 架构
2. ✅ 异步上报,性能影响小
3. ✅ 灵活性高,易于扩展
4. ✅ 适合 MCP 的运行环境
5. ✅ 可以收集用户级别的数据

## Grafana 仪表盘设计

### Dashboard 1: 总览
- 今日/本周/本月调用次数
- 各工具使用占比(饼图)
- 调用成功率趋势
- 平均响应时间趋势

### Dashboard 2: 代码审查
- 审查执行次数趋势
- 发现问题数量趋势
- 问题严重程度分布
- 各 Agent 执行次数
- 问题发布成功率
- Top 10 常见问题类型

### Dashboard 3: 测试生成
- 测试生成次数趋势
- 生成测试用例数量
- 测试场景分布
- 测试框架使用分布
- 平均生成时间

### Dashboard 4: 性能监控
- P50/P95/P99 响应时间
- LLM 调用次数和耗时
- Token 消耗统计
- 缓存命中率
- 错误率趋势

### Dashboard 5: 项目分析
- 项目类型分布
- Monorepo vs 单仓库
- 测试框架分布
- 平均文件数/代码行数

## 实施步骤

### 第一阶段: 基础设施
1. 搭建 Metrics Collector API 服务
2. 配置时序数据库(InfluxDB/Prometheus/TimescaleDB)
3. 配置 Grafana 并连接数据源

### 第二阶段: 代码集成
1. 在 MCP Server 中添加 MetricsCollector 类
2. 在关键位置插入指标收集代码
3. 实现批量上报和重试机制
4. 添加配置选项

### 第三阶段: 仪表盘开发
1. 创建 Grafana Dashboard
2. 配置告警规则
3. 测试和优化

### 第四阶段: 上线和监控
1. 灰度发布
2. 监控数据质量
3. 根据反馈优化指标和仪表盘

## 隐私和安全考虑

1. **数据脱敏**: 不收集敏感的代码内容
2. **用户标识**: 使用匿名化的用户 ID
3. **可选退出**: 提供配置选项禁用统计
4. **数据保留**: 设置合理的数据保留期限
5. **访问控制**: 限制 Grafana 访问权限

## 成本估算

### 基础设施成本
- Metrics Collector API: 1-2 台服务器
- 时序数据库: 根据数据量选择
- Grafana: 可使用开源版本

### 开发成本
- 后端 API 开发: 3-5 天
- MCP 集成: 2-3 天
- Grafana 仪表盘: 2-3 天
- 测试和优化: 2-3 天

**总计**: 约 2 周开发周期

## 附录: 代码示例

### MetricsCollector 类接口
```typescript
interface MetricData {
  name: string;
  type: 'counter' | 'histogram' | 'gauge';
  value: number;
  labels?: Record<string, string>;
  timestamp?: number;
}

class MetricsCollector {
  // 记录计数器
  incrementCounter(name: string, labels?: Record<string, string>): void;
  
  // 记录直方图
  recordHistogram(name: string, value: number, labels?: Record<string, string>): void;
  
  // 记录仪表盘
  setGauge(name: string, value: number, labels?: Record<string, string>): void;
  
  // 记录工具调用
  recordToolCall(toolName: string, duration: number, status: 'success' | 'error'): void;
  
  // 批量上报
  flush(): Promise<void>;
}
```

### 使用示例
```typescript
// 在工具调用处
const startTime = Date.now();
try {
  const result = await tool.execute(input);
  const duration = (Date.now() - startTime) / 1000;
  
  metricsCollector.recordToolCall(toolName, duration, 'success');
  metricsCollector.incrementCounter('mcp_tool_calls_total', {
    tool_name: toolName,
    status: 'success'
  });
  
  return result;
} catch (error) {
  const duration = (Date.now() - startTime) / 1000;
  
  metricsCollector.recordToolCall(toolName, duration, 'error');
  metricsCollector.incrementCounter('mcp_tool_errors_total', {
    tool_name: toolName,
    error_type: error.name
  });
  
  throw error;
}
```

