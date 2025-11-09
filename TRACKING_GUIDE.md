# 监控数据上报功能使用指南

## 概述

本项目实现了基于远程API的监控数据上报功能，可以将MCP服务器的运行状态、工具调用情况、错误信息等实时上报到远程监控服务。

## 功能特性

- ✅ 自动上报工具调用事件（成功/失败、耗时统计）
- ✅ 自动上报服务器生命周期事件（启动、关闭）
- ✅ 自动上报错误事件
- ✅ 与 Metrics 系统集成，自动上报所有指标
- ✅ 支持环境区分（dev环境不上报）
- ✅ 非侵入式设计，不影响主业务流程
- ✅ 异步上报，不阻塞主流程

## 配置

### 1. 环境变量配置

在 `.env` 文件或 MCP 客户端配置中设置：

```bash
# 监控上报配置（可选）
TRACKING_ENABLED=true                # 是否启用上报（默认 true）
TRACKING_APP_ID=MCP_SERVICE          # 应用标识（默认 MCP_SERVICE）
TRACKING_APP_VERSION=3.0.0           # 应用版本
TRACKING_ENV=prod                    # 环境：dev/test/prod（dev不上报）
TRACKING_MEASUREMENT=mcp_service_metrics  # 指标名称
TRACKING_METRICS_TYPE=metricsType1   # 指标类型
```

### 2. YAML 配置文件

在 `config.yaml` 中配置：

```yaml
tracking:
  enabled: true
  appId: MCP_SERVICE
  appVersion: 3.0.0
  env: prod  # dev（不上报）、test、prod（统一使用测试环境地址）
  measurement: mcp_service_metrics
  metricsType: metricsType1
```

## 上报时机

### 自动上报事件

1. **服务器生命周期事件**
   - 服务器初始化完成：`server_initialized`
   - 服务器启动：`server_started`
   - 服务器关闭：`server_shutdown`

2. **工具调用事件**
   - 每次工具调用都会自动上报：
     - 工具名称
     - 执行时长（毫秒）
     - 状态（success/error）
     - 错误信息（如果失败）

3. **Metrics 事件**
   - 所有通过 `getMetrics()` 记录的指标都会自动上报
   - 包括：Counter、Timer、Histogram、Gauge

4. **错误事件**
   - 服务器启动失败
   - 致命错误
   - 其他异常情况

## 上报接口

### 接口地址

- **测试/生产环境**: `https://event-tracking-api-test.yangqianguan.com/logMetrics`
- **开发环境**: 不上报（仅打印日志）

### 请求格式

```typescript
POST https://event-tracking-api-test.yangqianguan.com/logMetrics

Headers:
  YQG-PLATFORM-SDK-TYPE: MCP_SERVICE
  CONTENT-TYPE: application/json;charset=UTF-8
  Country: CN

Body:
{
  "level": "INFO" | "WARN" | "ERROR",
  "logs": [{
    "appId": "MCP_SERVICE",
    "appVersion": "3.0.0",
    "osType": "Server",
    "measurement": "mcp_service_metrics",
    "metricsType": "metricsType1",
    "time": "1704067200000",
    "message": "mcp service monitoring",
    "parameter": {
      // 自定义上报数据
      "eventType": "tool_call",
      "toolName": "fetch-diff",
      "duration": 150,
      "status": "success"
    }
  }]
}
```

## 数据字段说明

### 工具调用事件

```json
{
  "eventType": "tool_call",
  "toolName": "fetch-diff",
  "duration": 150,
  "status": "success",
  "errorMessage": null
}
```

### 服务器事件

```json
{
  "eventType": "server_started",
  "transport": "stdio",
  "port": 3000,
  "timestamp": 1704067200000
}
```

### Metrics 事件

```json
{
  "eventType": "metric_recorded",
  "metricType": "counter",
  "metricName": "tool.execution.started",
  "value": 1,
  "labels": {
    "tool": "fetch-diff"
  }
}
```

### 错误事件

```json
{
  "eventType": "error",
  "errorType": "server_start_failed",
  "errorMessage": "Failed to connect to database",
  "timestamp": 1704067200000
}
```

## 使用示例

### 手动上报自定义事件

```typescript
import { getAppContext } from './core/app-context.js';

const tracking = getAppContext().tracking;

if (tracking) {
  // 上报自定义事件
  await tracking.track({
    eventType: 'custom_event',
    action: 'user_action',
    metadata: {
      userId: '123',
      action: 'button_click'
    }
  });

  // 上报工具调用（已自动实现，这里仅作示例）
  await tracking.trackToolCall('my-tool', 200, 'success');

  // 上报Agent执行
  await tracking.trackAgentExecution('ReviewAgent', 1500, 'success', {
    topicsCount: 5,
    issuesFound: 3
  });

  // 上报服务器事件
  await tracking.trackServerEvent('custom_event', {
    customField: 'value'
  });

  // 上报错误
  await tracking.trackError('validation_error', 'Invalid input', {
    input: 'some data',
    field: 'revisionId'
  });

  // 批量上报
  await tracking.trackBatch([
    { parameter: { event: 'event1' }, message: 'Event 1' },
    { parameter: { event: 'event2' }, message: 'Event 2' }
  ]);
}
```

## 风格化运行方式

项目基于 `fastmcp` 实现，既支持 stdio，也支持 HTTP Streaming（含 SSE）。

```bash
# Stdio 模式（默认）
npm start

# HTTP Streaming 模式
npm start -- --transport=httpStream
# 或通过环境变量
TRANSPORT_MODE=httpStream HTTP_PORT=3000 npm start
```

### HTTP Streaming 端点

- `POST http://localhost:3000/mcp` - MCP 主端点（HTTP Streaming）
- `GET http://localhost:3000/sse` - SSE 端点（自动可用）

### FastMCP 特性

- ✅ 自动处理工具注册
- ✅ 内置 HTTP Streaming / SSE 支持
- ✅ 简化的 API 设计
- ✅ 完整的监控数据上报支持

## 开发环境

在开发环境（`TRACKING_ENV=dev`）下：

- 不会真实上报数据
- 仅在日志中输出上报信息
- 方便本地调试和测试

## 注意事项

1. **错误处理**：上报失败不会影响主业务流程，所有上报操作都是异步的
2. **性能影响**：上报操作不会阻塞主流程，对性能影响最小
3. **数据隐私**：确保上报的数据不包含敏感信息
4. **网络要求**：需要能够访问 `event-tracking-api-test.yangqianguan.com`

## 监控查询

上报的数据会存储在远程监控系统中，可以通过相应的查询接口或监控面板查看：

- 工具调用统计
- 错误率分析
- 性能指标趋势
- 服务器运行状态

## 参考

- 实现代码：`src/utils/tracking-service.ts`
- Metrics 集成：`src/utils/metrics.ts`
- FastMCP 入口：`src/index.ts`
- 接口文档：`监控数据上报接口说明.md`
