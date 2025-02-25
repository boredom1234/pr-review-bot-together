import { exec } from 'child_process';
import * as util from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';

const execPromise = util.promisify(exec);

interface QualityIssue {
  path: string;
  line: number;
  message: string;
  rule: string;
  severity: 'critical' | 'warning' | 'suggestion';
}

interface ToolResult {
  issues: QualityIssue[];
  metrics?: {
    [key: string]: number | string;
  };
}

// Detect which tools to use based on repo content
async function detectTools(repoPath: string): Promise<string[]> {
  const tools: string[] = [];
  
  // Check for JavaScript/TypeScript files
  try {
    const hasJsFiles = fs.existsSync(path.join(repoPath, 'package.json'));
    if (hasJsFiles) {
      // Check if ESLint is configured
      if (
        fs.existsSync(path.join(repoPath, '.eslintrc.js')) ||
        fs.existsSync(path.join(repoPath, '.eslintrc.json')) ||
        fs.existsSync(path.join(repoPath, '.eslintrc.yml'))
      ) {
        tools.push('eslint');
      }
    }
  } catch (error) {
    console.error('Error detecting JS tools:', error);
  }
  
  // Check for Python files
  try {
    const hasPyFiles = fs.readdirSync(repoPath).some(file => file.endsWith('.py'));
    if (hasPyFiles) {
      tools.push('pylint');
    }
  } catch (error) {
    console.error('Error detecting Python tools:', error);
  }
  
  // Add more language detection as needed
  
  return tools;
}

// Run ESLint analysis
async function runEslint(repoPath: string, filePaths: string[]): Promise<ToolResult> {
  try {
    // Install ESLint if not already installed
    await execPromise('npm install eslint --no-save', { cwd: repoPath });
    
    // Filter for JS/TS files
    const jsFiles = filePaths.filter(file => 
      file.endsWith('.js') || 
      file.endsWith('.jsx') || 
      file.endsWith('.ts') || 
      file.endsWith('.tsx')
    );
    
    if (jsFiles.length === 0) {
      return { issues: [] };
    }
    
    // Run ESLint with JSON reporter
    const { stdout } = await execPromise(
      `npx eslint ${jsFiles.join(' ')} --format json`,
      { cwd: repoPath }
    );
    
    const eslintResults = JSON.parse(stdout);
    
    // Transform ESLint results to our format
    const issues: QualityIssue[] = [];
    
    eslintResults.forEach((result: any) => {
      result.messages.forEach((msg: any) => {
        issues.push({
          path: result.filePath.replace(`${repoPath}/`, ''),
          line: msg.line,
          message: msg.message,
          rule: msg.ruleId || 'unknown',
          severity: msg.severity === 2 ? 'critical' : (msg.severity === 1 ? 'warning' : 'suggestion')
        });
      });
    });
    
    // Calculate metrics
    const metrics = {
      totalIssues: issues.length,
      criticalIssues: issues.filter(i => i.severity === 'critical').length,
      warningIssues: issues.filter(i => i.severity === 'warning').length,
      filesWithIssues: new Set(issues.map(i => i.path)).size
    };
    
    return { issues, metrics };
  } catch (error) {
    console.error('Error running ESLint:', error);
    return { issues: [] };
  }
}

// Run Pylint analysis
async function runPylint(repoPath: string, filePaths: string[]): Promise<ToolResult> {
  try {
    // Install Pylint if not already installed
    await execPromise('pip install pylint', { cwd: repoPath });
    
    // Filter for Python files
    const pyFiles = filePaths.filter(file => file.endsWith('.py'));
    
    if (pyFiles.length === 0) {
      return { issues: [] };
    }
    
    // Run Pylint with JSON reporter
    const { stdout } = await execPromise(
      `pylint --output-format=json ${pyFiles.join(' ')}`,
      { cwd: repoPath }
    );
    
    const pylintResults = JSON.parse(stdout);
    
    // Transform Pylint results to our format
    const issues: QualityIssue[] = [];
    
    pylintResults.forEach((result: any) => {
      // Map Pylint severity to our severity levels
      let severity: 'critical' | 'warning' | 'suggestion';
      if (result.type === 'error') {
        severity = 'critical';
      } else if (result.type === 'warning') {
        severity = 'warning';
      } else {
        severity = 'suggestion';
      }
      
      issues.push({
        path: result.path,
        line: result.line,
        message: result.message,
        rule: result.symbol,
        severity
      });
    });
    
    // Calculate metrics
    const metrics = {
      totalIssues: issues.length,
      criticalIssues: issues.filter(i => i.severity === 'critical').length,
      warningIssues: issues.filter(i => i.severity === 'warning').length,
      filesWithIssues: new Set(issues.map(i => i.path)).size
    };
    
    return { issues, metrics };
  } catch (error) {
    console.error('Error running Pylint:', error);
    return { issues: [] };
  }
}

// Main function to run quality metrics
export async function runQualityMetrics(
  repoPath: string, 
  changedFiles: string[]
): Promise<{
  issues: QualityIssue[],
  metrics: { [tool: string]: { [metric: string]: number | string } }
}> {
  const enableMetrics = core.getInput('enable_quality_metrics') === 'true';
  if (!enableMetrics) {
    return { issues: [], metrics: {} };
  }
  
  let toolsToRun = core.getInput('quality_tools').split(',').map(t => t.trim());
  
  // Auto-detect tools if set to "auto"
  if (toolsToRun.length === 1 && toolsToRun[0] === 'auto') {
    toolsToRun = await detectTools(repoPath);
    core.info(`Auto-detected quality tools: ${toolsToRun.join(', ')}`);
  }
  
  const allIssues: QualityIssue[] = [];
  const allMetrics: { [tool: string]: { [metric: string]: number | string } } = {};
  
  // Run each tool
  for (const tool of toolsToRun) {
    core.info(`Running quality tool: ${tool}`);
    
    let result: ToolResult = { issues: [] };
    
    switch (tool.toLowerCase()) {
      case 'eslint':
        result = await runEslint(repoPath, changedFiles);
        break;
      case 'pylint':
        result = await runPylint(repoPath, changedFiles);
        break;
      // Add more tools as needed
      default:
        core.warning(`Unknown quality tool: ${tool}`);
        continue;
    }
    
    allIssues.push(...result.issues);
    if (result.metrics) {
      allMetrics[tool] = result.metrics;
    }
  }
  
  return { issues: allIssues, metrics: allMetrics };
}

// Format quality metrics as markdown
export function formatQualityMetricsMarkdown(
  metrics: { [tool: string]: { [metric: string]: number | string } }
): string {
  let markdown = '## 📊 Code Quality Metrics\n\n';
  
  if (Object.keys(metrics).length === 0) {
    return markdown + 'No quality metrics collected.\n';
  }
  
  for (const [tool, toolMetrics] of Object.entries(metrics)) {
    markdown += `### ${tool.toUpperCase()}\n\n`;
    markdown += '| Metric | Value |\n';
    markdown += '| ------ | ----- |\n';
    
    for (const [metric, value] of Object.entries(toolMetrics)) {
      // Format metric name for better readability
      const formattedMetric = metric
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, str => str.toUpperCase())
        .replace(/([a-z])([A-Z])/g, '$1 $2');
      
      markdown += `| ${formattedMetric} | ${value} |\n`;
    }
    
    markdown += '\n';
  }
  
  return markdown;
} 