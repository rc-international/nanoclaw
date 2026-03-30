# Reactive Code Healer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add event-driven code healing — Discord error notifications trigger on-demand repo cloning, error tracing, and automated fix PRs.

**Architecture:** New modules (types, traceback parser, repo cloner, prompt builder, debouncer, orchestrator) wire into the existing Discord channel handler and container infrastructure. The reactive healer intercepts `"nanoclaw": "heal"` payloads before normal message routing, debounces per user+repo, then spawns containers using the existing `runContainerAgent()` with cloned repos mounted. Session resumption flows through the existing `ContainerInput.sessionId` field.

**Tech Stack:** TypeScript, Node.js `child_process` for git operations, Vitest for tests, discord.js for message interception.

**Design doc:** `docs/plans/2026-03-30-reactive-healer-design.md`

---

### Task 1: Types + Contract Validator

Add `HealRequest`, `HealBatch`, and `HealError` types. Add a `validateHealPayload()` function that parses raw JSON and returns a validated `HealRequest` or an error string.

**Files:**
- Modify: `src/types.ts` (append after line 140)
- Create: `src/reactive-healer.ts`
- Create: `src/reactive-healer.test.ts`

**Step 1: Add types to `src/types.ts`**

Append after line 140 (after `UserProfile`):

```typescript
// --- Reactive Healer types ---

export interface HealRequest {
  nanoclaw: 'heal';
  user: string;        // Linux username
  repo: string;        // Repo name for dedup/display
  repo_url: string;    // Clone URL
  error: string;       // Error message
  traceback?: string;  // Stack trace
  file?: string;       // Source file path
  line?: number;       // Line number
  commit?: string;     // Deployed commit SHA
  severity?: 'error' | 'warning';
}

export interface HealBatchEntry {
  file: string;
  line: number;
  error: string;
  traceback?: string;
  commit?: string;
  occurrences: number;
  blameCommit?: string;
  sessionId?: string;
}

export interface HealBatch {
  user: string;
  repo: string;
  repo_url: string;
  entries: HealBatchEntry[];
  sourceChannelJid: string;
}
```

**Step 2: Write the failing test**

Create `src/reactive-healer.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { validateHealPayload } from './reactive-healer.js';

describe('validateHealPayload', () => {
  const validPayload = {
    nanoclaw: 'heal',
    user: 'bjern',
    repo: 'datarake',
    repo_url: 'https://github.com/bjern/datarake',
    error: 'Client error 400',
  };

  it('accepts a valid payload with required fields only', () => {
    const result = validateHealPayload(validPayload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.user).toBe('bjern');
      expect(result.request.repo).toBe('datarake');
      expect(result.request.severity).toBe('error'); // default
    }
  });

  it('accepts a payload with all optional fields', () => {
    const full = {
      ...validPayload,
      traceback: 'File "foo.py", line 10',
      file: 'foo.py',
      line: 10,
      commit: 'abc123',
      severity: 'warning',
    };
    const result = validateHealPayload(full);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.file).toBe('foo.py');
      expect(result.request.line).toBe(10);
      expect(result.request.severity).toBe('warning');
    }
  });

  it('rejects when nanoclaw field is not "heal"', () => {
    const result = validateHealPayload({ ...validPayload, nanoclaw: 'other' });
    expect(result.ok).toBe(false);
  });

  it('rejects when nanoclaw field is missing', () => {
    const { nanoclaw, ...rest } = validPayload;
    const result = validateHealPayload(rest);
    expect(result.ok).toBe(false);
  });

  it('rejects when required fields are missing', () => {
    for (const field of ['user', 'repo', 'repo_url', 'error']) {
      const partial = { ...validPayload };
      delete (partial as any)[field];
      const result = validateHealPayload(partial);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(field);
      }
    }
  });

  it('rejects non-object input', () => {
    expect(validateHealPayload(null).ok).toBe(false);
    expect(validateHealPayload('string').ok).toBe(false);
    expect(validateHealPayload(42).ok).toBe(false);
  });

  it('coerces line to number', () => {
    const result = validateHealPayload({ ...validPayload, line: '305' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.line).toBe(305);
    }
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run src/reactive-healer.test.ts`
Expected: FAIL — `validateHealPayload` does not exist yet

**Step 4: Write minimal implementation**

Create `src/reactive-healer.ts` with just the validator:

```typescript
import { logger } from './logger.js';
import type { HealRequest } from './types.js';

type ValidationResult =
  | { ok: true; request: HealRequest }
  | { ok: false; error: string };

const REQUIRED_FIELDS = ['nanoclaw', 'user', 'repo', 'repo_url', 'error'] as const;

export function validateHealPayload(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Payload must be a JSON object' };
  }

  const obj = raw as Record<string, unknown>;

  if (obj.nanoclaw !== 'heal') {
    return { ok: false, error: 'nanoclaw field must be "heal"' };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!obj[field] && obj[field] !== 0) {
      return { ok: false, error: `Missing required field: ${field}` };
    }
  }

  const line = obj.line != null ? Number(obj.line) : undefined;

  const request: HealRequest = {
    nanoclaw: 'heal',
    user: String(obj.user),
    repo: String(obj.repo),
    repo_url: String(obj.repo_url),
    error: String(obj.error),
    traceback: obj.traceback != null ? String(obj.traceback) : undefined,
    file: obj.file != null ? String(obj.file) : undefined,
    line: line != null && !isNaN(line) ? line : undefined,
    commit: obj.commit != null ? String(obj.commit) : undefined,
    severity: obj.severity === 'warning' ? 'warning' : 'error',
  };

  return { ok: true, request };
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run src/reactive-healer.test.ts`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/types.ts src/reactive-healer.ts src/reactive-healer.test.ts
git commit -m "feat(healer): add reactive heal types and contract validator"
```

---

### Task 2: Traceback Parser

Parse Python and Node.js stack traces to extract `file` and `line` pairs. Falls back gracefully when no trace is present.

**Files:**
- Create: `src/traceback-parser.ts`
- Create: `src/traceback-parser.test.ts`

**Step 1: Write the failing test**

Create `src/traceback-parser.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { parseTraceback } from './traceback-parser.js';

describe('parseTraceback', () => {
  it('parses Python traceback', () => {
    const tb = `Traceback (most recent call last):
  File "src/datarake/parqinglot.py", line 305, in insert_scrape_failure
    resp.raise_for_status()
  File "src/datarake/client.py", line 42, in send
    return self.session.post(url, data=data)
httpx.HTTPStatusError: Client error '400 Bad Request'`;

    const results = parseTraceback(tb);
    // Most recent frame first (Python tracebacks list earliest first,
    // but the last frame is closest to the error)
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]).toEqual({
      file: 'src/datarake/client.py',
      line: 42,
    });
    expect(results[1]).toEqual({
      file: 'src/datarake/parqinglot.py',
      line: 305,
    });
  });

  it('parses Node.js stack trace', () => {
    const tb = `Error: ENOENT: no such file or directory
    at Object.openSync (node:fs:603:3)
    at readFileSync (node:fs:471:35)
    at loadConfig (/app/src/config.ts:25:18)
    at main (/app/src/index.ts:100:5)`;

    const results = parseTraceback(tb);
    // Filters out node: internal frames
    expect(results).toEqual([
      { file: '/app/src/config.ts', line: 25 },
      { file: '/app/src/index.ts', line: 100 },
    ]);
  });

  it('parses single-line Python frame', () => {
    const results = parseTraceback(
      'File "src/app.py", line 10, in main',
    );
    expect(results).toEqual([{ file: 'src/app.py', line: 10 }]);
  });

  it('returns empty array for non-traceback text', () => {
    expect(parseTraceback('just an error message')).toEqual([]);
    expect(parseTraceback('')).toEqual([]);
  });

  it('handles mixed formats', () => {
    const tb = `File "handler.py", line 5, in run
    at process (/srv/worker.js:88:12)`;
    const results = parseTraceback(tb);
    expect(results).toContainEqual({ file: 'handler.py', line: 5 });
    expect(results).toContainEqual({ file: '/srv/worker.js', line: 88 });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/traceback-parser.test.ts`
Expected: FAIL — module does not exist

**Step 3: Write minimal implementation**

Create `src/traceback-parser.ts`:

```typescript
export interface TraceFrame {
  file: string;
  line: number;
}

// Python: File "path/to/file.py", line 42, in function_name
const PYTHON_FRAME = /File "([^"]+)", line (\d+)/g;

// Node.js: at functionName (/path/to/file.ts:42:18)
// Also matches: at /path/to/file.ts:42:18
const NODE_FRAME = /at\s+(?:\S+\s+)?\(?((?:\/|[a-zA-Z]:)[^:)]+):(\d+):\d+\)?/g;

/**
 * Extract file+line pairs from a stack trace string.
 * Supports Python and Node.js formats. Filters out internal
 * node: modules. Returns frames in source order (most recent last
 * for Python, most recent first for Node.js — caller should use
 * the first entry as the primary location).
 */
export function parseTraceback(text: string): TraceFrame[] {
  const frames: TraceFrame[] = [];
  const seen = new Set<string>();

  // Python frames
  for (const match of text.matchAll(PYTHON_FRAME)) {
    const key = `${match[1]}:${match[2]}`;
    if (!seen.has(key)) {
      seen.add(key);
      frames.push({ file: match[1], line: parseInt(match[2], 10) });
    }
  }

  // Node.js frames (skip node: built-in modules)
  for (const match of text.matchAll(NODE_FRAME)) {
    if (match[1].startsWith('node:')) continue;
    const key = `${match[1]}:${match[2]}`;
    if (!seen.has(key)) {
      seen.add(key);
      frames.push({ file: match[1], line: parseInt(match[2], 10) });
    }
  }

  return frames;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/traceback-parser.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/traceback-parser.ts src/traceback-parser.test.ts
git commit -m "feat(healer): add traceback parser for Python and Node.js"
```

---

### Task 3: Repo Cloner + Blame Resolver

Clone a repo on demand, optionally checkout a specific commit, run `git blame` to find authoring commits, and extract `Session-Id` trailers.

**Files:**
- Create: `src/repo-cloner.ts`
- Create: `src/repo-cloner.test.ts`

**Step 1: Write the failing test**

Create `src/repo-cloner.test.ts`:

```typescript
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  blameLineForSessionId,
  cleanupClone,
  cloneRepo,
} from './repo-cloner.js';

// These tests use a real local git repo (no network calls)
const TEST_DIR = path.join(os.tmpdir(), `repo-cloner-test-${process.pid}`);
const BARE_REPO = path.join(TEST_DIR, 'bare.git');

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // Create a bare repo to act as "remote"
  execSync(`git init --bare ${BARE_REPO}`);

  // Create a working repo, add a file, push to bare
  const work = path.join(TEST_DIR, 'work');
  execSync(`git clone ${BARE_REPO} ${work}`);
  fs.writeFileSync(path.join(work, 'app.py'), 'line1\nline2\nline3\n');
  execSync('git add app.py', { cwd: work });
  execSync(
    `git -c user.name=Test -c user.email=test@test.com commit -m "$(cat <<'COMMITMSG'
init: add app.py

Session-Id: test-session-abc123
COMMITMSG
)"`,
    { cwd: work },
  );
  execSync('git push origin main || git push origin master', {
    cwd: work,
    stdio: 'pipe',
  });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('cloneRepo', () => {
  it('clones a repo to a temp directory', async () => {
    const cloneDir = await cloneRepo(BARE_REPO, 'testuser', 'testrepo');
    expect(fs.existsSync(path.join(cloneDir, 'app.py'))).toBe(true);
    cleanupClone(cloneDir);
  });

  it('clones with a specific commit checkout', async () => {
    // Get the commit SHA from the bare repo
    const sha = execSync('git log -1 --format=%H', { cwd: BARE_REPO })
      .toString()
      .trim();
    const cloneDir = await cloneRepo(BARE_REPO, 'testuser', 'testrepo', sha);
    expect(fs.existsSync(path.join(cloneDir, 'app.py'))).toBe(true);
    // Verify HEAD matches
    const head = execSync('git rev-parse HEAD', { cwd: cloneDir })
      .toString()
      .trim();
    expect(head).toBe(sha);
    cleanupClone(cloneDir);
  });
});

describe('blameLineForSessionId', () => {
  it('extracts Session-Id from blame commit', async () => {
    const cloneDir = await cloneRepo(BARE_REPO, 'testuser', 'testrepo');
    const result = blameLineForSessionId(cloneDir, 'app.py', 2);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('test-session-abc123');
    expect(result!.commitSha).toBeTruthy();
    cleanupClone(cloneDir);
  });

  it('returns null sessionId when no Session-Id trailer', async () => {
    // Add a new commit without Session-Id trailer
    const work = path.join(TEST_DIR, 'work');
    fs.writeFileSync(path.join(work, 'app.py'), 'changed\nline2\nline3\n');
    execSync('git add app.py', { cwd: work });
    execSync(
      'git -c user.name=Test -c user.email=test@test.com commit -m "fix: update line 1"',
      { cwd: work },
    );
    execSync('git push', { cwd: work, stdio: 'pipe' });

    const cloneDir = await cloneRepo(BARE_REPO, 'testuser', 'testrepo');
    const result = blameLineForSessionId(cloneDir, 'app.py', 1);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBeNull();
    cleanupClone(cloneDir);
  });

  it('returns null for nonexistent file', async () => {
    const cloneDir = await cloneRepo(BARE_REPO, 'testuser', 'testrepo');
    const result = blameLineForSessionId(cloneDir, 'nonexistent.py', 1);
    expect(result).toBeNull();
    cleanupClone(cloneDir);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/repo-cloner.test.ts`
Expected: FAIL — module does not exist

**Step 3: Write minimal implementation**

Create `src/repo-cloner.ts`:

```typescript
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const CLONE_BASE = '/tmp/nanoclaw-heal';

export interface BlameResult {
  commitSha: string;
  sessionId: string | null;
}

/**
 * Clone a repo to a temp directory. Returns the clone path.
 * Uses shallow clone (50 commits) for speed while retaining
 * enough history for `git blame`.
 */
export async function cloneRepo(
  repoUrl: string,
  user: string,
  repo: string,
  commit?: string,
): Promise<string> {
  const timestamp = Date.now();
  const cloneDir = path.join(CLONE_BASE, user, `${repo}-${timestamp}`);
  fs.mkdirSync(path.dirname(cloneDir), { recursive: true });

  logger.info({ repoUrl, cloneDir }, 'Cloning repo for reactive heal');

  execFileSync('git', ['clone', '--depth', '50', repoUrl, cloneDir], {
    timeout: 60_000,
    stdio: 'pipe',
  });

  if (commit) {
    try {
      execFileSync('git', ['checkout', commit], {
        cwd: cloneDir,
        timeout: 10_000,
        stdio: 'pipe',
      });
      logger.debug({ commit, cloneDir }, 'Checked out specific commit');
    } catch (e) {
      logger.debug(
        { commit, error: e },
        'Could not checkout commit, staying on default branch',
      );
    }
  }

  return cloneDir;
}

/**
 * Run `git blame` on a specific line and extract the Session-Id
 * trailer from the authoring commit.
 *
 * Returns null if the file doesn't exist or blame fails.
 */
export function blameLineForSessionId(
  repoDir: string,
  file: string,
  line: number,
): BlameResult | null {
  try {
    // Get blame commit SHA for the specific line
    const blameOutput = execFileSync(
      'git',
      ['blame', '-L', `${line},${line}`, '--porcelain', file],
      { cwd: repoDir, timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString();

    const commitSha = blameOutput.split(' ')[0];
    if (!commitSha || commitSha.length < 7) return null;

    // Extract Session-Id trailer from the commit
    let sessionId: string | null = null;
    try {
      const trailer = execFileSync(
        'git',
        [
          'log',
          '-1',
          '--format=%(trailers:key=Session-Id,valueonly)',
          commitSha,
        ],
        { cwd: repoDir, timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe'] },
      )
        .toString()
        .trim();

      sessionId = trailer || null;
    } catch (e) {
      logger.debug(
        { commitSha, error: e },
        'Could not extract Session-Id trailer',
      );
    }

    return { commitSha, sessionId };
  } catch (e) {
    logger.debug({ file, line, error: e }, 'git blame failed');
    return null;
  }
}

/**
 * Remove a cloned repo directory.
 */
export function cleanupClone(cloneDir: string): void {
  try {
    fs.rmSync(cloneDir, { recursive: true, force: true });
    logger.debug({ cloneDir }, 'Cleaned up cloned repo');
  } catch (e) {
    logger.debug({ cloneDir, error: e }, 'Failed to clean up cloned repo');
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/repo-cloner.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/repo-cloner.ts src/repo-cloner.test.ts
git commit -m "feat(healer): add repo cloner with blame + session ID extraction"
```

---

### Task 4: Reactive Heal Prompt Builder

Build the error-driven prompt from a `HealBatch`. This is distinct from the scheduled heal prompt — it includes specific error details, occurrence counts, and blame context.

**Files:**
- Create: `src/reactive-heal-prompt.ts`
- Create: `src/reactive-heal-prompt.test.ts`

**Step 1: Write the failing test**

Create `src/reactive-heal-prompt.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { buildReactiveHealPrompt } from './reactive-heal-prompt.js';
import type { HealBatch } from './types.js';

describe('buildReactiveHealPrompt', () => {
  const batch: HealBatch = {
    user: 'bjern',
    repo: 'datarake',
    repo_url: 'https://github.com/bjern/datarake',
    sourceChannelJid: 'dc:123456',
    entries: [
      {
        file: 'src/datarake/parqinglot.py',
        line: 305,
        error: "Client error '400 Bad Request'",
        traceback: 'File "src/datarake/parqinglot.py", line 305\n  resp.raise_for_status()',
        commit: 'a1b2c3d',
        occurrences: 12,
        blameCommit: 'f4e5d6c',
        sessionId: 'test-session-abc',
      },
      {
        file: 'src/datarake/client.py',
        line: 42,
        error: 'ConnectionTimeout',
        occurrences: 1,
      },
    ],
  };

  it('includes all errors with details', () => {
    const prompt = buildReactiveHealPrompt(batch, '/workspace/repo');
    expect(prompt).toContain('ERROR 1 (12 occurrences)');
    expect(prompt).toContain('src/datarake/parqinglot.py:305');
    expect(prompt).toContain("Client error '400 Bad Request'");
    expect(prompt).toContain('ERROR 2 (1 occurrence)');
    expect(prompt).toContain('src/datarake/client.py:42');
    expect(prompt).toContain('ConnectionTimeout');
  });

  it('includes blame and session context when available', () => {
    const prompt = buildReactiveHealPrompt(batch, '/workspace/repo');
    expect(prompt).toContain('f4e5d6c');
    expect(prompt).toContain('test-session-abc');
  });

  it('includes repo path and workflow instructions', () => {
    const prompt = buildReactiveHealPrompt(batch, '/workspace/repo');
    expect(prompt).toContain('/workspace/repo');
    expect(prompt).toContain('send_message');
    expect(prompt).toContain('heal/');
  });

  it('handles entries without optional fields', () => {
    const minimal: HealBatch = {
      ...batch,
      entries: [
        {
          file: 'app.py',
          line: 1,
          error: 'SomeError',
          occurrences: 1,
        },
      ],
    };
    const prompt = buildReactiveHealPrompt(minimal, '/workspace/repo');
    expect(prompt).toContain('app.py:1');
    expect(prompt).not.toContain('undefined');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/reactive-heal-prompt.test.ts`
Expected: FAIL — module does not exist

**Step 3: Write minimal implementation**

Create `src/reactive-heal-prompt.ts`:

```typescript
import type { HealBatch } from './types.js';

function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
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
        `ERROR ${i + 1} (${entry.occurrences} occurrence${entry.occurrences !== 1 ? 's' : ''}):`,
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

      return lines.join('\n');
    })
    .join('\n\n');

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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/reactive-heal-prompt.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/reactive-heal-prompt.ts src/reactive-heal-prompt.test.ts
git commit -m "feat(healer): add reactive heal prompt builder"
```

---

### Task 5: Debouncer

Per `user+repo` timer with batch collection, dedup, and timer reset. When the timer fires, it calls a callback with the finalized `HealBatch`.

**Files:**
- Modify: `src/reactive-healer.ts` (add debouncer)
- Modify: `src/reactive-healer.test.ts` (add debouncer tests)

**Step 1: Write the failing test**

Add to `src/reactive-healer.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HealBatch, HealRequest } from './types.js';
import { HealDebouncer, validateHealPayload } from './reactive-healer.js';

// ... (keep existing validateHealPayload tests) ...

describe('HealDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeRequest = (overrides: Partial<HealRequest> = {}): HealRequest => ({
    nanoclaw: 'heal',
    user: 'bjern',
    repo: 'datarake',
    repo_url: 'https://github.com/bjern/datarake',
    error: 'TestError',
    ...overrides,
  });

  it('fires callback after debounce window', async () => {
    const onBatch = vi.fn();
    const debouncer = new HealDebouncer(onBatch, 5000);

    debouncer.add(makeRequest({ file: 'a.py', line: 10 }), 'dc:123');

    // Not yet
    expect(onBatch).not.toHaveBeenCalled();

    // Advance past debounce window
    vi.advanceTimersByTime(5001);

    expect(onBatch).toHaveBeenCalledTimes(1);
    const batch: HealBatch = onBatch.mock.calls[0][0];
    expect(batch.user).toBe('bjern');
    expect(batch.repo).toBe('datarake');
    expect(batch.entries).toHaveLength(1);
    expect(batch.entries[0].file).toBe('a.py');
    expect(batch.entries[0].occurrences).toBe(1);

    debouncer.destroy();
  });

  it('resets timer on new error for same user+repo', async () => {
    const onBatch = vi.fn();
    const debouncer = new HealDebouncer(onBatch, 5000);

    debouncer.add(makeRequest({ error: 'Error1', file: 'a.py', line: 1 }), 'dc:123');

    // Advance 3s (not enough to fire)
    vi.advanceTimersByTime(3000);
    expect(onBatch).not.toHaveBeenCalled();

    // New error resets the timer
    debouncer.add(makeRequest({ error: 'Error2', file: 'b.py', line: 2 }), 'dc:123');

    // Advance another 3s (6s total, but only 3s since last add)
    vi.advanceTimersByTime(3000);
    expect(onBatch).not.toHaveBeenCalled();

    // Advance to 5s after last add
    vi.advanceTimersByTime(2001);
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onBatch.mock.calls[0][0].entries).toHaveLength(2);

    debouncer.destroy();
  });

  it('deduplicates same file+line+error', async () => {
    const onBatch = vi.fn();
    const debouncer = new HealDebouncer(onBatch, 5000);

    const req = makeRequest({ error: 'Same', file: 'a.py', line: 10 });
    debouncer.add(req, 'dc:123');
    debouncer.add(req, 'dc:123');
    debouncer.add(req, 'dc:123');

    vi.advanceTimersByTime(5001);

    expect(onBatch).toHaveBeenCalledTimes(1);
    const batch: HealBatch = onBatch.mock.calls[0][0];
    expect(batch.entries).toHaveLength(1);
    expect(batch.entries[0].occurrences).toBe(3);

    debouncer.destroy();
  });

  it('keeps separate timers for different user+repo', async () => {
    const onBatch = vi.fn();
    const debouncer = new HealDebouncer(onBatch, 5000);

    debouncer.add(makeRequest({ user: 'bjern', repo: 'datarake' }), 'dc:123');
    debouncer.add(makeRequest({ user: 'alice', repo: 'api' }), 'dc:456');

    vi.advanceTimersByTime(5001);

    expect(onBatch).toHaveBeenCalledTimes(2);

    debouncer.destroy();
  });

  it('uses traceback to extract file+line when not provided', async () => {
    const onBatch = vi.fn();
    const debouncer = new HealDebouncer(onBatch, 5000);

    debouncer.add(
      makeRequest({
        traceback: 'File "src/app.py", line 42, in main\n  crash()',
        file: undefined,
        line: undefined,
      }),
      'dc:123',
    );

    vi.advanceTimersByTime(5001);

    const batch: HealBatch = onBatch.mock.calls[0][0];
    expect(batch.entries[0].file).toBe('src/app.py');
    expect(batch.entries[0].line).toBe(42);

    debouncer.destroy();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/reactive-healer.test.ts`
Expected: FAIL — `HealDebouncer` does not exist

**Step 3: Write implementation**

Add to `src/reactive-healer.ts`:

```typescript
import { logger } from './logger.js';
import { parseTraceback } from './traceback-parser.js';
import type { HealBatch, HealBatchEntry, HealRequest } from './types.js';

// ... (keep existing validateHealPayload code) ...

interface PendingBatch {
  user: string;
  repo: string;
  repo_url: string;
  sourceChannelJid: string;
  entries: Map<string, HealBatchEntry>; // keyed by "file:line:error"
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

export class HealDebouncer {
  private batches = new Map<string, PendingBatch>(); // keyed by "user:repo"
  private onBatch: (batch: HealBatch) => void;
  private debounceMs: number;

  constructor(
    onBatch: (batch: HealBatch) => void,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  ) {
    this.onBatch = onBatch;
    this.debounceMs = debounceMs;
  }

  add(request: HealRequest, sourceChannelJid: string): void {
    const key = `${request.user}:${request.repo}`;

    let batch = this.batches.get(key);
    if (batch) {
      // Reset timer
      clearTimeout(batch.timer);
    } else {
      batch = {
        user: request.user,
        repo: request.repo,
        repo_url: request.repo_url,
        sourceChannelJid,
        entries: new Map(),
        timer: null as any,
      };
      this.batches.set(key, batch);
    }

    // Resolve file + line: use explicit fields, fall back to traceback parsing
    let file = request.file;
    let line = request.line;
    if ((!file || !line) && request.traceback) {
      const frames = parseTraceback(request.traceback);
      if (frames.length > 0) {
        file = file || frames[0].file;
        line = line || frames[0].line;
      }
    }

    // Default to 'unknown' if we still can't determine location
    file = file || 'unknown';
    line = line || 0;

    // Dedup key: same file + line + error message
    const entryKey = `${file}:${line}:${request.error}`;
    const existing = batch.entries.get(entryKey);
    if (existing) {
      existing.occurrences++;
    } else {
      batch.entries.set(entryKey, {
        file,
        line,
        error: request.error,
        traceback: request.traceback,
        commit: request.commit,
        occurrences: 1,
      });
    }

    // (Re)start timer
    batch.timer = setTimeout(() => this.fire(key), this.debounceMs);

    logger.debug(
      { key, entryCount: batch.entries.size },
      'Added error to reactive heal batch',
    );
  }

  private fire(key: string): void {
    const batch = this.batches.get(key);
    if (!batch) return;

    this.batches.delete(key);

    const healBatch: HealBatch = {
      user: batch.user,
      repo: batch.repo,
      repo_url: batch.repo_url,
      sourceChannelJid: batch.sourceChannelJid,
      entries: Array.from(batch.entries.values()),
    };

    logger.info(
      {
        user: healBatch.user,
        repo: healBatch.repo,
        entries: healBatch.entries.length,
      },
      'Debounce timer fired, dispatching reactive heal batch',
    );

    this.onBatch(healBatch);
  }

  destroy(): void {
    for (const batch of this.batches.values()) {
      clearTimeout(batch.timer);
    }
    this.batches.clear();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/reactive-healer.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/reactive-healer.ts src/reactive-healer.test.ts
git commit -m "feat(healer): add debouncer with timer reset and dedup"
```

---

### Task 6: DB Helper — getUserProfileByLinuxUsername

The reactive healer receives a Linux username in the payload and needs to look up the user profile. No such function exists in `db.ts`.

**Files:**
- Modify: `src/db.ts` (add function after `getUserProfileByDiscordId` at line 694)

**Step 1: Write the failing test**

The `db.test.ts` file exists. Add a test for the new function. However, since this is a one-liner following the exact same pattern as `getUserProfileByDiscordId` (line 687-694), and the column `linux_username` already exists in the table, this can be done without a separate test file — add it inline.

Actually, the simplest approach: just add the function. It follows the identical pattern of `getUserProfileByDiscordId`, just querying a different column.

**Step 2: Add the function**

After `getUserProfileByDiscordId` (line 694) in `src/db.ts`:

```typescript
export function getUserProfileByLinuxUsername(
  linuxUsername: string,
): UserProfile | undefined {
  const row = db
    .prepare('SELECT * FROM user_profiles WHERE linux_username = ?')
    .get(linuxUsername) as UserProfileRow | undefined;
  return row ? rowToUserProfile(row) : undefined;
}
```

**Step 3: Run existing tests to verify no regressions**

Run: `npx vitest run src/db.test.ts`
Expected: All existing tests PASS

**Step 4: Commit**

```bash
git add src/db.ts
git commit -m "feat(db): add getUserProfileByLinuxUsername lookup"
```

---

### Task 7: Orchestrator — Wire Everything Together

The orchestrator ties together: contract validation → debouncer → clone → blame → prompt → container spawn → cleanup. It also provides the `handleHealPayload()` function that the Discord channel handler will call.

**Files:**
- Modify: `src/reactive-healer.ts` (add orchestrator)
- Modify: `src/reactive-healer.test.ts` (add orchestrator tests)

**Step 1: Write the test**

Add to `src/reactive-healer.test.ts`:

```typescript
import { vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

// ... (existing tests) ...

describe('extractHealPayload', () => {
  it('extracts JSON from a code block', () => {
    const content = 'some text\n```json\n{"nanoclaw":"heal","user":"bjern","repo":"dr","repo_url":"https://x","error":"e"}\n```\nmore text';
    const result = extractHealPayload(content);
    expect(result).not.toBeNull();
    expect(result!.nanoclaw).toBe('heal');
  });

  it('extracts JSON from plain text', () => {
    const content = '{"nanoclaw":"heal","user":"bjern","repo":"dr","repo_url":"https://x","error":"e"}';
    const result = extractHealPayload(content);
    expect(result).not.toBeNull();
  });

  it('returns null for non-heal JSON', () => {
    const content = '```json\n{"type":"other"}\n```';
    expect(extractHealPayload(content)).toBeNull();
  });

  it('returns null for no JSON', () => {
    expect(extractHealPayload('just a message')).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/reactive-healer.test.ts`
Expected: FAIL — `extractHealPayload` does not exist

**Step 3: Write implementation**

Add to `src/reactive-healer.ts`:

```typescript
import { getUserProfileByLinuxUsername } from './db.js';
import { blameLineForSessionId, cleanupClone, cloneRepo } from './repo-cloner.js';
import { buildReactiveHealPrompt } from './reactive-heal-prompt.js';
import { runContainerAgent } from './container-runner.js';
import type { RegisteredGroup } from './types.js';
import type { GroupQueue } from './group-queue.js';
import type { ChildProcess } from 'child_process';

// ... (existing code) ...

/**
 * Extract a heal JSON payload from a Discord message.
 * Checks for JSON code blocks (```json ... ```) and plain JSON objects
 * containing `"nanoclaw": "heal"`.
 */
export function extractHealPayload(content: string): Record<string, unknown> | null {
  // Try code block first
  const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]);
      if (parsed?.nanoclaw === 'heal') return parsed;
    } catch (e) {
      // Not valid JSON in code block
    }
  }

  // Try plain JSON (find first { ... } containing "nanoclaw")
  const jsonMatch = content.match(/\{[^{}]*"nanoclaw"\s*:\s*"heal"[^{}]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      // Malformed
    }
  }

  return null;
}

export interface ReactiveHealerDeps {
  queue: GroupQueue;
  sendMessage: (jid: string, text: string) => Promise<void>;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
}

/**
 * Create the reactive healer instance. Returns:
 * - `handleMessage(content, channelJid)` — call from Discord handler
 * - `destroy()` — cleanup timers on shutdown
 */
export function createReactiveHealer(deps: ReactiveHealerDeps) {
  const debouncer = new HealDebouncer((batch) => {
    // Enqueue as a task on the GroupQueue, keyed by the source channel JID.
    // Using channel JID as the "group" ensures reactive heals respect
    // per-channel concurrency and don't stampede.
    const taskId = `reactive-heal-${batch.user}-${batch.repo}-${Date.now()}`;

    deps.queue.enqueueTask(batch.sourceChannelJid, taskId, () =>
      executeReactiveHeal(batch, deps),
    );
  });

  return {
    handleMessage(content: string, channelJid: string): boolean {
      const raw = extractHealPayload(content);
      if (!raw) return false;

      const validation = validateHealPayload(raw);
      if (!validation.ok) {
        logger.warn(
          { error: validation.error },
          'Invalid heal payload received',
        );
        deps
          .sendMessage(
            channelJid,
            `Invalid heal request: ${validation.error}`,
          )
          .catch((e) => logger.debug({ error: e }, 'Failed to send validation error'));
        return true; // consumed the message (even though invalid)
      }

      debouncer.add(validation.request, channelJid);
      return true; // consumed
    },

    destroy() {
      debouncer.destroy();
    },
  };
}

async function executeReactiveHeal(
  batch: HealBatch,
  deps: ReactiveHealerDeps,
): Promise<void> {
  const startTime = Date.now();

  // 1. Resolve user profile
  const profile = getUserProfileByLinuxUsername(batch.user);
  if (!profile) {
    logger.error({ user: batch.user }, 'Unknown user for reactive heal');
    await deps.sendMessage(
      batch.sourceChannelJid,
      `Unknown user \`${batch.user}\` — register with the bot first.`,
    );
    return;
  }

  // 2. Clone the repo
  let cloneDir: string;
  try {
    cloneDir = await cloneRepo(
      batch.repo_url,
      batch.user,
      batch.repo,
      batch.entries[0]?.commit,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ error: msg, repo: batch.repo_url }, 'Failed to clone repo');
    await deps.sendMessage(
      batch.sourceChannelJid,
      `Failed to clone \`${batch.repo}\`: ${msg}`,
    );
    return;
  }

  try {
    // 3. Trace errors — run git blame for each entry
    let primarySessionId: string | undefined;
    for (const entry of batch.entries) {
      if (entry.file && entry.file !== 'unknown' && entry.line > 0) {
        const blame = blameLineForSessionId(cloneDir, entry.file, entry.line);
        if (blame) {
          entry.blameCommit = blame.commitSha;
          if (blame.sessionId) {
            entry.sessionId = blame.sessionId;
            // Use the first session ID found as the primary session to resume
            if (!primarySessionId) {
              primarySessionId = blame.sessionId;
            }
          }
        }
      }
    }

    // 4. Build prompt
    const prompt = buildReactiveHealPrompt(batch, `/workspace/extra/${batch.repo}`);

    // 5. Build a temporary RegisteredGroup for the container
    const group: RegisteredGroup = {
      name: `reactive-heal-${batch.user}-${batch.repo}`,
      folder: `reactive-heal-${batch.user}`,
      trigger: /.*/,
      added_at: new Date().toISOString(),
      containerConfig: {
        userProfileId: profile.id,
        additionalMounts: [
          {
            hostPath: cloneDir,
            containerPath: batch.repo,
            readonly: false,
          },
        ],
      },
    };

    // 6. Spawn container
    logger.info(
      {
        user: batch.user,
        repo: batch.repo,
        entries: batch.entries.length,
        sessionId: primarySessionId || 'new',
      },
      'Spawning reactive heal container',
    );

    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId: primarySessionId,
        groupFolder: group.folder,
        chatJid: batch.sourceChannelJid,
        isMain: false,
        isScheduledTask: true,
        assistantName: 'NanoClaw Healer',
      },
      (proc, containerName) =>
        deps.onProcess(
          batch.sourceChannelJid,
          proc,
          containerName,
          group.folder,
        ),
      async (streamedOutput) => {
        if (streamedOutput.result) {
          await deps.sendMessage(batch.sourceChannelJid, streamedOutput.result);
        }
      },
    );

    if (output.status === 'error') {
      logger.error(
        { error: output.error, repo: batch.repo },
        'Reactive heal container failed',
      );
    }

    logger.info(
      {
        user: batch.user,
        repo: batch.repo,
        durationMs: Date.now() - startTime,
        status: output.status,
      },
      'Reactive heal completed',
    );
  } finally {
    // 7. Cleanup
    cleanupClone(cloneDir);
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/reactive-healer.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/reactive-healer.ts src/reactive-healer.test.ts
git commit -m "feat(healer): add orchestrator with clone, blame, and container spawn"
```

---

### Task 8: Discord Channel Integration

Wire the reactive healer into the Discord message handler. Check for heal payloads early in the handler, before the registered-group check. Heal payloads from ANY channel are processed (not just registered groups).

**Files:**
- Modify: `src/channels/discord.ts`
- Modify: `src/channels/registry.ts` (add reactive healer to `ChannelOpts`)
- Modify: `src/index.ts` (pass reactive healer instance to channel opts)

**Step 1: Add `onHealPayload` to `ChannelOpts`**

In `src/channels/registry.ts`, add to the `ChannelOpts` interface:

```typescript
export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onHealPayload?: (content: string, channelJid: string) => boolean;
}
```

**Step 2: Add heal payload check in Discord handler**

In `src/channels/discord.ts`, after the bot-mention handling (line 93) and before the registered-group check (line 145), add:

```typescript
      // Check for reactive heal payload before normal routing.
      // Heal payloads are accepted from ANY channel, not just registered groups.
      if (this.opts.onHealPayload?.(content, chatJid)) {
        logger.info(
          { chatJid, chatName, sender: senderName },
          'Heal payload intercepted',
        );
        return;
      }
```

Insert this after the attachment handling block (after line 132) and before the `opts.onChatMetadata()` call (line 136). The heal check should run after content is fully assembled (mentions resolved, attachments appended) but before routing to the normal message flow.

**Step 3: Wire reactive healer in `src/index.ts`**

After the `channelOpts` object (around line 576), add the reactive healer:

```typescript
import { createReactiveHealer } from './reactive-healer.js';

// ... in main(), after queue is created and before channels are initialized ...

const reactiveHealer = createReactiveHealer({
  queue,
  sendMessage: async (jid, text) => {
    for (const ch of channels) {
      if (ch.ownsJid(jid)) {
        await ch.sendMessage(jid, text);
        return;
      }
    }
  },
  onProcess: (groupJid, proc, containerName, groupFolder) => {
    queue.registerProcess(groupJid, proc, containerName, groupFolder);
  },
});
```

Add `onHealPayload` to `channelOpts`:

```typescript
const channelOpts = {
  // ... existing fields ...
  onHealPayload: (content: string, channelJid: string) =>
    reactiveHealer.handleMessage(content, channelJid),
};
```

**Step 4: Build to verify no type errors**

Run: `npm run build`
Expected: Clean compilation

**Step 5: Commit**

```bash
git add src/channels/discord.ts src/channels/registry.ts src/index.ts
git commit -m "feat(healer): wire reactive healer into Discord message handler"
```

---

### Task 9: Integration Test — Full Flow

Write a test that exercises the full flow: payload extraction → validation → debounce → batch callback. The container spawn and git operations are mocked.

**Files:**
- Modify: `src/reactive-healer.test.ts`

**Step 1: Write the integration test**

Add to `src/reactive-healer.test.ts`:

```typescript
describe('createReactiveHealer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('processes a valid heal message and fires debounced batch', () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const enqueueTask = vi.fn();
    const queue = { enqueueTask } as any;

    const healer = createReactiveHealer({
      queue,
      sendMessage,
      onProcess: vi.fn(),
    });

    const content = '```json\n{"nanoclaw":"heal","user":"bjern","repo":"datarake","repo_url":"https://github.com/bjern/datarake","error":"400 Bad Request","file":"app.py","line":10}\n```';

    const consumed = healer.handleMessage(content, 'dc:123');
    expect(consumed).toBe(true);

    // Debounce hasn't fired yet
    expect(enqueueTask).not.toHaveBeenCalled();

    // Fire the debounce
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(enqueueTask.mock.calls[0][0]).toBe('dc:123');

    healer.destroy();
  });

  it('rejects invalid payload and sends error to channel', () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const queue = { enqueueTask: vi.fn() } as any;

    const healer = createReactiveHealer({
      queue,
      sendMessage,
      onProcess: vi.fn(),
    });

    const content = '```json\n{"nanoclaw":"heal","user":"bjern"}\n```';
    const consumed = healer.handleMessage(content, 'dc:123');
    expect(consumed).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      'dc:123',
      expect.stringContaining('Invalid heal request'),
    );

    healer.destroy();
  });

  it('ignores non-heal messages', () => {
    const healer = createReactiveHealer({
      queue: { enqueueTask: vi.fn() } as any,
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onProcess: vi.fn(),
    });

    expect(healer.handleMessage('hello world', 'dc:123')).toBe(false);
    expect(healer.handleMessage('{"type":"other"}', 'dc:123')).toBe(false);

    healer.destroy();
  });
});
```

**Step 2: Run all reactive healer tests**

Run: `npx vitest run src/reactive-healer.test.ts`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add src/reactive-healer.test.ts
git commit -m "test(healer): add integration tests for reactive healer flow"
```

---

### Task 10: Documentation

Update `docs/CODE-HEALER.md` with the reactive healing section and notification contract. Update `CLAUDE.md` key files table.

**Files:**
- Modify: `docs/CODE-HEALER.md`
- Modify: `CLAUDE.md`

**Step 1: Add reactive healing section to `docs/CODE-HEALER.md`**

Append a new section:

```markdown
## Reactive Healing

In addition to scheduled healing, NanoClaw can respond to errors in real-time. When a structured error notification appears in a Discord channel, the reactive healer:

1. Debounces errors (5-min window per user+repo, timer resets on each new error)
2. Clones the repo on demand
3. Traces errors to source via `git blame`
4. Optionally resumes the Claude session that authored the code (via `Session-Id` commit trailer)
5. Creates fix branches + PRs
6. Posts results back to the originating Discord channel

### Notification Contract

Send a JSON payload to any Discord channel the bot can read:

\`\`\`json
{
  "nanoclaw": "heal",
  "user": "bjern",
  "repo": "datarake",
  "repo_url": "https://github.com/bjern/datarake",
  "error": "Client error '400 Bad Request' for url '...'",
  "traceback": "File \"src/app.py\", line 305, in handler\n    resp.raise_for_status()",
  "file": "src/app.py",
  "line": 305,
  "commit": "a1b2c3d",
  "severity": "error"
}
\`\`\`

| Field | Required | Purpose |
|-------|----------|---------|
| `nanoclaw` | yes | Must be `"heal"` |
| `user` | yes | Linux username — maps to user profile |
| `repo` | yes | Repo name — for dedup and display |
| `repo_url` | yes | Clone URL |
| `error` | yes | Error message |
| `traceback` | no | Stack trace (Python/Node.js) |
| `file` | no | Source file — can be extracted from traceback |
| `line` | no | Line number — can be extracted from traceback |
| `commit` | no | Deployed commit SHA |
| `severity` | no | `"error"` (default) or `"warning"` |

### Session-Id Convention

To enable session resumption, add a `Session-Id` trailer to commit messages:

\`\`\`
fix: handle null response in parser

Session-Id: c7e0c991-4c19-46c5-9def-ea609efb5c8e
\`\`\`

The healer uses `git blame` to find the authoring commit, then extracts the `Session-Id` trailer to resume the original Claude session.
```

**Step 2: Update `CLAUDE.md` key files table**

Add these rows to the Key Files table:

```markdown
| `src/reactive-healer.ts` | Reactive heal: interceptor, debouncer, validator, orchestrator |
| `src/traceback-parser.ts` | Extract file+line from Python/Node.js traces |
| `src/repo-cloner.ts` | Clone repos, git blame, Session-Id extraction |
| `src/reactive-heal-prompt.ts` | Error-driven heal prompt builder |
```

**Step 3: Commit**

```bash
git add docs/CODE-HEALER.md CLAUDE.md
git commit -m "docs: add reactive healing contract and key files"
```

---

### Task 11: Final Verification

Run the full test suite and build to verify everything works together.

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

**Step 2: Build**

Run: `npm run build`
Expected: Clean compilation with no errors

**Step 3: Fix any issues**

If tests fail or build errors occur, fix them and re-run.

**Step 4: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address test/build issues from reactive healer integration"
```

---

Plan complete and saved to `docs/plans/2026-03-30-reactive-healer-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
