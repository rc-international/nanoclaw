import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  blameLineForSessionId,
  cleanupClone,
  cloneRepo,
} from './repo-cloner.js';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

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
    const work = path.join(TEST_DIR, 'work');
    const sha = execSync('git log -1 --format=%H', { cwd: work })
      .toString()
      .trim();
    const cloneDir = await cloneRepo(BARE_REPO, 'testuser', 'testrepo', sha);
    expect(fs.existsSync(path.join(cloneDir, 'app.py'))).toBe(true);
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
    expect(result?.sessionId).toBe('test-session-abc123');
    expect(result?.commitSha).toBeTruthy();
    cleanupClone(cloneDir);
  });

  it('returns null sessionId when no Session-Id trailer', async () => {
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
    expect(result?.sessionId).toBeNull();
    cleanupClone(cloneDir);
  });

  it('returns null for nonexistent file', async () => {
    const cloneDir = await cloneRepo(BARE_REPO, 'testuser', 'testrepo');
    const result = blameLineForSessionId(cloneDir, 'nonexistent.py', 1);
    expect(result).toBeNull();
    cleanupClone(cloneDir);
  });
});
