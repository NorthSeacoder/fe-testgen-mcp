import { createLogger, format, transports } from 'winston';
import { mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 计算项目根目录（避免循环依赖）
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');

/**
 * 自定义 JSON 字符串化函数，保留中文字符不被转义
 */
function jsonStringify(obj: unknown, indent?: number): string {
  const jsonStr = JSON.stringify(obj, null, indent);
  // 将 Unicode 转义序列还原为字符
  return jsonStr.replace(/\\u([0-9a-fA-F]{4})/g, (match, code) => {
    const codePoint = parseInt(code, 16);
    // 只替换可打印字符范围（避免破坏控制字符和特殊字符）
    if (codePoint >= 0x0080 && codePoint <= 0xFFFF) {
      return String.fromCharCode(codePoint);
    }
    // 保持其他转义序列不变（如控制字符）
    return match;
  });
}

/**
 * 自定义 JSON 格式化器，保留中文字符不被转义
 */
const jsonFormat = format.printf((info) => {
  const { timestamp, level, message, ...meta } = info;
  const logEntry = {
    timestamp,
    level,
    message,
    ...meta,
  };
  // 使用自定义的 JSON 字符串化函数
  return jsonStringify(logEntry);
});

const logFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.errors({ stack: true }),
  format.splat(),
  jsonFormat // 使用自定义的 JSON 格式化器
);

const consoleFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? jsonStringify(meta, 2) : '';
    return `${timestamp} [${level}]: ${message} ${metaStr}`;
  })
);

// 判断是否启用日志（默认关闭）
const isDevelopment = process.env.NODE_ENV === 'development';
const enableFileLog = process.env.ENABLE_FILE_LOG === 'true' || isDevelopment;
const enableConsoleLog = process.env.ENABLE_CONSOLE_LOG === 'true' || isDevelopment;

const logTransports: any[] = [];

// 文件日志（默认关闭，只在开发模式或明确启用时开启）
if (enableFileLog) {
  const logDir = join(PROJECT_ROOT, 'logs');
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    // 忽略错误
  }
  
  logTransports.push(
    new transports.File({
      filename: join(logDir, 'fe-testgen-mcp.log'),
      format: logFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    })
  );
}

// 控制台日志（默认关闭，只在开发模式或明确启用时开启）
if (enableConsoleLog) {
  logTransports.push(
    new transports.Console({
      format: consoleFormat,
      stderrLevels: ['error', 'warn', 'info', 'debug', 'verbose', 'silly'],
    })
  );
}

// 如果没有配置任何 transport，使用 silent logger 避免警告
// 在 stdio 模式下（MCP 通信），日志会干扰通信，所以默认保持静默
export const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: logTransports,
  silent: logTransports.length === 0, // 没有 transport 时静默
  exitOnError: false,
});

export default logger;

