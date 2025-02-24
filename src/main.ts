import { readFileSync } from "fs";
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import Together from "together-ai";

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

interface CodeIssue {
  type: "performance" | "security" | "practice" | "other";
  severity: "high" | "medium" | "low";
  description: string;
  suggestion: string;
  lineNumber?: number;
}

interface StaticAnalysisResult {
  issues: CodeIssue[];
  metrics: {
    cyclomaticComplexity?: number;
    nestingDepth?: number;
    functionLength?: number;
  };
}

function analyzeStatically(
  fileContent: string,
  fileExtension: string
): StaticAnalysisResult {
  const issues: CodeIssue[] = [];
  const metrics: {
    cyclomaticComplexity?: number;
    nestingDepth?: number;
    functionLength?: number;
  } = {};

  // Check for common security issues
  if (fileContent.includes("eval(")) {
    issues.push({
      type: "security",
      severity: "high",
      description: "Usage of eval() detected",
      suggestion:
        "Avoid using eval() as it can lead to code injection vulnerabilities. Consider safer alternatives.",
    });
  }

  if (fileContent.includes("innerHTML")) {
    issues.push({
      type: "security",
      severity: "medium",
      description: "Direct innerHTML manipulation detected",
      suggestion:
        "Use safer alternatives like textContent or DOM manipulation methods to prevent XSS attacks.",
    });
  }

  // Check for performance issues
  const nestedLoopRegex = /for\s*\([^{]+\{[^}]*for\s*\([^{]+\{/g;
  if (nestedLoopRegex.test(fileContent)) {
    issues.push({
      type: "performance",
      severity: "medium",
      description: "Nested loops detected",
      suggestion:
        "Consider optimizing nested loops to reduce time complexity. Consider using map/reduce or other data structures.",
    });
  }

  // Check for bad practices
  const deepNestingRegex = /\{[^{}]*\{[^{}]*\{[^{}]*\{[^{}]*\}/g;
  if (deepNestingRegex.test(fileContent)) {
    issues.push({
      type: "practice",
      severity: "medium",
      description: "Deep nesting detected (>3 levels)",
      suggestion:
        "Consider extracting nested logic into separate functions or using early returns to reduce nesting.",
    });
  }

  // Calculate metrics
  const lines = fileContent.split("\n");
  const functionRegex = /function\s+\w+\s*\([^)]*\)\s*\{/g;
  const functions = fileContent.match(functionRegex) || [];

  metrics.functionLength = functions.length;
  metrics.nestingDepth = Math.max(
    ...fileContent
      .split("\n")
      .map(
        (line) =>
          (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
      )
  );

  return { issues, metrics };
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails,
  fileContexts: Map<string, string>
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files

    const fileContent = file.to ? fileContexts.get(file.to) ?? null : null;

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

function createPrompt(
  file: File,
  chunk: Chunk,
  prDetails: PRDetails,
  fileContent: string | null
): string {
  const fileExtension = file.to ? file.to.split(".").pop() ?? "" : "";
  let staticAnalysis: StaticAnalysisResult = {
    issues: [],
    metrics: {
      cyclomaticComplexity: 0,
      nestingDepth: 0,
      functionLength: 0,
    },
  };

  if (fileContent !== null) {
    staticAnalysis = analyzeStatically(fileContent, fileExtension);
  }

  const staticAnalysisPrompt =
    staticAnalysis.issues.length > 0
      ? `\nStatic Analysis Results:\n${staticAnalysis.issues
          .map(
            (issue) =>
              `- ${issue.type.toUpperCase()} (${issue.severity}): ${
                issue.description
              }\n  Suggestion: ${issue.suggestion}`
          )
          .join("\n")}\n`
      : "";

  const contextPrompt = fileContent
    ? `\nFull file content for context:\n\`\`\`${fileExtension}\n${fileContent}\n\`\`\`\n${staticAnalysisPrompt}`
    : "";

  return `Your task is to review pull requests and identify code issues. Instructions:
- Provide the response in following JSON format:  {
  "reviews": [{
    "lineNumber": <line_number>,
    "reviewComment": "<review comment>",
    "type": "<performance|security|practice|other>",
    "severity": "<high|medium|low>"
  }]
}
- Focus on the following aspects:
  1. PERFORMANCE:
     - Identify inefficient algorithms and data structures
     - Detect redundant computations and unnecessary loops
     - Find memory leaks and resource management issues
     - Look for unoptimized async/await usage
  2. SECURITY:
     - Check for potential security vulnerabilities
     - Identify unsafe data handling
     - Detect improper input validation
     - Find potential injection points
  3. CODE QUALITY:
     - Identify code smells and anti-patterns
     - Check for proper error handling
     - Assess code maintainability
     - Look for potential race conditions
- Do not give positive comments or compliments
- Provide comments and suggestions ONLY if there is something to improve
- Write the comment in GitHub Markdown format
- Use the given description only for the overall context
- Consider the full file context when making suggestions
- IMPORTANT: NEVER suggest adding comments to the code

Review the following code diff in the file "${
    file.to
  }" and take the pull request title, description, and static analysis into account.
  
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
  type: string;
  severity: string;
}> | null> {
  const queryConfig = {
    model: TOGETHER_API_MODEL,
    temperature: 0.2,
    max_tokens: 1000,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await together.chat.completions.create({
      ...queryConfig,
      messages: [
        {
          role: "system",
          content: "You are a code review assistant. Provide responses in JSON format only, without any markdown formatting or additional text.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const content = response.choices[0].message?.content?.trim() || "{}";
    // Remove any markdown formatting if present
    const cleanJson = content.replace(/```[a-z]*\n|\n```/g, '').trim();
    
    try {
      const parsed = JSON.parse(cleanJson);
      return parsed.reviews || [];
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      // Attempt to extract JSON if wrapped in other text
      const jsonMatch = cleanJson.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const extracted = JSON.parse(jsonMatch[0]);
        return extracted.reviews || [];
      }
      return null;
    }
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
    type: string;
    severity: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    const severityEmoji =
      {
        high: "🔴",
        medium: "🟡",
        low: "🟢",
      }[aiResponse.severity] || "❓";

    const typeEmoji =
      {
        performance: "⚡",
        security: "🔒",
        practice: "📝",
        other: "❗",
      }[aiResponse.type] || "❗";

    return {
      body: `${severityEmoji} ${typeEmoji} **${aiResponse.type.toUpperCase()} (${
        aiResponse.severity
      })**: ${aiResponse.reviewComment}`,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
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
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
