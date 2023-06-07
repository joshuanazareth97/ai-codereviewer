import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { readFileSync, writeFileSync } from "fs";
import minimatch from "minimatch";
import { CreateChatCompletionRequest } from "openai";
import parseDiff, { Chunk, File } from "parse-diff";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

import axios from "axios";

function escapeString(inputString: string) {
  // return inputString;
  return inputString.replace('"', '\\"').replace("`", "\\`");
}

const apiUrl =
  "https://southregiontesting.openai.azure.com/openai/deployments/Test1/chat/completions";

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

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompts = createPrompts(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompts);
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

async function getBaseAndHeadShas(
  owner: string,
  repo: string,
  pull_number: number
): Promise<{ baseSha: string; headSha: string }> {
  const prResponse = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
  });
  return {
    baseSha: prResponse.data.base.sha,
    headSha: prResponse.data.head.sha,
  };
}

function createPrompts(
  file: File,
  chunk: Chunk,
  prDetails: PRDetails
): [string, string, string] {
  return [
    `You are a code analyzer and experienced software developer. Your task is to review pull requests. Instructions:
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise return an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- Check your comment to make sure it is correct.
- IMPORTANT: Do not make assumptions about what the code is supposed to do, only suggest improvements in syntax, keeping in mind the best practices of Javascript. 
- DO NOT suggest linting or formatting changes.
- IMPORTANT: NEVER suggest adding comments to the code.
- Point out any code smells in the block, but only after you understand exactly what the code does. If unsure, omit any comments about that line.
 `,
    `Provide the response in following JSON format:  [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]`,
    `Review the following code diff in the file "${
      file.to
    }" and take the pull request title and description into account when writing the response.
Pull request title: ${prDetails.title}
  
Pull request description:
---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`,
  ];
}

async function getAIResponse(prompt: [string, string, string]): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    // model: "gpt-3.5-turbo",
    // temperature: 0.2,
    max_tokens: 700,
    // top_p: 1,
    // frequency_penalty: 0,
    // presence_penalty: 0,
  };
  const payload: Partial<CreateChatCompletionRequest> = {
    ...queryConfig,
    messages: [
      {
        role: "system",
        content: prompt[0],
      },
      {
        role: "system",
        content: prompt[1],
      },
      {
        role: "user",
        content: prompt[2],
      },
    ],
  };
  try {
    const response = await axios.post(apiUrl, payload, {
      headers: {
        "Content-Type": "application/json",
        "api-key": OPENAI_API_KEY,
      },
      params: {
        "api-version": "2023-05-15",
      },
    });
    const res = response.data.choices[0].message?.content?.trim() || "[]";

    return JSON.parse(res);
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
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
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
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = response.data.diff_url
      ? await octokit
          .request({ url: response.data.diff_url })
          .then((res) => res.data)
      : null;
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
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
