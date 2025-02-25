import { readFileSync } from "fs";
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import Together from "together-ai";

// Add at the top of your file for local development
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
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
    if ('content' in response.data && !Array.isArray(response.data)) {
      return Buffer.from(response.data.content, 'base64').toString('utf8');
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
      if (file.to && file.to !== '/dev/null') {
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

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails,
  fileContexts: Map<string, string>
): Promise<Array<ReviewComment>> {
  const comments: Array<ReviewComment> = [];

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

interface ReviewComment {
  body: string;
  path: string;
  line: number;
  severity: 'critical' | 'warning' | 'suggestion';
}

interface GitHubComment {
  body: string;
  path: string;
  line: number;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails, fileContent: string | null): string {
  const fileExtension = file.to ? file.to.split('.').pop() || '' : '';
  const contextPrompt = fileContent ? `\nFull file content for context:\n\`\`\`${fileExtension}\n${fileContent}\n\`\`\`\n` : '';
  
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format: {"reviews": [{"lineNumber": <line_number>, "reviewComment": "<review comment>", "severity": "<severity>"}]}
- Severity levels:
  - "critical": For issues that must be fixed (security issues, bugs, broken functionality)
  - "warning": For code quality issues that should be addressed
  - "suggestion": For optional improvements
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- Consider the full file context when making suggestions.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code diff in the file "${file.to}" and take the pull request title and description into account when writing the response.
  
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
  severity?: 'critical' | 'warning' | 'suggestion';
}> | null> {
  const queryConfig = {
    model: TOGETHER_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
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
          content: prompt,
        },
      ],
    });

    const res = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(res).reviews;
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
    severity?: 'critical' | 'warning' | 'suggestion';
  }>
): Array<ReviewComment> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
      severity: aiResponse.severity || 'warning'
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<ReviewComment>
): Promise<void> {
  try {
    const criticalIssues = comments.filter(c => c.severity === 'critical').length;
    const warnings = comments.filter(c => c.severity === 'warning').length;
    const suggestions = comments.filter(c => c.severity === 'suggestion').length;

    const event = criticalIssues > 0 ? "REQUEST_CHANGES" 
                 : warnings > 0 ? "REQUEST_CHANGES"
                 : "COMMENT";

    const summary = comments.length > 0 
      ? `### AI Code Review Summary
🔍 Found:
${criticalIssues > 0 ? `- ❌ ${criticalIssues} critical issue${criticalIssues > 1 ? 's' : ''}\n` : ''}
${warnings > 0 ? `- ⚠️ ${warnings} warning${warnings > 1 ? 's' : ''}\n` : ''}
${suggestions > 0 ? `- 💡 ${suggestions} suggestion${suggestions > 1 ? 's' : ''}\n` : ''}

${criticalIssues > 0 ? '\n⛔ Critical issues must be addressed before merging.' : ''}
${warnings > 0 ? '\n⚠️ Please review and address the warnings before merging.' : ''}
${suggestions > 0 ? '\n💡 Consider the suggestions for code improvement.' : ''}`
      : "### ✅ AI Code Review Summary\nNo issues found. The code looks good!";

    const reviewComments: Array<GitHubComment> = comments.map(comment => ({
      body: `[${comment.severity.toUpperCase()}] ${comment.body}`,
      path: comment.path,
      line: comment.line
    }));

    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      comments: reviewComments,
      event,
      body: summary
    });
  } catch (error: unknown) {
    console.error('Error submitting review:', error);
    if (error instanceof Error) {
      throw new Error(`Failed to submit code review: ${error.message}`);
    } else {
      throw new Error('Failed to submit code review: Unknown error');
    }
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
      if (file.to && file.to !== '/dev/null') {
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

  const comments = await analyzeCode(filteredDiff, prDetails, diffResult.fileContexts);
  await createReviewComment(
    prDetails.owner,
    prDetails.repo,
    prDetails.pull_number,
    comments
  );

  // Set action status based on review outcome
  const criticalIssues = comments.filter(c => c.severity === 'critical').length;
  const warnings = comments.filter(c => c.severity === 'warning').length;
  
  if (criticalIssues > 0) {
    core.setFailed(`❌ Found ${criticalIssues} critical issue${criticalIssues > 1 ? 's' : ''} that must be fixed.`);
  } else if (warnings > 0) {
    core.setFailed(`⚠️ Found ${warnings} warning${warnings > 1 ? 's' : ''} that should be addressed.`);
  } else {
    core.info('✅ Code review passed successfully.');
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
