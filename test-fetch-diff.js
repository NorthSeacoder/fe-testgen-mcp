#!/usr/bin/env node

/**
 * fetch-diff 工具测试脚本
 * 
 * 使用方法:
 *   node test-fetch-diff.js D12345
 *   node test-fetch-diff.js 12345
 */

import { FetchDiffTool } from './dist/tools/fetch-diff.js';
import { PhabricatorClient } from './dist/clients/phabricator.js';
import { Cache } from './dist/cache/cache.js';
import { loadConfig } from './dist/config/loader.js';
import dotenv from 'dotenv';

dotenv.config();

async function testFetchDiff() {
  // 从命令行参数获取 revision ID
  const revisionId = process.argv[2];
  
  if (!revisionId) {
    console.error('❌ 错误: 请提供 Revision ID');
    console.log('\n使用方法:');
    console.log('  node test-fetch-diff.js D12345');
    console.log('  node test-fetch-diff.js 12345');
    process.exit(1);
  }

  try {
    console.log(`\n🔍 测试 fetch-diff 工具...`);
    console.log(`📋 Revision ID: ${revisionId}\n`);

    // 加载配置
    const config = loadConfig();
    
    // 初始化客户端
    const phabricator = new PhabricatorClient({
      host: config.phabricator.host,
      token: config.phabricator.token,
    });
    
    const cache = new Cache({
      dir: config.cache.dir,
      ttl: config.cache.ttl,
    });

    // 创建工具实例
    const tool = new FetchDiffTool(phabricator, cache);
    
    // 执行工具
    const startTime = Date.now();
    const result = await tool.execute({ revisionId });
    const duration = Date.now() - startTime;

    if (result.success && result.data) {
      console.log('✅ 工具执行成功!\n');
      console.log('📊 结果概览:');
      console.log(`  - Revision ID: ${result.data.diff.revisionId}`);
      console.log(`  - Diff ID: ${result.data.diff.diffId}`);
      console.log(`  - 标题: ${result.data.diff.title}`);
      console.log(`  - 文件数: ${result.data.diff.files.length}`);
      console.log(`  - 数据来源: ${result.data.source}`);
      console.log(`  - 执行时间: ${duration}ms\n`);
      
      // 显示文件列表
      console.log('📁 变更文件:');
      result.data.diff.files.forEach((file, index) => {
        console.log(`  ${index + 1}. ${file.path}`);
        console.log(`     类型: ${file.changeType}, +${file.additions} -${file.deletions}`);
      });
    } else {
      console.error('❌ 工具执行失败!');
      console.error(`错误: ${result.error}`);
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ 发生错误:');
    console.error(error.message);
    if (error.stack) {
      console.error('\n堆栈跟踪:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

testFetchDiff().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

