import { InspectionType, RepoConfig } from './types.js';

function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

function buildLogAnalysisInstructions(syncedLogDirs: Record<string, string>): string {
  const logEntries = Object.entries(syncedLogDirs);

  if (logEntries.length === 0) {
    return `## Inspection: log-analysis

No log directories are available for this run. Fall back to checking the repository
for recent error patterns:

1. Look at recent commits for bug fixes or error-related changes.
2. Search the codebase for TODO/FIXME/HACK comments that indicate known issues.
3. Check for error handling patterns that may be incomplete.
4. Review any test failures or skipped tests.

For each issue found, create a fix branch and PR with evidence from the codebase.`;
  }

  const logList = logEntries
    .map(([name, path]) => `- **${name}**: \`${path}\``)
    .join('\n');

  return `## Inspection: log-analysis

Available log directories:
${logList}

Instructions:
1. Read the log files in each directory listed above.
2. Identify errors, warnings, stack traces, and recurring failure patterns.
3. Cross-reference errors with the repository source code to find root causes.
4. For each actionable issue, create a fix branch and open a PR.
5. Include relevant log excerpts as evidence in each PR description.`;
}

function buildCodeReviewInstructions(): string {
  return `## Inspection: code-review

No logs are needed for this inspection. Focus on code quality and correctness.

Instructions:
1. Review the codebase for bugs, logic errors, and edge cases.
2. Look for error handling gaps — uncaught exceptions, missing null checks, unhandled promise rejections.
3. Identify performance problems — N+1 queries, unnecessary allocations, blocking operations.
4. Check for code smells — duplicated logic, overly complex functions, dead code.
5. Review recent commits for context on active development areas.
6. For each issue found, create a fix branch and open a PR with a clear explanation.`;
}

function buildSecurityReviewInstructions(): string {
  return `## Inspection: security-review

Perform a security-focused review of the codebase.

Instructions:
1. Scan for OWASP Top 10 vulnerabilities:
   - Injection (SQL, command, template)
   - Broken authentication / session management
   - Sensitive data exposure
   - XML external entities (XXE)
   - Broken access control
   - Security misconfiguration
   - Cross-site scripting (XSS)
   - Insecure deserialization
   - Using components with known vulnerabilities
   - Insufficient logging and monitoring
2. Check for hardcoded secrets, API keys, tokens, or passwords in source code.
3. Review dependencies for known insecure versions.
4. Look for injection vulnerabilities in user input handling.
5. For each finding, create a fix branch and open a PR.
6. Rate each vulnerability by severity: critical, high, medium, or low.
7. If you are uncertain about a vulnerability, flag it for human review rather than ignoring it.`;
}

function buildCommonRules(repo: RepoConfig): string {
  const branchPrefix = `${repo.healBranchPrefix}${getTodayDate()}`;

  return `## Common Rules

- **Never commit directly to main.** Always create a new branch for each fix.
- Use the branch prefix \`${branchPrefix}\` followed by a short descriptor, e.g. \`${branchPrefix}/fix-null-check\`.
- One branch per fix — do not bundle unrelated changes.
- Use \`gh pr create\` to open pull requests.
- Run \`gh auth setup-git\` before any git operations to configure credentials.
- Set git identity from the repo's existing git config:
  \`\`\`
  GIT_AUTHOR_NAME=$(git -C /workspace/extra/${repo.name} config user.name)
  GIT_AUTHOR_EMAIL=$(git -C /workspace/extra/${repo.name} config user.email)
  export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL
  export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
  \`\`\`
- Include evidence in every PR description — log excerpts, code snippets, or reasoning.`;
}

function buildSummaryTemplate(): string {
  return `## Summary

When you are done, send a summary using the \`send_message\` MCP tool with this format:

\`\`\`
Heal Run Summary
================
Repo: {repo name}
Inspection: {inspection type}
Date: {today's date}

PRs Created:
- {PR title} ({PR URL}) — {one-line description}

Issues Found (no PR):
- {description} — {reason no PR was created}

No Issues:
- {area reviewed with no problems found}
\`\`\``;
}

export function buildHealPrompt(
  repo: RepoConfig,
  inspectionType: InspectionType,
  syncedLogDirs: Record<string, string>,
): string {
  const containerPath = `/workspace/extra/${repo.name}`;

  const header = `# Heal Agent — ${inspectionType}

**Repository:** ${repo.name}
**Container path:** \`${containerPath}\`
**Branch prefix:** \`${repo.healBranchPrefix}${getTodayDate()}\`

You are an automated code healer. Your job is to inspect the repository at \`${containerPath}\`
and create pull requests for any issues you find.`;

  let inspectionInstructions: string;
  switch (inspectionType) {
    case 'log-analysis':
      inspectionInstructions = buildLogAnalysisInstructions(syncedLogDirs);
      break;
    case 'code-review':
      inspectionInstructions = buildCodeReviewInstructions();
      break;
    case 'security-review':
      inspectionInstructions = buildSecurityReviewInstructions();
      break;
  }

  const commonRules = buildCommonRules(repo);
  const summary = buildSummaryTemplate();

  return [header, inspectionInstructions, commonRules, summary].join('\n\n');
}
