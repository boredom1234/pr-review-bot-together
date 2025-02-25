import { readFileSync } from "fs";
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import Together from "together-ai";
import path from "path";

// Add at the top of your file for local development
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const TOGETHER_API_KEY: string = core.getInput("TOGETHER_API_KEY");
const TOGETHER_API_MODEL: string = core.getInput("TOGETHER_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const together = new Together({
  apiKey: TOGETHER_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string | null> {
  try {
    const response = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    // Handle file content response
    if ("content" in response.data && !Array.isArray(response.data)) {
      return Buffer.from(response.data.content, "base64").toString("utf8");
    }
    return null;
  } catch (error) {
    console.error(`Error fetching file content: ${error}`);
    return null;
  }
}

interface DiffWithContext {
  diff: string;
  fileContexts: Map<string, string>;
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<DiffWithContext | null> {
  try {
    const response = await octokit.pulls.get({
      owner,
      repo,
      pull_number,
      mediaType: { format: "diff" },
    });

    // Get the PR details to access base and head SHAs
    const prDetails = await octokit.pulls.get({
      owner,
      repo,
      pull_number,
    });

    const fileContexts = new Map<string, string>();

    // Parse the diff to get file paths
    // @ts-expect-error - response.data is a string
    const parsedDiff = parseDiff(response.data);

    // Fetch full content for each modified file
    for (const file of parsedDiff) {
      if (file.to && file.to !== "/dev/null") {
        const fileContent = await getFileContent(
          owner,
          repo,
          file.to,
          prDetails.data.head.sha
        );
        if (fileContent) {
          fileContexts.set(file.to, fileContent);
        }
      }
    }

    return {
      // @ts-expect-error - response.data is a string
      diff: response.data,
      fileContexts,
    };
  } catch (error) {
    console.error(`Error fetching diff: ${error}`);
    return null;
  }
}

function validateFileExtension(
  filePath: string,
  fileContent: string
): ReviewComment | null {
  const extension = path.extname(filePath).toLowerCase();
  const content = fileContent.trim();

  // Common language indicators
  const indicators = {
    python: {
      extensions: [".py", ".pyw"],
      patterns: [
        /^from\s+[\w.]+\s+import\s+/m, // from ... import
        /^import\s+[\w.]+/m, // import statements
        /^def\s+\w+\s*\(/m, // function definitions
        /^class\s+\w+[:(]/m, // class definitions
        /:$/m, // python blocks
        /^\s*@\w+/m, // decorators
      ],
    },
    javascript: {
      extensions: [".js", ".jsx", ".mjs"],
      patterns: [
        /^const\s+\w+\s*=/m, // const declarations
        /^let\s+\w+\s*=/m, // let declarations
        /^var\s+\w+\s*=/m, // var declarations
        /^function\s+\w+\s*\(/m, // function declarations
        /=>\s*{/m, // arrow functions
        /^export\s+/m, // export statements
        /^import\s+.*from/m, // ES6 imports
      ],
    },
    typescript: {
      extensions: [".ts", ".tsx"],
      patterns: [
        /^interface\s+\w+\s*{/m, // interface declarations
        /^type\s+\w+\s*=/m, // type declarations
        /^enum\s+\w+\s*{/m, // enum declarations
        /:\s*\w+[\[\]]*\s*[=;]/m, // type annotations
      ],
    },
    golang: {
      extensions: [".go"],
      patterns: [
        /^package\s+\w+/m, // package declaration
        /^import\s+[\s\S]*?\)/m, // import blocks
        /^func\s+\w+\s*\(/m, // function declarations
        /^type\s+\w+\s+struct\s*{/m, // struct declarations
        /^type\s+\w+\s+interface\s*{/m, // interface declarations
        /:\=$/m, // short variable declarations
      ],
    },
    c: {
      extensions: [".c", ".h"],
      patterns: [
        /^#include\s+[<"]/m, // include statements
        /^#define\s+\w+/m, // macro definitions
        /^typedef\s+struct\s*{/m, // typedef struct
        /^void\s+\w+\s*\(/m, // void functions
        /^int\s+\w+\s*\(/m, // int functions
        /^char\s+\w+\s*\(/m, // char functions
      ],
    },
    cpp: {
      extensions: [".cpp", ".hpp", ".cc", ".hh", ".cxx", ".hxx"],
      patterns: [
        /^#include\s+[<"]/m, // include statements
        /^namespace\s+\w+\s*{/m, // namespace declarations
        /^class\s+\w+\s*[:{]/m, // class declarations
        /^template\s*<.*>/m, // template declarations
        /^std::/m, // std namespace usage
        /^public:|^private:|^protected:/m, // access specifiers
      ],
    },
    java: {
      extensions: [".java"],
      patterns: [
        /^package\s+[\w.]+;/m, // package declarations
        /^import\s+[\w.]+;/m, // import statements
        /^public\s+class\s+\w+/m, // public class
        /^private\s+\w+\s+\w+/m, // private fields
        /^protected\s+\w+\s+\w+/m, // protected fields
        /@Override/m, // annotations
      ],
    },
    rust: {
      extensions: [".rs"],
      patterns: [
        /^use\s+[\w:]+/m, // use statements
        /^fn\s+\w+/m, // function declarations
        /^pub\s+fn/m, // public functions
        /^struct\s+\w+/m, // struct declarations
        /^impl\s+\w+/m, // impl blocks
        /^mod\s+\w+/m, // module declarations
      ],
    },
    ruby: {
      extensions: [".rb", ".rake"],
      patterns: [
        /^require\s+[\'"]/m, // require statements
        /^class\s+\w+\s*(<\s*\w+)?/m, // class declarations
        /^def\s+\w+/m, // method definitions
        /^module\s+\w+/m, // module declarations
        /^attr_/m, // attribute macros
        /^private$|^protected$/m, // access modifiers
      ],
    },
    swift: {
      extensions: [".swift"],
      patterns: [
        /^import\s+\w+/m, // import statements
        /^class\s+\w+/m, // class declarations
        /^struct\s+\w+/m, // struct declarations
        /^protocol\s+\w+/m, // protocol declarations
        /^extension\s+\w+/m, // extensions
        /^@objc/m, // objective-c interop
      ],
    },
    kotlin: {
      extensions: [".kt", ".kts"],
      patterns: [
        /^package\s+[\w.]+/m, // package declarations
        /^import\s+[\w.]+/m, // import statements
        /^fun\s+\w+/m, // function declarations
        /^class\s+\w+/m, // class declarations
        /^data\s+class/m, // data classes
        /^@\w+/m, // annotations
      ],
    },
    php: {
      extensions: [".php"],
      patterns: [
        /^<\?php/m, // PHP opening tag
        /^namespace\s+[\w\\]+;/m, // namespace declarations
        /^use\s+[\w\\]+;/m, // use statements
        /^class\s+\w+/m, // class declarations
        /^public\s+function/m, // public methods
        /^\$\w+\s*=/m, // variable assignments
      ],
    },
  };

  // Detect the likely language based on content
  let detectedLanguage = null;
  let maxMatches = 0;

  for (const [lang, config] of Object.entries(indicators)) {
    const matches = config.patterns.reduce(
      (count, pattern) => count + (pattern.test(content) ? 1 : 0),
      0
    );
    if (matches > maxMatches) {
      maxMatches = matches;
      detectedLanguage = lang;
    }
  }

  if (!detectedLanguage || maxMatches < 2) {
    // Require at least 2 matches for confidence
    return null; // Can't determine the language with confidence
  }

  // Check if the file extension matches the detected language
  const validExtensions =
    indicators[detectedLanguage as keyof typeof indicators].extensions;
  if (!validExtensions.includes(extension)) {
    return {
      body: `⚠️ File extension mismatch: This appears to be ${detectedLanguage} code but has a '${extension}' extension. Consider renaming to '${validExtensions[0]}'`,
      path: filePath,
      line: 1,
      severity: "critical",
    };
  }

  return null;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails,
  fileContexts: Map<string, string>
): Promise<Array<ReviewComment>> {
  const comments: Array<ReviewComment> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files

    const fileContent = file.to ? fileContexts.get(file.to) ?? null : null;

    // Add extension validation
    if (file.to && fileContent) {
      const extensionError = validateFileExtension(file.to, fileContent);
      if (extensionError) {
        comments.push(extensionError);
      }
    }

    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails, fileContent);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

interface ReviewComment {
  body: string;
  path: string;
  line: number;
  severity: "critical" | "warning" | "suggestion";
}

interface GitHubComment {
  body: string;
  path: string;
  line: number;
}

function createPrompt(
  file: File,
  chunk: Chunk,
  prDetails: PRDetails,
  fileContent: string | null
): string {
  const fileExtension = file.to ? file.to.split(".").pop() || "" : "";
  const contextPrompt = fileContent
    ? `\nFull file content for context:\n\`\`\`${fileExtension}\n${fileContent}\n\`\`\`\n`
    : "";

  return `You are a strict code reviewer. Your task is to thoroughly analyze the code and find potential issues, bugs, and improvements. Instructions:

- Provide the response in following JSON format: {"reviews": [{"lineNumber": <line_number>, "reviewComment": "<review comment>", "severity": "<severity>"}]}
- Severity levels:
  - "critical": For issues that must be fixed (security issues, bugs, broken functionality, performance issues)
  - "warning": For code quality issues that should be addressed (maintainability, best practices, potential edge cases)
  - "suggestion": For optional improvements (readability, minor optimizations)
- Be thorough and strict in your review:
  - Look for security vulnerabilities
  - Check for potential bugs and edge cases
  - Identify performance issues
  - Verify error handling
  - Check for code quality and maintainability issues
- Do not give positive comments or compliments
- Always try to find at least one issue to improve the code
- Write the comment in GitHub Markdown format
- Consider the full file context when making suggestions

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---
${contextPrompt}
Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
  severity?: "critical" | "warning" | "suggestion";
}> | null> {
  const queryConfig = {
    model: TOGETHER_API_MODEL,
    temperature: 0.7,
    max_tokens: 8096,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0.1,
  };

  try {
    const response = await together.chat.completions.create({
      ...queryConfig,
      messages: [
        {
          role: "system",
          content:
            "You are a strict code reviewer who always finds potential issues and improvements. Be thorough and critical in your review. IMPORTANT: Your response must be valid JSON without any markdown formatting.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const res = response.choices[0].message?.content?.trim() || "{}";
    try {
      // Remove any markdown formatting that might be present
      const cleanJson = res
        .replace(/```[a-z]*\n/g, "")
        .replace(/```/g, "")
        .trim();
      const parsed = JSON.parse(cleanJson);
      if (!parsed.reviews || !Array.isArray(parsed.reviews)) {
        console.warn("Invalid response format from AI");
        return [];
      }
      return parsed.reviews;
    } catch (parseError) {
      console.error("Failed to parse AI response:", parseError);
      console.error("Raw response:", res);
      return [];
    }
  } catch (error) {
    console.error("Error getting AI response:", error);
    return [];
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
    severity?: "critical" | "warning" | "suggestion";
  }>
): Array<ReviewComment> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }

    // Convert lineNumber to number
    const lineNum = Number(aiResponse.lineNumber);

    // Check if the line number is within any of the changed chunks
    const isLineInDiff = chunk.changes.some((change) => {
      if ("add" === change.type) {
        return change.ln === lineNum;
      }
      if ("normal" === change.type) {
        return change.ln2 === lineNum;
      }
      return false;
    });

    if (!isLineInDiff) {
      // If the line is not in diff, try to find the closest changed line
      const changedLines = chunk.changes
        .filter((change) => change.type === "add" || change.type === "normal")
        .map((change) => {
          if (change.type === "add") return change.ln;
          if (change.type === "normal") return change.ln2;
          return undefined;
        })
        .filter((ln): ln is number => ln !== undefined)
        .sort((a, b) => a - b);

      if (changedLines.length === 0) {
        return [];
      }

      // Find the closest line number in the diff
      const closestLine = changedLines.reduce((prev, curr) =>
        Math.abs(curr - lineNum) < Math.abs(prev - lineNum) ? curr : prev
      );

      return [
        {
          body: `[Original comment was for line ${lineNum}]\n${aiResponse.reviewComment}`,
          path: file.to,
          line: closestLine,
          severity: aiResponse.severity || "warning",
        },
      ];
    }

    return [
      {
        body: aiResponse.reviewComment,
        path: file.to,
        line: lineNum,
        severity: aiResponse.severity || "warning",
      },
    ];
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<ReviewComment>
): Promise<void> {
  try {
    const criticalIssues = comments.filter(
      (c) => c.severity === "critical"
    ).length;
    const warnings = comments.filter((c) => c.severity === "warning").length;
    const suggestions = comments.filter(
      (c) => c.severity === "suggestion"
    ).length;

    // Never use APPROVE since GitHub Actions doesn't have permission for it
    const event =
      criticalIssues > 0 || warnings > 0 ? "REQUEST_CHANGES" : "COMMENT";

    // Group comments by file and severity
    const commentsByFile = new Map<string, Map<string, ReviewComment[]>>();

    comments.forEach((comment) => {
      if (!commentsByFile.has(comment.path)) {
        commentsByFile.set(comment.path, new Map());
      }
      const fileComments = commentsByFile.get(comment.path)!;
      if (!fileComments.has(comment.severity)) {
        fileComments.set(comment.severity, []);
      }
      fileComments.get(comment.severity)!.push(comment);
    });

    // Create detailed summary
    let detailedSummary = "## 📋 Detailed Changes Required\n\n";

    // Order of severity for the summary
    const severityOrder = ["critical", "warning", "suggestion"] as const;

    commentsByFile.forEach((fileComments, filePath) => {
      const fileHeader = `### 📁 ${filePath}\n\n`;
      let fileSection = "";

      severityOrder.forEach((severity) => {
        const comments = fileComments.get(severity) || [];
        if (comments.length > 0) {
          const emoji = getSeverityEmoji(severity);
          fileSection += `#### ${emoji} ${severity.toUpperCase()}\n\n`;

          comments.forEach((comment) => {
            fileSection += `- **Line ${comment.line}**: ${comment.body.replace(
              /\n/g,
              "\n  "
            )}\n`;
          });
          fileSection += "\n";
        }
      });

      if (fileSection) {
        detailedSummary += fileHeader + fileSection;
      }
    });

    const summary =
      comments.length > 0
        ? `### AI Code Review Summary
🔍 Found:
${
  criticalIssues > 0
    ? `- ❌ ${criticalIssues} critical issue${criticalIssues > 1 ? "s" : ""}\n`
    : ""
}
${warnings > 0 ? `- ⚠️ ${warnings} warning${warnings > 1 ? "s" : ""}\n` : ""}
${
  suggestions > 0
    ? `- 💡 ${suggestions} suggestion${suggestions > 1 ? "s" : ""}\n`
    : ""
}

${
  criticalIssues > 0
    ? "\n⛔ BLOCKING: Critical issues must be addressed before merging."
    : ""
}
${
  warnings > 0
    ? "\n⚠️ BLOCKING: Please review and address all warnings before merging."
    : ""
}
${
  suggestions > 0
    ? "\n💡 Consider implementing the suggestions for code improvement."
    : ""
}

${detailedSummary}`
        : "### ✅ AI Code Review Summary\nNo issues found in this review, but a human review is still recommended.";

    const reviewComments: Array<GitHubComment> = comments.map((comment) => ({
      body: `${getSeverityEmoji(
        comment.severity
      )} [${comment.severity.toUpperCase()}] ${comment.body}`,
      path: comment.path,
      line: comment.line,
    }));

    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      comments: reviewComments,
      event,
      body: summary,
    });
  } catch (error: unknown) {
    console.error("Error submitting review:", error);
    if (error instanceof Error) {
      throw new Error(`Failed to submit code review: ${error.message}`);
    } else {
      throw new Error("Failed to submit code review: Unknown error");
    }
  }
}

function getSeverityEmoji(
  severity: "critical" | "warning" | "suggestion"
): string {
  switch (severity) {
    case "critical":
      return "❌";
    case "warning":
      return "⚠️";
    case "suggestion":
      return "💡";
  }
}

async function main() {
  const prDetails = await getPRDetails();
  let diffResult: DiffWithContext | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diffResult = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    // Create a DiffWithContext object for the synchronize event
    diffResult = {
      diff: String(response.data),
      fileContexts: new Map(), // We'll populate this with file contents
    };

    // Parse the diff to get file paths and fetch their contents
    const parsedDiff = parseDiff(String(response.data));
    for (const file of parsedDiff) {
      if (file.to && file.to !== "/dev/null") {
        const fileContent = await getFileContent(
          prDetails.owner,
          prDetails.repo,
          file.to,
          newHeadSha
        );
        if (fileContent) {
          diffResult.fileContexts.set(file.to, fileContent);
        }
      }
    }
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diffResult) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diffResult.diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(
    filteredDiff,
    prDetails,
    diffResult.fileContexts
  );
  await createReviewComment(
    prDetails.owner,
    prDetails.repo,
    prDetails.pull_number,
    comments
  );

  // Set action status based on review outcome
  const criticalIssues = comments.filter(
    (c) => c.severity === "critical"
  ).length;
  const warnings = comments.filter((c) => c.severity === "warning").length;

  if (criticalIssues > 0) {
    core.setFailed(
      `❌ Found ${criticalIssues} critical issue${
        criticalIssues > 1 ? "s" : ""
      } that must be fixed.`
    );
  } else if (warnings > 0) {
    core.setFailed(
      `⚠️ Found ${warnings} warning${
        warnings > 1 ? "s" : ""
      } that should be addressed.`
    );
  } else {
    core.info("✅ Code review passed successfully.");
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
