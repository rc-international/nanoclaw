import type { HealBatch } from "./types.js";

function getTodayDate(): string {
	return new Date().toISOString().split("T")[0];
}

/**
 * Build an error-driven heal prompt from a batch of errors.
 * The prompt instructs the container agent to investigate each error,
 * create fix branches + PRs, and report results via send_message.
 */
export function buildReactiveHealPrompt(
	batch: HealBatch,
	repoContainerPath: string,
): string {
	const errorSections = batch.entries
		.map((entry, i) => {
			const lines = [
				`ERROR ${i + 1} (${entry.occurrences} occurrence${entry.occurrences !== 1 ? "s" : ""}):`,
				`  File: ${entry.file}:${entry.line}`,
				`  Error: ${entry.error}`,
			];

			if (entry.traceback) {
				lines.push(`  Traceback: ${entry.traceback}`);
			}

			if (entry.blameCommit) {
				let blameLine = `  Authored by commit: ${entry.blameCommit}`;
				if (entry.sessionId) {
					blameLine += ` (Session-Id: ${entry.sessionId})`;
				}
				lines.push(blameLine);
			}

			return lines.join("\n");
		})
		.join("\n\n");

	const today = getTodayDate();

	return `You are a code healer. These errors were reported in production:

${errorSections}

REPO: ${repoContainerPath} (cloned from ${batch.repo_url})
User: ${batch.user}

WORKFLOW:
1. Investigate each error in the source code at ${repoContainerPath}
2. Set up git credentials:
   \`\`\`bash
   GH_CONFIG_DIR=/workspace/extra/.gh-config gh auth setup-git
   export GIT_AUTHOR_NAME=$(git -C ${repoContainerPath} config user.name || echo "NanoClaw Healer")
   export GIT_AUTHOR_EMAIL=$(git -C ${repoContainerPath} config user.email || echo "healer@nanoclaw.local")
   export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
   export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
   \`\`\`
3. For each error, create branch \`heal/${today}/<short-descriptor>\`
4. Implement the minimal fix and run tests if available
5. Push and create a PR with evidence (error message, traceback, root cause)
6. Return to the default branch before the next fix

RULES:
- One branch per fix — do not bundle unrelated errors
- Never commit directly to main/master
- Include the original error message and traceback in each PR description
- If unsure about a fix, flag it in the summary instead of guessing
- Use \`send_message\` MCP tool to report progress and final summary

SUMMARY FORMAT (send via send_message when done):
\`\`\`
Reactive Heal Summary
=====================
Repo: ${batch.repo}
Date: ${today}
Errors received: ${batch.entries.length}

PRs Created:
- {PR title} ({PR URL}) — {one-line description}

Flagged for Review:
- {error description} — {reason no fix was attempted}
\`\`\``;
}
