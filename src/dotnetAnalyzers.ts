import { exec } from 'child_process';
import * as util from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as core from '@actions/core';

const execPromise = util.promisify(exec);

interface DotNetQualityIssue {
  path: string;
  line: number;
  message: string;
  rule: string;
  severity: 'critical' | 'warning' | 'suggestion';
  source: string; // Which analyzer found this issue
}

interface DotNetToolResult {
  issues: DotNetQualityIssue[];
  metrics?: {
    [key: string]: number | string;
  };
}

// Configuration interfaces
interface StyleCopConfig {
  settings?: string; // Path to stylecop.json
  treatWarningsAsErrors?: boolean;
}

interface RoslynConfig {
  editorConfigPath?: string;
  additionalAnalyzers?: string[]; // Additional analyzer packages to install
  treatWarningsAsErrors?: boolean;
}

interface ReSharperConfig {
  solutionPath: string;
  dotsettingsPath?: string;
}

// Helper function to ensure .NET SDK is available
async function ensureDotNetSdk(): Promise<boolean> {
  try {
    const { stdout } = await execPromise('dotnet --version');
    core.info(`Found .NET SDK version: ${stdout.trim()}`);
    return true;
  } catch (error) {
    core.error('Error: .NET SDK is not installed or not in PATH');
    return false;
  }
}

// Helper function to find solution file
async function findSolutionFile(repoPath: string): Promise<string | null> {
  try {
    const files = fs.readdirSync(repoPath);
    const slnFile = files.find(file => file.endsWith('.sln'));
    return slnFile ? path.join(repoPath, slnFile) : null;
  } catch (error) {
    core.error(`Error finding solution file: ${error}`);
    return null;
  }
}

// Install Roslyn analyzers
async function installRoslynAnalyzers(repoPath: string, analyzers: string[] = []): Promise<void> {
  const defaultAnalyzers = [
    'Microsoft.CodeAnalysis.NetAnalyzers',
    'Microsoft.CodeAnalysis.CSharp.CodeStyle',
    'Microsoft.CodeQuality.Analyzers',
    'Microsoft.NetCore.Analyzers',
    'Roslynator.Analyzers',
    'SecurityCodeScan.VS2019'
  ];

  const allAnalyzers = [...new Set([...defaultAnalyzers, ...analyzers])];

  for (const analyzer of allAnalyzers) {
    try {
      core.info(`Installing analyzer: ${analyzer}`);
      await execPromise(`dotnet add package ${analyzer} -v quiet`, { cwd: repoPath });
    } catch (error) {
      core.warning(`Failed to install analyzer ${analyzer}: ${error}`);
    }
  }
}

// Create default .editorconfig if it doesn't exist
async function ensureEditorConfig(repoPath: string, configPath?: string): Promise<string> {
  const defaultConfig = configPath || path.join(repoPath, '.editorconfig');

  if (!fs.existsSync(defaultConfig)) {
    const defaultContent = `root = true

[*.{cs,vb}]
dotnet_analyzer_diagnostic.severity = warning

# Code style defaults
dotnet_sort_system_directives_first = true
dotnet_style_qualification_for_field = false:suggestion
dotnet_style_qualification_for_property = false:suggestion
dotnet_style_qualification_for_method = false:suggestion
dotnet_style_qualification_for_event = false:suggestion

# Language keywords vs BCL types preferences
dotnet_style_predefined_type_for_locals_parameters_members = true:suggestion
dotnet_style_predefined_type_for_member_access = true:suggestion

# Parentheses preferences
dotnet_style_parentheses_in_arithmetic_binary_operators = always_for_clarity:suggestion
dotnet_style_parentheses_in_other_binary_operators = always_for_clarity:suggestion
dotnet_style_parentheses_in_other_operators = never_if_unnecessary:suggestion
dotnet_style_parentheses_in_relational_binary_operators = always_for_clarity:suggestion

# Modifier preferences
dotnet_style_require_accessibility_modifiers = for_non_interface_members:suggestion

[*.cs]
# var preferences
csharp_style_var_elsewhere = true:suggestion
csharp_style_var_for_built_in_types = true:suggestion
csharp_style_var_when_type_is_apparent = true:suggestion

# Expression-bodied members
csharp_style_expression_bodied_accessors = true:suggestion
csharp_style_expression_bodied_constructors = false:suggestion
csharp_style_expression_bodied_methods = false:suggestion
csharp_style_expression_bodied_properties = true:suggestion

# Pattern matching preferences
csharp_style_pattern_matching_over_as_with_null_check = true:suggestion
csharp_style_pattern_matching_over_is_with_cast_check = true:suggestion
csharp_style_prefer_switch_expression = true:suggestion

# Null-checking preferences
csharp_style_conditional_delegate_call = true:suggestion

# Code-block preferences
csharp_prefer_braces = true:suggestion`;

    fs.writeFileSync(defaultConfig, defaultContent);
    core.info(`Created default .editorconfig at ${defaultConfig}`);
  }

  return defaultConfig;
}

// Helper function to check if .NET project exists
async function hasNetProject(repoPath: string): Promise<boolean> {
  try {
    const files = fs.readdirSync(repoPath);
    return files.some(file => file.endsWith('.csproj') || file.endsWith('.sln'));
  } catch (error) {
    core.error(`Error checking for .NET project: ${error}`);
    return false;
  }
}

// Helper function to find project directory
async function findProjectDirectory(repoPath: string): Promise<string | null> {
  try {
    const projectFile = fs.readdirSync(repoPath)
      .find(file => file.endsWith('.csproj') || file.endsWith('.sln'));
    return projectFile ? path.dirname(path.join(repoPath, projectFile)) : null;
  } catch (error) {
    core.error(`Error finding project directory: ${error}`);
    return null;
  }
}

// Run Roslyn analysis
async function runRoslynAnalysis(
  repoPath: string,
  filePaths: string[],
  config?: RoslynConfig
): Promise<DotNetToolResult> {
  try {
    // Ensure .NET SDK is available
    if (!await ensureDotNetSdk()) {
      return { issues: [] };
    }

    // Check for .NET project
    if (!await hasNetProject(repoPath)) {
      core.warning('No .NET project found. Skipping Roslyn analysis.');
      return { issues: [] };
    }

    // Find project directory
    const projectDir = await findProjectDirectory(repoPath);
    if (!projectDir) {
      core.warning('Could not find project directory. Skipping Roslyn analysis.');
      return { issues: [] };
    }

    // Filter for C# files
    const csFiles = filePaths.filter(file => file.endsWith('.cs'));
    if (csFiles.length === 0) {
      return { issues: [] };
    }

    // Install analyzers
    await installRoslynAnalyzers(repoPath, config?.additionalAnalyzers);

    // Ensure .editorconfig exists
    const editorConfigPath = await ensureEditorConfig(repoPath, config?.editorConfigPath);

    // Build command with analysis options
    const buildCommand = [
      'dotnet build',
      '/p:GenerateFullPaths=true',
      config?.treatWarningsAsErrors ? '/warnaserror' : '/warnaserror-',
      '/v:detailed',
      `/p:AnalysisLevel=latest`,
      `/p:EnforceCodeStyleInBuild=true`,
      `/p:RunAnalyzersDuringBuild=true`,
      `/p:RunAnalyzersDuringLiveAnalysis=true`,
      `/p:TreatWarningsAsErrors=${config?.treatWarningsAsErrors || 'false'}`
    ].filter(Boolean).join(' ');

    // Run analysis
    const { stdout, stderr } = await execPromise(buildCommand, { cwd: repoPath });
    const output = stdout + '\n' + stderr;

    // Parse diagnostics
    const issues: DotNetQualityIssue[] = [];
    const diagnosticRegex = /^(.*?)\((\d+),\d+\):\s+(warning|error)\s+(\w+\d+):\s+(.*)$/gm;
    
    let match;
    while ((match = diagnosticRegex.exec(output)) !== null) {
      const [, filePath, line, level, ruleId, message] = match;
      const relativePath = path.relative(repoPath, filePath);

      issues.push({
        path: relativePath,
        line: parseInt(line, 10),
        message: message.trim(),
        rule: ruleId,
        severity: level === 'error' ? 'critical' : 'warning',
        source: 'roslyn'
      });
    }

    // Calculate metrics
    const metrics = {
      totalIssues: issues.length,
      criticalIssues: issues.filter(i => i.severity === 'critical').length,
      warningIssues: issues.filter(i => i.severity === 'warning').length,
      filesWithIssues: new Set(issues.map(i => i.path)).size,
      ruleCategories: new Set(issues.map(i => i.rule.split('.')[0])).size,
      topIssuesJson: JSON.stringify(Object.entries(
        issues.reduce((acc, issue) => {
          acc[issue.rule] = (acc[issue.rule] || 0) + 1;
          return acc;
        }, {} as Record<string, number>)
      )
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .reduce((acc, [rule, count]) => ({ ...acc, [rule]: count }), {}))
    };

    return { issues, metrics };
  } catch (error) {
    core.error(`Error running Roslyn analysis: ${error}`);
    return { issues: [] };
  }
}

// Run StyleCop analysis
async function runStyleCopAnalysis(
  repoPath: string,
  filePaths: string[],
  config?: StyleCopConfig
): Promise<DotNetToolResult> {
  try {
    // Ensure .NET SDK is available
    if (!await ensureDotNetSdk()) {
      return { issues: [] };
    }

    // Check for .NET project
    if (!await hasNetProject(repoPath)) {
      core.warning('No .NET project found. Skipping StyleCop analysis.');
      return { issues: [] };
    }

    // Find project directory
    const projectDir = await findProjectDirectory(repoPath);
    if (!projectDir) {
      core.warning('Could not find project directory. Skipping StyleCop analysis.');
      return { issues: [] };
    }

    // Filter for C# files
    const csFiles = filePaths.filter(file => file.endsWith('.cs'));
    if (csFiles.length === 0) {
      return { issues: [] };
    }

    // Install StyleCop.Analyzers
    try {
      await execPromise('dotnet add package StyleCop.Analyzers -v quiet', { cwd: repoPath });
      core.info('Installed StyleCop.Analyzers');
    } catch (error) {
      core.error(`Failed to install StyleCop.Analyzers: ${error}`);
      return { issues: [] };
    }

    // Create default stylecop.json if it doesn't exist and no custom config is provided
    const styleCopJsonPath = config?.settings || path.join(repoPath, 'stylecop.json');
    if (!fs.existsSync(styleCopJsonPath) && !config?.settings) {
      const defaultStyleCopConfig = {
        "$schema": "https://raw.githubusercontent.com/DotNetAnalyzers/StyleCopAnalyzers/master/StyleCop.Analyzers/StyleCop.Analyzers/Settings/stylecop.schema.json",
        "settings": {
          "documentationRules": {
            "companyName": "YourCompany",
            "documentInterfaces": true,
            "documentInternalElements": false
          },
          "layoutRules": {
            "newlineAtEndOfFile": "require"
          },
          "orderingRules": {
            "systemUsingDirectivesFirst": true,
            "usingDirectivesPlacement": "outsideNamespace"
          }
        }
      };

      fs.writeFileSync(styleCopJsonPath, JSON.stringify(defaultStyleCopConfig, null, 2));
      core.info(`Created default stylecop.json at ${styleCopJsonPath}`);
    }

    // Build command with StyleCop options
    const buildCommand = [
      'dotnet build',
      '/p:GenerateFullPaths=true',
      config?.treatWarningsAsErrors ? '/warnaserror' : '/warnaserror-',
      '/v:detailed',
      `/p:StyleCopEnabled=true`,
      `/p:StyleCopTreatErrorsAsWarnings=${!config?.treatWarningsAsErrors}`,
      config?.settings ? `/p:StyleCopSettingsFile=${config.settings}` : ''
    ].filter(Boolean).join(' ');

    // Run analysis
    const { stdout, stderr } = await execPromise(buildCommand, { cwd: repoPath });
    const output = stdout + '\n' + stderr;

    // Parse StyleCop diagnostics
    const issues: DotNetQualityIssue[] = [];
    const diagnosticRegex = /^(.*?)\((\d+),\d+\):\s+(warning|error)\s+(SA\d+):\s+(.*)$/gm;
    
    let match;
    while ((match = diagnosticRegex.exec(output)) !== null) {
      const [, filePath, line, level, ruleId, message] = match;
      const relativePath = path.relative(repoPath, filePath);

      issues.push({
        path: relativePath,
        line: parseInt(line, 10),
        message: message.trim(),
        rule: ruleId,
        severity: level === 'error' ? 'critical' : 'warning',
        source: 'stylecop'
      });
    }

    // Calculate metrics
    const metrics = {
      totalIssues: issues.length,
      criticalIssues: issues.filter(i => i.severity === 'critical').length,
      warningIssues: issues.filter(i => i.severity === 'warning').length,
      filesWithIssues: new Set(issues.map(i => i.path)).size,
      ruleCategories: new Set(issues.map(i => i.rule.substring(0, 4))).size,
      topIssuesJson: JSON.stringify(Object.entries(
        issues.reduce((acc, issue) => {
          acc[issue.rule] = (acc[issue.rule] || 0) + 1;
          return acc;
        }, {} as Record<string, number>)
      )
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .reduce((acc, [rule, count]) => ({ ...acc, [rule]: count }), {}))
    };

    return { issues, metrics };
  } catch (error) {
    core.error(`Error running StyleCop analysis: ${error}`);
    return { issues: [] };
  }
}

// Run ReSharper CLI analysis
async function runReSharperAnalysis(
  repoPath: string,
  filePaths: string[],
  config: ReSharperConfig
): Promise<DotNetToolResult> {
  try {
    // Ensure .NET SDK is available
    if (!await ensureDotNetSdk()) {
      return { issues: [] };
    }

    // Check for .NET project
    if (!await hasNetProject(repoPath)) {
      core.warning('No .NET project found. Skipping ReSharper analysis.');
      return { issues: [] };
    }

    // Find project directory
    const projectDir = await findProjectDirectory(repoPath);
    if (!projectDir) {
      core.warning('Could not find project directory. Skipping ReSharper analysis.');
      return { issues: [] };
    }

    // Filter for C# files
    const csFiles = filePaths.filter(file => file.endsWith('.cs'));
    if (csFiles.length === 0) {
      return { issues: [] };
    }

    // Install ReSharper CLI tools
    try {
      await execPromise('dotnet tool install -g JetBrains.ReSharper.GlobalTools', { cwd: repoPath });
      core.info('Installed ReSharper CLI tools');
    } catch (error) {
      // Tool might already be installed
      core.info('ReSharper CLI tools already installed or installation failed');
    }

    // Ensure solution file exists
    const solutionPath = config.solutionPath || await findSolutionFile(repoPath);
    if (!solutionPath) {
      core.error('No solution file found');
      return { issues: [] };
    }

    // Create output directory for inspection results
    const outputDir = path.join(repoPath, 'inspectcode-output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    }
    const outputPath = path.join(outputDir, 'inspection-results.xml');

    // Build inspection command
    const inspectCommand = [
      'jb inspectcode',
      `"${solutionPath}"`,
      '--output=' + outputPath,
      '--format=Xml',
      '--verbosity=WARN',
      config.dotsettingsPath ? `--settings="${config.dotsettingsPath}"` : '',
      '--no-build',  // Skip build as we'll build separately
      '--absolute-paths'
    ].filter(Boolean).join(' ');

    // Build the solution first
    await execPromise('dotnet build', { cwd: repoPath });
    core.info('Project built successfully');

    // Run inspection
    await execPromise(inspectCommand, { cwd: repoPath });
    core.info('ReSharper inspection completed');

    // Parse inspection results
    const issues: DotNetQualityIssue[] = [];
    if (fs.existsSync(outputPath)) {
      const inspectionXml = fs.readFileSync(outputPath, 'utf8');
      
      // Parse XML (simplified for example)
      // In a real implementation, you'd use a proper XML parser
      const issueMatches = inspectionXml.matchAll(/<Issue.*?TypeId="([^"]+)".*?File="([^"]+)".*?Line="(\d+)".*?Message="([^"]+)".*?Severity="([^"]+)"/g);
      
      for (const match of issueMatches) {
        const [, ruleId, filePath, line, message, severity] = match;
        const relativePath = path.relative(repoPath, filePath);

        // Map ReSharper severity to our severity levels
        let mappedSeverity: 'critical' | 'warning' | 'suggestion';
        switch (severity.toLowerCase()) {
          case 'error':
            mappedSeverity = 'critical';
            break;
          case 'warning':
            mappedSeverity = 'warning';
            break;
          default:
            mappedSeverity = 'suggestion';
        }

        issues.push({
          path: relativePath,
          line: parseInt(line, 10),
          message: message,
          rule: ruleId,
          severity: mappedSeverity,
          source: 'resharper'
        });
      }
    }

    // Calculate metrics
    const metrics = {
      totalIssues: issues.length,
      criticalIssues: issues.filter(i => i.severity === 'critical').length,
      warningIssues: issues.filter(i => i.severity === 'warning').length,
      suggestionIssues: issues.filter(i => i.severity === 'suggestion').length,
      filesWithIssues: new Set(issues.map(i => i.path)).size,
      ruleCategories: new Set(issues.map(i => i.rule.split('.')[0])).size,
      topIssuesJson: JSON.stringify(Object.entries(
        issues.reduce((acc, issue) => {
          acc[issue.rule] = (acc[issue.rule] || 0) + 1;
          return acc;
        }, {} as Record<string, number>)
      )
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .reduce((acc, [rule, count]) => ({ ...acc, [rule]: count }), {}))
    };

    // Cleanup
    try {
      fs.unlinkSync(outputPath);
      fs.rmdirSync(outputDir);
    } catch (error) {
      core.warning(`Failed to cleanup ReSharper output: ${error}`);
    }

    return { issues, metrics };
  } catch (error) {
    core.error(`Error running ReSharper analysis: ${error}`);
    return { issues: [] };
  }
}

// Export the interfaces and functions
export {
  DotNetQualityIssue,
  DotNetToolResult,
  StyleCopConfig,
  RoslynConfig,
  ReSharperConfig,
  ensureDotNetSdk,
  findSolutionFile,
  installRoslynAnalyzers,
  ensureEditorConfig,
  runRoslynAnalysis,
  runStyleCopAnalysis,
  runReSharperAnalysis
}; 