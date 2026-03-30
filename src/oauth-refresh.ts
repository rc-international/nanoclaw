/**
 * OAuth token refresh for Claude Code credentials.
 *
 * Claude Max subscriptions use OAuth tokens stored in ~/.claude/.credentials.json.
 * Access tokens expire after ~8 hours. This module delegates token refresh to the
 * `claude` CLI, which handles the OAuth exchange internally (the platform endpoint
 * rejects third-party refresh requests).
 *
 * To force the CLI to refresh proactively (before its internal 5-min buffer),
 * we temporarily set expiresAt to near-now in the credentials file. The CLI sees
 * the token as near-expiry, refreshes it, and writes the new token back.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

/** 5 minutes — refresh when token expires within this window. */
const DEFAULT_BUFFER_MS = 5 * 60 * 1000;

export interface TokenState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/**
 * Resolve the path to the credentials file for a given home directory.
 */
export function credentialsPath(homeDir?: string): string {
  return path.join(homeDir || os.homedir(), '.claude', '.credentials.json');
}

/**
 * Read the current token state from the credentials file.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function readTokenState(homeDir?: string): TokenState | null {
  try {
    const raw = fs.readFileSync(credentialsPath(homeDir), 'utf-8');
    const creds = JSON.parse(raw);
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.accessToken || !oauth?.refreshToken || !oauth?.expiresAt) {
      return null;
    }
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
    };
  } catch (e) {
    logger.debug({ error: e }, 'Failed to read token state');
    return null;
  }
}

/**
 * Force a token refresh by temporarily setting expiresAt to near-now in the
 * credentials file, then running `claude auth status` which triggers the CLI's
 * internal refresh. Restores the original expiresAt on failure.
 */
function cliRefresh(cPath: string, homeDir?: string): Promise<void> {
  // Read current credentials
  const raw = fs.readFileSync(cPath, 'utf-8');
  const creds = JSON.parse(raw);
  const originalExpiresAt = creds.claudeAiOauth.expiresAt;

  // Set expiresAt to 1 minute from now — within the CLI's 5-min buffer,
  // which will trigger its internal refresh
  creds.claudeAiOauth.expiresAt = Date.now() + 60 * 1000;
  const tmpPath = `${cPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, cPath);

  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { ...process.env } as Record<
      string,
      string
    >;
    if (homeDir) {
      env.HOME = homeDir;
    }
    // Don't inherit Claude Code session vars that might interfere
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const proc = execFile(
      'claude',
      ['-p', 'ok', '--max-turns', '1'],
      {
        env,
        timeout: 30_000,
      },
      (err, _stdout, stderr) => {
        if (err) {
          // Restore original expiresAt on failure
          try {
            const current = JSON.parse(fs.readFileSync(cPath, 'utf-8'));
            current.claudeAiOauth.expiresAt = originalExpiresAt;
            const tmp = `${cPath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(current, null, 2), {
              mode: 0o600,
            });
            fs.renameSync(tmp, cPath);
          } catch (restoreErr) {
            logger.debug(
              { error: restoreErr },
              'Failed to restore expiresAt after CLI error',
            );
          }
          reject(
            new Error(
              `CLI token refresh failed: ${err.message}${stderr ? ` (stderr: ${stderr.slice(0, 200)})` : ''}`,
            ),
          );
          return;
        }
        resolve();
      },
    );
    proc.unref();
  });
}

// Concurrency guard: deduplicate simultaneous refresh attempts per creds path
const inflight = new Map<
  string,
  Promise<{ refreshed: boolean; error?: string }>
>();

/**
 * Ensure the OAuth access token is fresh. If the token expires within
 * `bufferMs`, refresh it by invoking the `claude` CLI (which handles
 * the OAuth exchange internally).
 *
 * Safe to call concurrently — only one refresh per credentials file
 * will be in-flight at a time.
 *
 * @returns Whether a refresh was performed, and any error message.
 */
export async function ensureFreshToken(
  homeDir?: string,
  bufferMs = DEFAULT_BUFFER_MS,
): Promise<{ refreshed: boolean; error?: string }> {
  const cPath = credentialsPath(homeDir);

  // Deduplicate concurrent calls for the same credentials file
  const existing = inflight.get(cPath);
  if (existing) return existing;

  const promise = doRefresh(cPath, homeDir, bufferMs);
  inflight.set(cPath, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(cPath);
  }
}

async function doRefresh(
  cPath: string,
  homeDir: string | undefined,
  bufferMs: number,
): Promise<{ refreshed: boolean; error?: string }> {
  let state: TokenState | null;
  try {
    const raw = fs.readFileSync(cPath, 'utf-8');
    const creds = JSON.parse(raw);
    const oauth = creds?.claudeAiOauth;
    state =
      oauth?.accessToken && oauth?.refreshToken && oauth?.expiresAt
        ? {
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken,
            expiresAt: oauth.expiresAt,
          }
        : null;
  } catch (e) {
    logger.debug({ error: e }, 'Cannot read credentials');
    return { refreshed: false, error: `Cannot read credentials at ${cPath}` };
  }

  if (!state) {
    return { refreshed: false, error: 'No OAuth credentials found' };
  }

  if (!state.refreshToken) {
    return { refreshed: false, error: 'No refresh token available' };
  }

  // Token is still fresh — nothing to do
  if (state.expiresAt > Date.now() + bufferMs) {
    return { refreshed: false };
  }

  try {
    await cliRefresh(cPath, homeDir);

    // Verify the CLI actually updated the token
    const after = readTokenState(homeDir);
    if (after && after.expiresAt > state.expiresAt) {
      logger.info('OAuth access token refreshed via CLI');
      return { refreshed: true };
    }

    // CLI ran but token didn't change — may indicate silent failure
    logger.warn('CLI ran but token expiry unchanged — refresh may have failed');
    return {
      refreshed: false,
      error: 'Token expiry unchanged after CLI refresh',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'OAuth token refresh failed');
    return { refreshed: false, error: msg };
  }
}
