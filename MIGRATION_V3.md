# 迁移到 FastMCP v3.0

## 概述

v3.0 版本完全迁移到 `fastmcp` 库，移除了旧的 `@modelcontextprotocol/sdk` 实现和 Prometheus 相关功能，专注于：

- ✅ **FastMCP**：简化的 MCP 服务器实现
- ✅ **监控数据上报**：主动推送到远程监控服务
- ✅ **HTTP Streaming**：内置支持 SSE

## 主要变更

### 1. 移除的功能

- ❌ 旧的 `@modelcontextprotocol/sdk` 实现（`src/index.ts` 旧版本）
- ❌ 自定义 HTTP Transport（`src/transports/http.ts`）
- ❌ Prometheus Exporter（`src/utils/prometheus-exporter.ts`）
- ❌ Express/CORS 依赖
- ❌ `prom-client` 依赖
- ❌ `npm run start:fastmcp` 命令（现在只有一个入口）

### 2. 新增/保留的功能

- ✅ **FastMCP 实现**：`src/index.ts` 现在使用 fastmcp
- ✅ **监控数据上报**：`src/utils/tracking-service.ts`
- ✅ **Metrics 集成**：自动上报到远程监控服务
- ✅ **HTTP Streaming**：通过 fastmcp 内置支持
- ✅ **SSE 端点**：自动提供

## 运行方式

### 之前（v2.x）

```bash
# 标准版本 stdio
npm start

# 标准版本 HTTP
npm start -- --transport=http

# FastMCP 版本 stdio
npm run start:fastmcp

# FastMCP 版本 HTTP Streaming
npm run start:fastmcp -- --transport=httpStream
```

### 现在（v3.0）

```bash
# Stdio 模式（默认）
npm start

# HTTP Streaming 模式
npm start -- --transport=httpStream
# 或
TRANSPORT_MODE=httpStream HTTP_PORT=3000 npm start
```

## 端点变更

### 之前（v2.x 标准版本）

```
GET  /api/tools          - 列出工具
POST /api/tools/call     - 调用工具
GET  /api/metrics        - Prometheus 指标
GET  /api/health         - 健康检查
```

### 现在（v3.0 FastMCP）

```
POST http://localhost:3000/mcp  - MCP 主端点（HTTP Streaming）
GET  http://localhost:3000/sse  - SSE 端点（自动可用）
```

## 监控变更

### 之前（v2.x）

- Prometheus metrics 通过 `/api/metrics` 暴露
- 被动拉取模式（Prometheus 主动抓取）

### 现在（v3.0）

- 监控数据主动上报到远程 API
- 推送模式（服务主动发送）
- 配置简化，只需设置 tracking 参数

## 配置变更

### 环境变量

**新增**：

```bash
TRACKING_ENABLED=true
TRACKING_APP_ID=MCP_SERVICE
TRACKING_APP_VERSION=3.0.0
TRACKING_ENV=prod
TRACKING_MEASUREMENT=mcp_service_metrics
TRACKING_METRICS_TYPE=metricsType1
```

**移除**：

- 不再需要 Prometheus 相关配置
- 不再需要 HTTP Transport 相关的自定义配置

### config.yaml

**新增**：

```yaml
tracking:
  enabled: true
  appId: MCP_SERVICE
  appVersion: 3.0.0
  env: prod
  measurement: mcp_service_metrics
  metricsType: metricsType1
```

## 依赖变更

### 移除的依赖

```json
{
  "@modelcontextprotocol/sdk": "^1.0.4",
  "express": "^4.21.2",
  "cors": "^2.8.5",
  "prom-client": "^15.1.3",
  "@types/express": "^4.17.21",
  "@types/cors": "^2.8.17"
}
```

### 新增的依赖

```json
{
  "fastmcp": "^3.22.0"
}
```

### 保留的依赖

```json
{
  "dotenv": "^16.4.7",
  "keyv": "^4.5.4",
  "keyv-file": "^0.2.0",
  "openai": "^4.73.0",
  "p-limit": "^5.0.0",
  "winston": "^3.15.0",
  "yaml": "^2.6.1",
  "zod": "^3.24.1"
}
```

## 迁移步骤

### 1. 更新依赖

```bash
# 拉取最新代码
git pull

# 安装依赖
npm install

# 重新构建
npm run build
```

### 2. 更新配置

在 `.env` 或 MCP 客户端配置中添加监控配置：

```bash
# 监控数据上报配置（可选）
TRACKING_ENABLED=true
TRACKING_APP_ID=MCP_SERVICE
TRACKING_APP_VERSION=3.0.0
TRACKING_ENV=prod  # dev/test/prod
```

### 3. 更新启动命令

如果之前使用：

```bash
npm run start:fastmcp
```

现在改为：

```bash
npm start
```

如果需要 HTTP Streaming：

```bash
npm start -- --transport=httpStream
```

### 4. 更新监控集成

如果之前集成了 Prometheus：

1. 移除 Prometheus scrape 配置
2. 配置监控数据上报服务（见上文）
3. 通过远程监控服务查看数据

## 破坏性变更

### API 变更

- **移除**：`/api/tools`, `/api/tools/call`, `/api/metrics`, `/api/health` 端点
- **新增**：FastMCP 标准端点 `/mcp` 和 `/sse`

### 代码变更

如果有自定义代码依赖以下内容，需要更新：

- `src/transports/http.ts` - 已删除
- `src/utils/prometheus-exporter.ts` - 已删除
- `src/index.ts` 中的旧 SDK 实现 - 已替换为 fastmcp

### 配置变更

- Prometheus 配置不再有效
- 需要配置 tracking 参数启用监控数据上报

## 兼容性说明

### 客户端兼容性

FastMCP 完全兼容 MCP 协议，所有支持 MCP 的客户端（Cursor、Claude Desktop 等）都可以正常使用。

### Stdio 模式

Stdio 模式完全向后兼容，无需修改客户端配置。

### HTTP 模式

HTTP 模式从自定义实现迁移到 FastMCP 的 HTTP Streaming，端点有所变化，需要更新客户端配置。

## 优势

### 简化

- 单一入口点，不再有多个版本
- 更少的依赖
- 更简洁的代码库

### 性能

- FastMCP 内置优化
- HTTP Streaming 更高效
- 减少了中间层

### 可维护性

- 统一的实现
- 更少的自定义代码
- 更容易升级

## 问题排查

### 问题：启动失败

**检查**：
- 确保已运行 `npm install`
- 确保已运行 `npm run build`
- 检查环境变量是否正确设置

### 问题：监控数据未上报

**检查**：
- 确认 `TRACKING_ENABLED=true`
- 确认 `TRACKING_ENV` 不是 `dev`
- 检查网络连接到上报地址

### 问题：HTTP Streaming 无法连接

**检查**：
- 确认使用了 `--transport=httpStream` 参数
- 确认端口未被占用
- 检查防火墙设置

## 获取帮助

- 查看 [README.md](./README.md) 了解详细使用说明
- 查看 [TRACKING_GUIDE.md](./TRACKING_GUIDE.md) 了解监控配置
- 查看 [CHANGELOG_TRACKING.md](./CHANGELOG_TRACKING.md) 了解详细变更

## 回退

如果需要回退到 v2.x 版本：

```bash
git checkout v2.x
npm install
npm run build
```

**注意**：v2.x 将不再接收新功能更新，仅进行关键 bug 修复。
