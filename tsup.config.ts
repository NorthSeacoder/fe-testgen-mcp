import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false, // 暂时禁用类型定义生成以避免 FastMCP 类型错误
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
  target: 'node18',
  platform: 'node',
  // 确保 Node.js 内置模块正确处理
  noExternal: [],
});

