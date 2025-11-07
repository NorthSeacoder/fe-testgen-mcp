import type { TestCase } from '../schemas/test-plan.js';

export interface TestQualityMetrics {
  coverage: {
    functions: number;      // 函数覆盖率 (%)
    branches: number;       // 分支覆盖率 (%)
    lines: number;          // 行覆盖率 (%)
  };
  quality: {
    score: number;         // 质量评分 (0-100)
    strengths: string[];   // 优点
    weaknesses: string[];  // 缺点
  };
  suggestions: string[];   // 改进建议
}

export class TestQualityEvaluator {
  /**
   * 评估测试用例质量
   */
  async evaluateQuality(
    tests: TestCase[],
    sourceCodeAnalysis?: {
      functions: number;
      branches: number;
      totalLines: number;
    }
  ): Promise<TestQualityMetrics> {
    const strengths: string[] = [];
    const weaknesses: string[] = [];
    const suggestions: string[] = [];

    // 1. 场景覆盖分析
    const scenarios = new Set(tests.map(t => t.scenario));
    if (scenarios.has('happy-path')) {
      strengths.push('包含正常路径测试');
    } else {
      weaknesses.push('缺少正常路径测试');
      suggestions.push('建议添加正常路径测试用例');
    }

    if (scenarios.has('edge-case')) {
      strengths.push('包含边界值测试');
    } else {
      weaknesses.push('缺少边界值测试');
      suggestions.push('建议添加边界值测试用例');
    }

    if (scenarios.has('error-path')) {
      strengths.push('包含异常处理测试');
    } else {
      weaknesses.push('缺少异常处理测试');
      suggestions.push('建议添加异常处理测试用例');
    }

    // 2. 测试用例数量评估
    const testCount = tests.length;
    if (testCount < 3) {
      weaknesses.push('测试用例数量较少');
      suggestions.push('建议增加测试用例数量，至少覆盖主要场景');
    } else if (testCount >= 5) {
      strengths.push('测试用例数量充足');
    }

    // 3. 置信度评估
    const avgConfidence = tests.reduce((sum, t) => sum + t.confidence, 0) / tests.length;
    if (avgConfidence >= 0.8) {
      strengths.push('测试用例置信度高');
    } else if (avgConfidence < 0.6) {
      weaknesses.push('测试用例置信度较低');
      suggestions.push('建议提高测试用例的置信度，确保测试覆盖关键逻辑');
    }

    // 4. 测试代码质量评估
    const hasDescriptions = tests.filter(t => t.description).length;
    if (hasDescriptions / tests.length >= 0.8) {
      strengths.push('测试用例描述完善');
    } else {
      weaknesses.push('部分测试用例缺少描述');
      suggestions.push('建议为所有测试用例添加清晰的描述');
    }

    // 5. 覆盖率估算（如果有源码分析）
    let coverage = {
      functions: 0,
      branches: 0,
      lines: 0,
    };

    if (sourceCodeAnalysis) {
      // 简化估算：假设每个测试用例覆盖一个函数
      coverage.functions = Math.min(100, (tests.length / sourceCodeAnalysis.functions) * 100);
      coverage.branches = Math.min(100, (scenarios.size * 20)); // 简化估算
      coverage.lines = Math.min(100, (tests.length * 10)); // 简化估算
    }

    // 6. 综合质量评分
    let score = 50; // 基础分

    // 场景覆盖加分
    score += scenarios.size * 10;

    // 测试数量加分
    if (testCount >= 5) score += 10;
    else if (testCount >= 3) score += 5;

    // 置信度加分
    score += avgConfidence * 20;

    // 描述完整度加分
    score += (hasDescriptions / tests.length) * 10;

    // 覆盖率加分
    if (sourceCodeAnalysis) {
      score += (coverage.functions / 100) * 10;
    }

    score = Math.min(100, Math.max(0, score));

    return {
      coverage,
      quality: {
        score: Math.round(score),
        strengths,
        weaknesses,
      },
      suggestions,
    };
  }

  /**
   * 生成质量报告
   */
  generateReport(metrics: TestQualityMetrics): string {
    const { coverage, quality, suggestions } = metrics;

    let report = `## 测试质量评估报告\n\n`;
    report += `**综合评分**: ${quality.score}/100\n\n`;

    report += `### 优点\n`;
    if (quality.strengths.length > 0) {
      quality.strengths.forEach(s => {
        report += `- ✅ ${s}\n`;
      });
    } else {
      report += `- 暂无\n`;
    }

    report += `\n### 需要改进\n`;
    if (quality.weaknesses.length > 0) {
      quality.weaknesses.forEach(w => {
        report += `- ⚠️ ${w}\n`;
      });
    } else {
      report += `- 暂无\n`;
    }

    if (coverage.functions > 0 || coverage.branches > 0 || coverage.lines > 0) {
      report += `\n### 覆盖率估算\n`;
      report += `- 函数覆盖率: ${coverage.functions.toFixed(1)}%\n`;
      report += `- 分支覆盖率: ${coverage.branches.toFixed(1)}%\n`;
      report += `- 行覆盖率: ${coverage.lines.toFixed(1)}%\n`;
    }

    if (suggestions.length > 0) {
      report += `\n### 改进建议\n`;
      suggestions.forEach(s => {
        report += `- 💡 ${s}\n`;
      });
    }

    return report;
  }
}

