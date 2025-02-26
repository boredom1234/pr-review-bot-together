import { readFileSync } from "fs";
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import Together from "together-ai";
import path from "path";
import {
  runQualityMetrics,
  formatQualityMetricsMarkdown,
} from "./qualityMetrics";

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

  console.log(`Analyzing ${parsedDiff.length} files in the diff`);
  
  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files

    console.log(`Analyzing file: ${file.to}`);
    const fileContent = file.to ? fileContexts.get(file.to) ?? null : null;
    
    if (!fileContent) {
      console.log(`No content found for file: ${file.to}`);
    } else {
      console.log(`Found content for file: ${file.to}, length: ${fileContent.length} characters`);
    }

    // Add extension validation
    if (file.to && fileContent) {
      const extensionError = validateFileExtension(file.to, fileContent);
      if (extensionError) {
        console.log(`Found extension error for file: ${file.to}`);
        comments.push(extensionError);
      }
    }

    console.log(`File ${file.to} has ${file.chunks?.length || 0} chunks`);
    
    for (const chunk of file.chunks) {
      console.log(`Processing chunk with ${chunk.changes.length} changes`);
      const prompt = createPrompt(file, chunk, prDetails, fileContent);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        console.log(`Received AI response with ${aiResponse.length} comments`);
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          console.log(`Created ${newComments.length} comments for file: ${file.to}`);
          comments.push(...newComments);
        }
      } else {
        console.log(`No AI response received for chunk in file: ${file.to}`);
      }
    }
  }
  
  console.log(`Total comments generated: ${comments.length}`);
  return comments;
}

interface ReviewComment {
  body: string;
  path: string;
  line: number;
  severity: "critical" | "warning" | "suggestion";
  id?: string; // Unique identifier for tracking
  status?: "active" | "resolved" | "outdated"; // Track comment status
  source?: "ai" | "quality-tool"; // Source of the comment
}

interface HistoricalReviewComment extends ReviewComment {
  id: string;
  status: "active" | "resolved" | "outdated";
}

interface HistoricalReview {
  id: string;
  comment: HistoricalReviewComment;
  commitSha: string;
  timestamp: string;
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
    console.log("Sending prompt to AI model:", TOGETHER_API_MODEL);
    
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

    console.log("Received response from AI model");
    const res = response.choices[0].message?.content?.trim() || "{}";
    try {
      // Remove any markdown formatting that might be present
      const cleanJson = res
        .replace(/```[a-z]*\n/g, "")
        .replace(/```/g, "")
        .trim();
      console.log("Cleaned JSON:", cleanJson.substring(0, 200) + "...");
      
      const parsed = JSON.parse(cleanJson);
      if (!parsed.reviews || !Array.isArray(parsed.reviews)) {
        console.warn("Invalid response format from AI");
        return [];
      }
      console.log(`Found ${parsed.reviews.length} review comments from AI`);
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
  comments: Array<ReviewComment>,
  qualityMetricsMarkdown: string = ""
): Promise<void> {
  try {
    const criticalIssues = comments.filter(
      (c) => c.severity === "critical"
    ).length;
    const warnings = comments.filter((c) => c.severity === "warning").length;
    const suggestions = comments.filter(
      (c) => c.severity === "suggestion"
    ).length;
    const resolvedIssues = comments.filter(
      (c) => c.status === "resolved"
    ).length;

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
    let detailedSummary = "## 📋 Code Review Summary\n\n";

    if (resolvedIssues > 0) {
      detailedSummary += `### ✅ Resolved Issues\n- ${resolvedIssues} issue${
        resolvedIssues > 1 ? "s have" : " has"
      } been resolved\n\n`;
    }

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
            const status = comment.status === "resolved" ? "✅ RESOLVED: " : "";
            fileSection += `- **Line ${
              comment.line
            }**: ${status}${comment.body.replace(/\n/g, "\n  ")}\n`;
          });
          fileSection += "\n";
        }
      });

      if (fileSection) {
        detailedSummary += fileHeader + fileSection;
      }
    });

    // Add quality metrics to the summary if available
    if (qualityMetricsMarkdown) {
      detailedSummary += `\n${qualityMetricsMarkdown}\n`;
    }

    const reviewComments = comments.map((comment) => ({
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
      body: detailedSummary,
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

async function getPreviousReviews(
  owner: string,
  repo: string,
  pull_number: number
): Promise<HistoricalReview[]> {
  try {
    const { data: comments } = await octokit.pulls.listReviewComments({
      owner,
      repo,
      pull_number,
      per_page: 100,
    });

    const reviews = comments
      .map((comment) => {
        const match = comment.body.match(/<!--review-id:(.*?),commit:(.*?)-->/);
        if (!match) return null;

        const [, id, commitSha] = match;
        const severity = comment.body
          .match(/\[(CRITICAL|WARNING|SUGGESTION)\]/i)?.[1]
          .toLowerCase() as "critical" | "warning" | "suggestion";

        const review: HistoricalReview = {
          id,
          commitSha,
          timestamp: comment.created_at,
          comment: {
            body: comment.body.replace(/<!--.*?-->/g, "").trim(),
            path: comment.path,
            line: comment.line || 1,
            severity: severity || "warning",
            id,
            status: "active",
          },
        };
        return review;
      })
      .filter((review): review is HistoricalReview => review !== null);

    return reviews;
  } catch (error) {
    console.error("Error fetching previous reviews:", error);
    return [];
  }
}

async function compareWithPreviousReviews(
  newComments: ReviewComment[],
  historicalReviews: HistoricalReview[],
  currentCommitSha: string
): Promise<ReviewComment[]> {
  const processedComments: ReviewComment[] = [];

  for (const newComment of newComments) {
    // Generate a stable ID for the new comment based on its content and location
    const commentId = Buffer.from(
      `${newComment.path}:${newComment.line}:${newComment.body}`
    ).toString("base64");
    newComment.id = commentId;

    // Check if this issue was previously reported
    const previousReview = historicalReviews.find(
      (hr) =>
        hr.comment.path === newComment.path &&
        Math.abs(hr.comment.line - newComment.line) <= 3 && // Allow small line number changes
        hr.comment.body.replace(/\[.*?\]/g, "").trim() ===
          newComment.body.replace(/\[.*?\]/g, "").trim()
    );

    if (previousReview) {
      // If the issue still exists, mark it as persistent
      newComment.body = `${newComment.body}\n\n⚠️ This issue was previously reported and still needs to be addressed.`;
    }

    // Add tracking metadata
    newComment.body = `<!--review-id:${commentId},commit:${currentCommitSha}-->\n${newComment.body}`;
    processedComments.push(newComment);
  }

  // Check for resolved issues
  const resolvedComments = historicalReviews
    .filter((hr) => !processedComments.some((pc) => pc.id === hr.comment.id))
    .map((hr) => ({
      ...hr.comment,
      body: `✅ RESOLVED: ${hr.comment.body}`,
      status: "resolved" as const,
    }));

  return [...processedComments, ...resolvedComments];
}

async function main() {
  const prDetails = await getPRDetails();
  let diffResult: DiffWithContext | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  // Get the current commit SHA
  const currentCommitSha = eventData.after || eventData.pull_request.head.sha;

  console.log("PR Details:", JSON.stringify(prDetails, null, 2));
  console.log("Event type:", eventData.action);
  
  // Fetch previous reviews first
  const historicalReviews = await getPreviousReviews(
    prDetails.owner,
    prDetails.repo,
    prDetails.pull_number
  );
  
  console.log(`Found ${historicalReviews.length} historical reviews`);

  if (eventData.action === "opened") {
    console.log("Getting diff for newly opened PR");
    diffResult = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    console.log("Getting diff for synchronized PR");
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;
    
    console.log(`Comparing commits: ${newBaseSha} -> ${newHeadSha}`);

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diffResult = {
      diff: String(response.data),
      fileContexts: new Map(),
    };
    
    console.log(`Diff length: ${diffResult.diff.length} characters`);

    const parsedDiff = parseDiff(String(response.data));
    console.log(`Parsed diff contains ${parsedDiff.length} files`);
    
    for (const file of parsedDiff) {
      if (file.to && file.to !== "/dev/null") {
        console.log(`Fetching content for file: ${file.to}`);
        const fileContent = await getFileContent(
          prDetails.owner,
          prDetails.repo,
          file.to,
          newHeadSha
        );
        if (fileContent) {
          console.log(`Got content for file: ${file.to}, length: ${fileContent.length} characters`);
          diffResult.fileContexts.set(file.to, fileContent);
        } else {
          console.log(`Failed to get content for file: ${file.to}`);
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
  
  console.log(`Diff result contains ${diffResult.fileContexts.size} files with content`);

  const parsedDiff = parseDiff(diffResult.diff);
  console.log(`Parsed diff contains ${parsedDiff.length} files`);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());
    
  console.log(`Exclude patterns: ${JSON.stringify(excludePatterns)}`);

  const filteredDiff = parsedDiff.filter((file) => {
    const shouldExclude = excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
    if (shouldExclude) {
      console.log(`Excluding file: ${file.to}`);
    }
    return !shouldExclude;
  });
  
  console.log(`After filtering, diff contains ${filteredDiff.length} files`);

  // Get list of changed files for quality metrics
  const changedFiles = filteredDiff
    .filter((file) => file.to && file.to !== "/dev/null")
    .map((file) => file.to as string);

  // Run quality metrics on changed files
  const qualityResults = await runQualityMetrics(process.cwd(), changedFiles);

  // Convert quality issues to review comments
  const qualityComments: ReviewComment[] = qualityResults.issues.map(
    (issue) => ({
      body: `${issue.message} (${issue.rule})`,
      path: issue.path,
      line: issue.line,
      severity: issue.severity,
      source: "quality-tool",
    })
  );

  let comments = await analyzeCode(
    filteredDiff,
    prDetails,
    diffResult.fileContexts
  );

  // Add quality comments to AI comments
  comments = [...comments, ...qualityComments];

  // Compare with previous reviews and update comments
  comments = await compareWithPreviousReviews(
    comments,
    historicalReviews,
    currentCommitSha
  );

  // Filter comments based on comment_mode
  const commentMode = core.getInput("comment_mode") || "all";
  let filteredComments = [...comments];

  if (commentMode === "new") {
    // Only include comments that don't have a matching historical review
    filteredComments = comments.filter(
      (comment) => !historicalReviews.some((hr) => hr.comment.id === comment.id)
    );
  } else if (commentMode === "unresolved") {
    // Include new comments and unresolved historical comments
    filteredComments = comments.filter(
      (comment) => comment.status !== "resolved"
    );
  }
  // 'all' mode includes all comments, so no filtering needed

  // Format quality metrics as markdown
  const qualityMetricsMarkdown = formatQualityMetricsMarkdown(
    qualityResults.metrics
  );

  await createReviewComment(
    prDetails.owner,
    prDetails.repo,
    prDetails.pull_number,
    filteredComments,
    qualityMetricsMarkdown
  );

  // Set action status based on review outcome
  const criticalIssues = comments.filter(
    (c) => c.severity === "critical" && c.status !== "resolved"
  ).length;
  const warnings = comments.filter(
    (c) => c.severity === "warning" && c.status !== "resolved"
  ).length;
  const suggestions = comments.filter(
    (c) => c.severity === "suggestion" && c.status !== "resolved"
  ).length;

  const failOnQualityIssues =
    core.getInput("fail_on_quality_issues") === "true";
  const qualityIssuesCount = qualityResults.issues.length;

  // Get configurable thresholds
  const maxCriticalIssues = parseInt(
    core.getInput("max_critical_issues") || "0"
  );
  const maxWarningIssues = parseInt(
    core.getInput("max_warning_issues") || "-1"
  );
  const maxSuggestionIssues = parseInt(
    core.getInput("max_suggestion_issues") || "-1"
  );

  // Check if we should fail based on thresholds
  let shouldFail = false;
  let failureMessage = "";

  if (maxCriticalIssues >= 0 && criticalIssues > maxCriticalIssues) {
    shouldFail = true;
    failureMessage = `❌ Found ${criticalIssues} critical issue${
      criticalIssues > 1 ? "s" : ""
    } (threshold: ${maxCriticalIssues}).`;
  } else if (maxWarningIssues >= 0 && warnings > maxWarningIssues) {
    shouldFail = true;
    failureMessage = `⚠️ Found ${warnings} warning${
      warnings > 1 ? "s" : ""
    } (threshold: ${maxWarningIssues}).`;
  } else if (maxSuggestionIssues >= 0 && suggestions > maxSuggestionIssues) {
    shouldFail = true;
    failureMessage = `💡 Found ${suggestions} suggestion${
      suggestions > 1 ? "s" : ""
    } (threshold: ${maxSuggestionIssues}).`;
  } else if (failOnQualityIssues && qualityIssuesCount > 0) {
    shouldFail = true;
    failureMessage = `⚠️ Found ${qualityIssuesCount} quality issue${
      qualityIssuesCount > 1 ? "s" : ""
    } that should be addressed.`;
  }

  if (shouldFail) {
    core.setFailed(failureMessage);
  } else {
    core.info("✅ Code review passed successfully.");
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
