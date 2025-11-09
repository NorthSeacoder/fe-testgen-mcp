# HTTP Transport 使用指南

## 概述

fe-testgen-mcp v3.0 新增 HTTP Transport 支持，允许通过 HTTP API 调用 MCP 工具，而不仅限于 stdio 通信。

**适用场景**：
- 🌐 Web UI 集成
- 🔌 远程 API 调用
- 📊 Prometheus 监控集成
- 🧪 API 测试和调试

## 快速开始

### 启动 HTTP 模式

#### 方法 1: 命令行参数

```bash
npm start -- --transport=http
```

#### 方法 2: 环境变量

```bash
export TRANSPORT_MODE=http
export HTTP_PORT=3000  # 可选，默认 3000
npm start
```

#### 方法 3: 使用 node 直接运行

```bash
node dist/index.js --transport=http
```

### 验证服务启动

```bash
# 健康检查
curl http://localhost:3000/api/health

# 预期输出
{"status":"ok","timestamp":1762672875697}
```

## API 端点

### 1. 列出所有工具

**请求**：
```bash
GET /api/tools
```

**响应示例**：
```json
{
  "tools": [
    {
      "name": "fetch-diff",
      "description": "从 Phabricator 获取完整的 diff 内容",
      "inputSchema": {
        "type": "object",
        "properties": {
          "revisionId": {
            "type": "string",
            "description": "Revision ID（如 D551414）"
          },
          "forceRefresh": {
            "type": "boolean",
            "description": "强制刷新缓存"
          }
        },
        "required": ["revisionId"]
      }
    }
  ]
}
```

### 2. 调用工具

**请求**：
```bash
POST /api/tools/call
Content-Type: application/json

{
  "name": "fetch-diff",
  "arguments": {
    "revisionId": "D551414"
  }
}
```

**响应示例**：
```json
{
  "success": true,
  "data": {
    "diff": {
      "revisionId": "D551414",
      "diffId": "1234567",
      "files": [...]
    },
    "source": "cache"
  },
  "metadata": {
    "duration": 152,
    "toolName": "fetch-diff"
  }
}
```

**错误响应示例**：
```json
{
  "success": false,
  "error": "Tool 'invalid-tool' not found",
  "metadata": {
    "duration": 5,
    "toolName": "invalid-tool"
  }
}
```

### 3. Prometheus Metrics

**请求**：
```bash
GET /api/metrics
```

**响应示例**（Prometheus 格式）：
```
# TYPE fe_testgen_mcp_server_initialization_success counter
fe_testgen_mcp_server_initialization_success{service="fe-testgen-mcp",version="3.0.0"} 1 1762672875697

# TYPE fe_testgen_mcp_tool_execution_started counter
fe_testgen_mcp_tool_execution_started{service="fe-testgen-mcp",version="3.0.0",tool="fetch-diff"} 5 1762672875697

# TYPE fe_testgen_mcp_tool_execution_duration histogram
fe_testgen_mcp_tool_execution_duration_bucket{service="fe-testgen-mcp",version="3.0.0",tool="fetch-diff",le="0.1"} 2
fe_testgen_mcp_tool_execution_duration_bucket{service="fe-testgen-mcp",version="3.0.0",tool="fetch-diff",le="0.5"} 4
fe_testgen_mcp_tool_execution_duration_bucket{service="fe-testgen-mcp",version="3.0.0",tool="fetch-diff",le="1"} 5
fe_testgen_mcp_tool_execution_duration_sum{service="fe-testgen-mcp",version="3.0.0",tool="fetch-diff"} 1523
fe_testgen_mcp_tool_execution_duration_count{service="fe-testgen-mcp",version="3.0.0",tool="fetch-diff"} 5
```

### 4. 健康检查

**请求**：
```bash
GET /api/health
```

**响应示例**：
```json
{
  "status": "ok",
  "timestamp": 1762672875697
}
```

## CORS 配置

默认配置允许所有来源（`origin: '*'`）。如需自定义，修改 `src/index.ts`：

```typescript
httpTransport = new HttpTransport(toolRegistry, {
  port: httpPort,
  host: '0.0.0.0',
  cors: {
    origin: ['https://your-frontend.com'],
    credentials: true,
  },
});
```

## 完整示例

### 使用 cURL

```bash
# 列出工具
curl http://localhost:3000/api/tools

# 调用工具
curl -X POST http://localhost:3000/api/tools/call \
  -H "Content-Type: application/json" \
  -d '{
    "name": "fetch-diff",
    "arguments": {
      "revisionId": "D551414"
    }
  }'

# 获取 metrics
curl http://localhost:3000/api/metrics
```

### 使用 JavaScript/TypeScript

```typescript
// 调用工具
async function callTool(name: string, args: Record<string, any>) {
  const response = await fetch('http://localhost:3000/api/tools/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
  });
  
  return response.json();
}

// 使用示例
const result = await callTool('fetch-diff', { revisionId: 'D551414' });
console.log(result);
```

### 使用 Python

```python
import requests

def call_tool(name: str, args: dict):
    response = requests.post(
        'http://localhost:3000/api/tools/call',
        json={'name': name, 'arguments': args}
    )
    return response.json()

# 使用示例
result = call_tool('fetch-diff', {'revisionId': 'D551414'})
print(result)
```

## Prometheus 集成

### 配置 Prometheus 抓取

在 `prometheus.yml` 中添加：

```yaml
scrape_configs:
  - job_name: 'fe-testgen-mcp'
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: '/api/metrics'
    scrape_interval: 15s
```

### 常用 PromQL 查询

```promql
# 工具调用总数
sum(fe_testgen_mcp_tool_execution_started)

# 每分钟工具调用率
rate(fe_testgen_mcp_tool_execution_started[1m])

# 工具执行平均时长
rate(fe_testgen_mcp_tool_execution_duration_sum[5m]) 
/ 
rate(fe_testgen_mcp_tool_execution_duration_count[5m])

# 慢查询（超过 1 秒）
fe_testgen_mcp_tool_execution_duration_bucket{le="1"} 
- 
fe_testgen_mcp_tool_execution_duration_bucket{le="0.5"}

# 错误率
rate(fe_testgen_mcp_tool_execution_failed[5m]) 
/ 
rate(fe_testgen_mcp_tool_execution_started[5m])
```

## Grafana 仪表盘

### 推荐面板

1. **总请求数**（Counter）
   - Metric: `fe_testgen_mcp_tool_execution_started`
   - Type: Graph

2. **请求延迟分布**（Histogram）
   - Metric: `fe_testgen_mcp_tool_execution_duration`
   - Type: Heatmap

3. **成功率**（Gauge）
   - Metric: `(sum(rate(fe_testgen_mcp_tool_execution_completed{status="success"}[5m])) / sum(rate(fe_testgen_mcp_tool_execution_started[5m]))) * 100`
   - Type: Gauge

4. **Top 工具**（Table）
   - Metric: `topk(10, sum by (tool) (fe_testgen_mcp_tool_execution_started))`
   - Type: Table

## 性能调优

### 并发控制

HTTP Transport 使用 Express，默认无并发限制。如需限制：

```typescript
// 安装依赖
npm install express-rate-limit

// 在 src/transports/http.ts 中添加
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 分钟
  max: 100, // 限制 100 次请求
});

this.app.use('/api/tools/call', limiter);
```

### 超时控制

```typescript
// 在 src/transports/http.ts 中
this.app.use((req, res, next) => {
  res.setTimeout(60000, () => {
    res.status(408).json({ error: 'Request timeout' });
  });
  next();
});
```

## 安全建议

1. **生产环境禁用 CORS `origin: '*'`**
   ```typescript
   cors: {
     origin: process.env.ALLOWED_ORIGINS?.split(',') || [],
   }
   ```

2. **添加认证中间件**
   ```typescript
   this.app.use((req, res, next) => {
     const apiKey = req.headers['x-api-key'];
     if (apiKey !== process.env.API_KEY) {
       return res.status(401).json({ error: 'Unauthorized' });
     }
     next();
   });
   ```

3. **限制请求大小**（已默认配置为 2MB）
   ```typescript
   this.app.use(express.json({ limit: '2mb' }));
   ```

4. **使用 HTTPS**
   ```bash
   # 使用反向代理（推荐）
   nginx -> fe-testgen-mcp (HTTP)
   ```

## 常见问题

### Q: 如何同时支持 stdio 和 HTTP？

A: 目前一次只能使用一种 transport。如需同时支持，可以启动两个进程：

```bash
# Terminal 1: stdio 模式
npm start

# Terminal 2: HTTP 模式
HTTP_PORT=3001 npm start -- --transport=http
```

### Q: HTTP 模式下如何查看日志？

A: 日志仍然输出到 `logs/fe-testgen-mcp.log`。可以实时查看：

```bash
tail -f logs/fe-testgen-mcp.log
```

### Q: 如何重置 Prometheus metrics？

A: 重启服务即可重置所有 metrics。

### Q: HTTP 模式支持流式响应吗？

A: 当前版本不支持 SSE（Server-Sent Events）。如需实时推送，请关注后续版本更新。

## 相关文档

- [FUNCTION_CALLING_GUIDE.md](./FUNCTION_CALLING_GUIDE.md) - Function Calling 使用指南
- [FINAL_ARCHITECTURE_STATUS.md](./FINAL_ARCHITECTURE_STATUS.md) - 架构状态报告
- [README.md](./README.md) - 项目总体文档

## 版本历史

- **v3.0.0** (2024-11-09) - ✅ HTTP Transport 基础实现
  - REST API 端点（/api/tools, /api/tools/call, /api/metrics, /api/health）
  - Prometheus Exporter 集成
  - CORS 支持
  - 完整的错误处理

---

**维护者**: fe-testgen-mcp team  
**最后更新**: 2024-11-09
