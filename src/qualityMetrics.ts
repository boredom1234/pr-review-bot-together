import { exec } from "child_process";
import * as util from "util";
import * as fs from "fs";
import * as path from "path";
import * as core from "@actions/core";
import minimatch from "minimatch";

const execPromise = util.promisify(exec);

interface QualityIssue {
  path: string;
  line: number;
  message: string;
  rule: string;
  severity: "critical" | "warning" | "suggestion";
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
    const hasJsFiles = fs.existsSync(path.join(repoPath, "package.json"));
    if (hasJsFiles) {
      // Check if ESLint is configured
      if (
        fs.existsSync(path.join(repoPath, ".eslintrc.js")) ||
        fs.existsSync(path.join(repoPath, ".eslintrc.json")) ||
        fs.existsSync(path.join(repoPath, ".eslintrc.yml"))
      ) {
        tools.push("eslint");
      }
    }
  } catch (error) {
    console.error("Error detecting JS tools:", error);
  }

  // Check for Python files
  try {
    const hasPyFiles = fs
      .readdirSync(repoPath)
      .some((file) => file.endsWith(".py"));
    if (hasPyFiles) {
      tools.push("pylint");
    }
  } catch (error) {
    console.error("Error detecting Python tools:", error);
  }

  // Check for Go files
  try {
    const hasGoFiles = fs
      .readdirSync(repoPath)
      .some((file) => file.endsWith(".go"));
    if (hasGoFiles) {
      tools.push("golint");
    }
  } catch (error) {
    console.error("Error detecting Go tools:", error);
  }

  // Check for Java files
  try {
    const hasJavaFiles = fs
      .readdirSync(repoPath)
      .some((file) => file.endsWith(".java"));
    if (hasJavaFiles) {
      tools.push("checkstyle");
    }
  } catch (error) {
    console.error("Error detecting Java tools:", error);
  }

  // Check for Ruby files
  try {
    const hasRubyFiles = fs
      .readdirSync(repoPath)
      .some((file) => file.endsWith(".rb"));
    if (hasRubyFiles) {
      tools.push("rubocop");
    }
  } catch (error) {
    console.error("Error detecting Ruby tools:", error);
  }

  // Check for Rust files
  try {
    const hasRustFiles = fs
      .readdirSync(repoPath)
      .some((file) => file.endsWith(".rs"));
    if (hasRustFiles) {
      tools.push("clippy");
    }
  } catch (error) {
    console.error("Error detecting Rust tools:", error);
  }

  return tools;
}

// Run ESLint analysis
async function runEslint(
  repoPath: string,
  filePaths: string[],
  configPath: string | null
): Promise<ToolResult> {
  try {
    // Install ESLint if not already installed
    await execPromise("npm install eslint --no-save", { cwd: repoPath });

    // Filter for JS/TS files
    const jsFiles = filePaths.filter(
      (file) =>
        file.endsWith(".js") ||
        file.endsWith(".jsx") ||
        file.endsWith(".ts") ||
        file.endsWith(".tsx")
    );

    if (jsFiles.length === 0) {
      return { issues: [] };
    }

    // Run ESLint with JSON reporter
    let eslintCommand = `npx eslint ${jsFiles.join(" ")} --format json`;

    // Add custom config if provided
    if (configPath) {
      eslintCommand += ` -c ${configPath}`;
    }

    const { stdout } = await execPromise(eslintCommand, { cwd: repoPath });

    const eslintResults = JSON.parse(stdout);

    // Transform ESLint results to our format
    const issues: QualityIssue[] = [];

    eslintResults.forEach((result: any) => {
      result.messages.forEach((msg: any) => {
        issues.push({
          path: result.filePath.replace(`${repoPath}/`, ""),
          line: msg.line,
          message: msg.message,
          rule: msg.ruleId || "unknown",
          severity:
            msg.severity === 2
              ? "critical"
              : msg.severity === 1
              ? "warning"
              : "suggestion",
        });
      });
    });

    // Calculate metrics
    const metrics = {
      totalIssues: issues.length,
      criticalIssues: issues.filter((i) => i.severity === "critical").length,
      warningIssues: issues.filter((i) => i.severity === "warning").length,
      filesWithIssues: new Set(issues.map((i) => i.path)).size,
    };

    return { issues, metrics };
  } catch (error) {
    console.error("Error running ESLint:", error);
    return { issues: [] };
  }
}

// Run Pylint analysis
async function runPylint(
  repoPath: string,
  filePaths: string[],
  configPath: string | null
): Promise<ToolResult> {
  try {
    // Install Pylint if not already installed
    await execPromise("pip install pylint", { cwd: repoPath });

    // Filter for Python files
    const pyFiles = filePaths.filter((file) => file.endsWith(".py"));

    if (pyFiles.length === 0) {
      return { issues: [] };
    }

    // Run Pylint with JSON reporter
    let pylintCommand = `pylint --output-format=json`;

    // Add custom config if provided
    if (configPath) {
      pylintCommand += ` --rcfile=${configPath}`;
    }

    pylintCommand += ` ${pyFiles.join(" ")}`;

    const { stdout } = await execPromise(pylintCommand, { cwd: repoPath });

    const pylintResults = JSON.parse(stdout);

    // Transform Pylint results to our format
    const issues: QualityIssue[] = [];

    pylintResults.forEach((result: any) => {
      // Map Pylint severity to our severity levels
      let severity: "critical" | "warning" | "suggestion";
      if (result.type === "error") {
        severity = "critical";
      } else if (result.type === "warning") {
        severity = "warning";
      } else {
        severity = "suggestion";
      }

      issues.push({
        path: result.path,
        line: result.line,
        message: result.message,
        rule: result.symbol,
        severity,
      });
    });

    // Calculate metrics
    const metrics = {
      totalIssues: issues.length,
      criticalIssues: issues.filter((i) => i.severity === "critical").length,
      warningIssues: issues.filter((i) => i.severity === "warning").length,
      filesWithIssues: new Set(issues.map((i) => i.path)).size,
    };

    return { issues, metrics };
  } catch (error) {
    console.error("Error running Pylint:", error);
    return { issues: [] };
  }
}

// Run Golint analysis
async function runGolint(
  repoPath: string,
  filePaths: string[],
  configPath: string | null
): Promise<ToolResult> {
  try {
    // Install golint if not already installed
    await execPromise("go install golang.org/x/lint/golint@latest", {
      cwd: repoPath,
    });

    // Filter for Go files
    const goFiles = filePaths.filter((file) => file.endsWith(".go"));

    if (goFiles.length === 0) {
      return { issues: [] };
    }

    // Run golint
    const { stdout } = await execPromise(`golint -json ${goFiles.join(" ")}`, {
      cwd: repoPath,
    });

    // Parse the output (assuming JSON format)
    const golintResults = stdout.trim()
      ? JSON.parse(`[${stdout.trim().split("\n").join(",")}]`)
      : [];

    // Transform golint results to our format
    const issues: QualityIssue[] = [];

    golintResults.forEach((result: any) => {
      issues.push({
        path: result.file,
        line: result.line,
        message: result.message,
        rule: "golint",
        severity: "warning", // Golint doesn't have severity levels, default to warning
      });
    });

    // Calculate metrics
    const metrics = {
      totalIssues: issues.length,
      criticalIssues: issues.filter((i) => i.severity === "critical").length,
      warningIssues: issues.filter((i) => i.severity === "warning").length,
      filesWithIssues: new Set(issues.map((i) => i.path)).size,
    };

    return { issues, metrics };
  } catch (error) {
    console.error("Error running Golint:", error);
    return { issues: [] };
  }
}

// Run Checkstyle analysis for Java
async function runCheckstyle(
  repoPath: string,
  filePaths: string[],
  configPath: string | null
): Promise<ToolResult> {
  try {
    // Filter for Java files
    const javaFiles = filePaths.filter((file) => file.endsWith(".java"));

    if (javaFiles.length === 0) {
      return { issues: [] };
    }

    // Download checkstyle jar if not exists
    const checkstyleJar = path.join(repoPath, "checkstyle.jar");
    if (!fs.existsSync(checkstyleJar)) {
      await execPromise(
        "curl -L -o checkstyle.jar https://github.com/checkstyle/checkstyle/releases/download/checkstyle-10.3.3/checkstyle-10.3.3-all.jar",
        { cwd: repoPath }
      );
    }

    // Run checkstyle with XML output
    const { stdout } = await execPromise(
      `java -jar checkstyle.jar -c /google_checks.xml -f xml ${javaFiles.join(
        " "
      )}`,
      { cwd: repoPath }
    );

    // Parse XML output
    const issues: QualityIssue[] = [];

    // Simple XML parsing (in a real implementation, use a proper XML parser)
    const fileMatches = stdout.matchAll(/<file name="([^"]+)">/g);
    for (const fileMatch of fileMatches) {
      const filePath = fileMatch[1].replace(`${repoPath}/`, "");
      const fileSection = stdout
        .split(`<file name="${fileMatch[1]}">`)[1]
        .split("</file>")[0];

      const errorMatches = fileSection.matchAll(
        /<error line="(\d+)" [^>]*severity="([^"]+)" [^>]*message="([^"]+)"([^>]*)\/>/g
      );
      for (const errorMatch of errorMatches) {
        const line = parseInt(errorMatch[1]);
        const checkstyleSeverity = errorMatch[2];
        const message = errorMatch[3];

        // Map checkstyle severity to our severity levels
        let severity: "critical" | "warning" | "suggestion";
        if (checkstyleSeverity === "error") {
          severity = "critical";
        } else if (checkstyleSeverity === "warning") {
          severity = "warning";
        } else {
          severity = "suggestion";
        }

        issues.push({
          path: filePath,
          line,
          message,
          rule: "checkstyle",
          severity,
        });
      }
    }

    // Calculate metrics
    const metrics = {
      totalIssues: issues.length,
      criticalIssues: issues.filter((i) => i.severity === "critical").length,
      warningIssues: issues.filter((i) => i.severity === "warning").length,
      filesWithIssues: new Set(issues.map((i) => i.path)).size,
    };

    return { issues, metrics };
  } catch (error) {
    console.error("Error running Checkstyle:", error);
    return { issues: [] };
  }
}

// Run RuboCop analysis for Ruby
async function runRubocop(
  repoPath: string,
  filePaths: string[],
  configPath: string | null
): Promise<ToolResult> {
  try {
    // Install RuboCop if not already installed
    await execPromise("sudo gem install rubocop", { cwd: repoPath });

    // Filter for Ruby files
    const rubyFiles = filePaths.filter((file) => file.endsWith(".rb"));

    if (rubyFiles.length === 0) {
      return { issues: [] };
    }

    // Run RuboCop with JSON formatter
    const { stdout } = await execPromise(
      `rubocop --format json ${rubyFiles.join(" ")}`,
      { cwd: repoPath }
    );

    const rubocopResults = JSON.parse(stdout);

    // Transform RuboCop results to our format
    const issues: QualityIssue[] = [];

    rubocopResults.files.forEach((file: any) => {
      const filePath = file.path.replace(`${repoPath}/`, "");

      file.offenses.forEach((offense: any) => {
        // Map RuboCop severity to our severity levels
        let severity: "critical" | "warning" | "suggestion";
        if (offense.severity === "error" || offense.severity === "fatal") {
          severity = "critical";
        } else if (offense.severity === "warning") {
          severity = "warning";
        } else {
          severity = "suggestion";
        }

        issues.push({
          path: filePath,
          line: offense.location.line,
          message: offense.message,
          rule: offense.cop_name,
          severity,
        });
      });
    });

    // Calculate metrics
    const metrics = {
      totalIssues: issues.length,
      criticalIssues: issues.filter((i) => i.severity === "critical").length,
      warningIssues: issues.filter((i) => i.severity === "warning").length,
      filesWithIssues: new Set(issues.map((i) => i.path)).size,
    };

    return { issues, metrics };
  } catch (error) {
    console.error("Error running RuboCop:", error);
    return { issues: [] };
  }
}

// Run Clippy analysis for Rust
async function runClippy(
  repoPath: string,
  filePaths: string[],
  configPath: string | null
): Promise<ToolResult> {
  try {
    // Filter for Rust files
    const rustFiles = filePaths.filter((file) => file.endsWith(".rs"));

    if (rustFiles.length === 0) {
      return { issues: [] };
    }

    // Run Clippy with JSON message format
    const { stdout } = await execPromise(`cargo clippy --message-format=json`, {
      cwd: repoPath,
    });

    // Parse the JSON lines output
    const issues: QualityIssue[] = [];

    stdout
      .split("\n")
      .filter(Boolean)
      .forEach((line: string) => {
        try {
          const result = JSON.parse(line);

          if (
            result.reason === "compiler-message" &&
            result.message &&
            result.message.spans
          ) {
            // Only process diagnostic messages with spans
            const primarySpan = result.message.spans.find(
              (span: any) => span.is_primary
            );

            if (primarySpan) {
              // Map Clippy level to our severity levels
              let severity: "critical" | "warning" | "suggestion";
              if (result.message.level === "error") {
                severity = "critical";
              } else if (result.message.level === "warning") {
                severity = "warning";
              } else {
                severity = "suggestion";
              }

              issues.push({
                path: primarySpan.file_name.replace(`${repoPath}/`, ""),
                line: primarySpan.line_start,
                message: result.message.message,
                rule: result.message.code ? result.message.code.code : "clippy",
                severity,
              });
            }
          }
        } catch (e) {
          // Skip lines that aren't valid JSON
        }
      });

    // Calculate metrics
    const metrics = {
      totalIssues: issues.length,
      criticalIssues: issues.filter((i) => i.severity === "critical").length,
      warningIssues: issues.filter((i) => i.severity === "warning").length,
      filesWithIssues: new Set(issues.map((i) => i.path)).size,
    };

    return { issues, metrics };
  } catch (error) {
    console.error("Error running Clippy:", error);
    return { issues: [] };
  }
}

// Main function to run quality metrics
export async function runQualityMetrics(
  repoPath: string,
  changedFiles: string[]
): Promise<{
  issues: QualityIssue[];
  metrics: { [tool: string]: { [metric: string]: number | string } };
}> {
  const enableMetrics = core.getInput("enable_quality_metrics") === "true";
  if (!enableMetrics) {
    return { issues: [], metrics: {} };
  }

  let toolsToRun = core
    .getInput("quality_tools")
    .split(",")
    .map((t) => t.trim());

  // Auto-detect tools if set to "auto"
  if (toolsToRun.length === 1 && toolsToRun[0] === "auto") {
    toolsToRun = await detectTools(repoPath);
    core.info(`Auto-detected quality tools: ${toolsToRun.join(", ")}`);
  }

  // Parse custom config paths
  let customConfigPaths: { [tool: string]: string } = {};
  try {
    const configPathsInput = core.getInput("quality_config_paths");
    if (configPathsInput) {
      customConfigPaths = JSON.parse(configPathsInput);
      core.info(
        `Using custom config paths: ${JSON.stringify(customConfigPaths)}`
      );
    }
  } catch (error) {
    core.warning(`Failed to parse quality_config_paths: ${error}`);
  }

  // Parse rules to ignore
  let ignoreRules: { [tool: string]: string[] } = {};
  try {
    const ignoreRulesInput = core.getInput("ignore_rules");
    if (ignoreRulesInput) {
      ignoreRules = JSON.parse(ignoreRulesInput);
      core.info(`Ignoring rules: ${JSON.stringify(ignoreRules)}`);
    }
  } catch (error) {
    core.warning(`Failed to parse ignore_rules: ${error}`);
  }

  // Parse additional files to ignore
  const ignoreFilesPatterns: string[] = [];
  const ignoreFilesInput = core.getInput("ignore_files");
  if (ignoreFilesInput) {
    ignoreFilesPatterns.push(
      ...ignoreFilesInput.split(",").map((p) => p.trim())
    );
    core.info(`Additional files to ignore: ${ignoreFilesPatterns.join(", ")}`);
  }

  // Filter out files that match ignore patterns
  const filteredFiles = changedFiles.filter((file) => {
    return !ignoreFilesPatterns.some((pattern) => minimatch(file, pattern));
  });

  if (filteredFiles.length < changedFiles.length) {
    core.info(
      `Filtered out ${
        changedFiles.length - filteredFiles.length
      } files based on ignore patterns`
    );
  }

  const allIssues: QualityIssue[] = [];
  const allMetrics: { [tool: string]: { [metric: string]: number | string } } =
    {};

  // Run each tool
  for (const tool of toolsToRun) {
    core.info(`Running quality tool: ${tool}`);

    let result: ToolResult = { issues: [] };
    const configPath = customConfigPaths[tool.toLowerCase()] || null;
    const rulesToIgnore = ignoreRules[tool.toLowerCase()] || [];

    switch (tool.toLowerCase()) {
      case "eslint":
        result = await runEslint(repoPath, filteredFiles, configPath);
        break;
      case "pylint":
        result = await runPylint(repoPath, filteredFiles, configPath);
        break;
      case "golint":
        result = await runGolint(repoPath, filteredFiles, configPath);
        break;
      case "checkstyle":
        result = await runCheckstyle(repoPath, filteredFiles, configPath);
        break;
      case "rubocop":
        result = await runRubocop(repoPath, filteredFiles, configPath);
        break;
      case "clippy":
        result = await runClippy(repoPath, filteredFiles, configPath);
        break;
      // Add more tools as needed
      default:
        core.warning(`Unknown quality tool: ${tool}`);
        continue;
    }

    // Filter out issues with rules that should be ignored
    if (rulesToIgnore.length > 0) {
      const originalIssueCount = result.issues.length;
      result.issues = result.issues.filter(
        (issue) => !rulesToIgnore.includes(issue.rule)
      );
      core.info(
        `Filtered out ${
          originalIssueCount - result.issues.length
        } issues based on ignored rules for ${tool}`
      );

      // Update metrics
      if (result.metrics) {
        result.metrics.totalIssues = result.issues.length;
        result.metrics.criticalIssues = result.issues.filter(
          (i) => i.severity === "critical"
        ).length;
        result.metrics.warningIssues = result.issues.filter(
          (i) => i.severity === "warning"
        ).length;
        result.metrics.filesWithIssues = new Set(
          result.issues.map((i) => i.path)
        ).size;
      }
    }

    allIssues.push(...result.issues);
    if (result.metrics) {
      allMetrics[tool] = result.metrics;
    }
  }

  return { issues: allIssues, metrics: allMetrics };
}

// Format quality metrics as markdown
export function formatQualityMetricsMarkdown(metrics: {
  [tool: string]: { [metric: string]: number | string };
}): string {
  let markdown = "## 📊 Code Quality Metrics\n\n";

  if (Object.keys(metrics).length === 0) {
    return markdown + "No quality metrics collected.\n";
  }

  for (const [tool, toolMetrics] of Object.entries(metrics)) {
    markdown += `### ${tool.toUpperCase()}\n\n`;
    markdown += "| Metric | Value |\n";
    markdown += "| ------ | ----- |\n";

    for (const [metric, value] of Object.entries(toolMetrics)) {
      // Format metric name for better readability
      const formattedMetric = metric
        .replace(/([A-Z])/g, " $1")
        .replace(/^./, (str) => str.toUpperCase())
        .replace(/([a-z])([A-Z])/g, "$1 $2");

      markdown += `| ${formattedMetric} | ${value} |\n`;
    }

    markdown += "\n";
  }

  return markdown;
}
