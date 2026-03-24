# Code Healer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Multi-user automated code analysis and repair — NanoClaw pulls remote logs, analyzes code, creates fix branches with PRs, and reports via Discord DM.

**Architecture:** User profiles map Discord users to Linux accounts. Per-user credential proxies on ephemeral ports provide OAuth isolation. A pre-task log sync fetches today's logs via Tailscale SSH. The heal prompt generator builds inspection-specific prompts. A container skill guides the agent through branch → fix → commit → PR → summary.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, Tailscale SSH, gh CLI, Claude Agent SDK

**Design doc:** `docs/plans/2026-03-24-code-healer-design.md`

---

## Task 1: Types — Data Model

**Files:**
- Modify: `src/types.ts` (append after line 108)

**Step 1: Add the type definitions**

Add to `src/types.ts` after the existing types:

```typescript
// --- Code Healer types ---

export type InspectionType = 'log-analysis' | 'code-review' | 'security-review';

export interface RepoConfig {
  name: string;
  localPath: string;
  inspectionTypes: InspectionType[];
  schedule: string; // cron expression, default "0 23 * * *"
  healBranchPrefix: string; // default "heal/"
}

export interface RemoteLogSource {
  name: string;
  host: string; // Tailscale hostname or IP
  logPath: string; // Remote path, e.g., "/var/log/api/"
  logPattern: string; // Glob, e.g., "*.log"
  linkedRepo: string; // RepoConfig.name
}

export interface UserProfile {
  id: string;
  discordUserId: string;
  linuxUsername: string;
  uid: number;
  gid: number;
  homeDir: string;
  repos: RepoConfig[];
  remoteSources: RemoteLogSource[];
  createdAt: string;
}
```

**Step 2: Run the build to verify types compile**

Run: `npm run build`
Expected: No errors

**Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(healer): add UserProfile, RepoConfig, RemoteLogSource types"
```

---

## Task 2: Database — user_profiles Table

**Files:**
- Modify: `src/db.ts`
- Modify: `src/db.test.ts`

**Step 1: Write failing tests for user profile CRUD**

Add to `src/db.test.ts`:

```typescript
import {
  // ... existing imports ...
  getUserProfile,
  getUserProfileByDiscordId,
  setUserProfile,
  deleteUserProfile,
  getAllUserProfiles,
} from './db.js';
import { UserProfile } from './types.js';

const testProfile: UserProfile = {
  id: 'prof-1',
  discordUserId: '123456789',
  linuxUsername: 'alice',
  uid: 1001,
  gid: 1001,
  homeDir: '/home/alice',
  repos: [
    {
      name: 'api',
      localPath: '/home/alice/projects/api',
      inspectionTypes: ['log-analysis'],
      schedule: '0 23 * * *',
      healBranchPrefix: 'heal/',
    },
  ],
  remoteSources: [
    {
      name: 'prod-api',
      host: '100.84.112.81',
      logPath: '/var/log/api/',
      logPattern: '*.log',
      linkedRepo: 'api',
    },
  ],
  createdAt: '2026-03-24T00:00:00.000Z',
};

describe('user profiles', () => {
  it('stores and retrieves a profile by id', () => {
    setUserProfile(testProfile);
    const result = getUserProfile('prof-1');
    expect(result).toEqual(testProfile);
  });

  it('retrieves a profile by Discord user ID', () => {
    setUserProfile(testProfile);
    const result = getUserProfileByDiscordId('123456789');
    expect(result).toEqual(testProfile);
  });

  it('returns undefined for missing profile', () => {
    expect(getUserProfile('nonexistent')).toBeUndefined();
    expect(getUserProfileByDiscordId('000')).toBeUndefined();
  });

  it('updates an existing profile', () => {
    setUserProfile(testProfile);
    const updated = { ...testProfile, repos: [] };
    setUserProfile(updated);
    const result = getUserProfile('prof-1');
    expect(result?.repos).toEqual([]);
  });

  it('deletes a profile', () => {
    setUserProfile(testProfile);
    deleteUserProfile('prof-1');
    expect(getUserProfile('prof-1')).toBeUndefined();
  });

  it('lists all profiles', () => {
    setUserProfile(testProfile);
    const bob = { ...testProfile, id: 'prof-2', discordUserId: '987', linuxUsername: 'bob' };
    setUserProfile(bob);
    const all = getAllUserProfiles();
    expect(all).toHaveLength(2);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db.test.ts`
Expected: FAIL — functions not exported

**Step 3: Add user_profiles table and CRUD to db.ts**

In `createSchema()`, add the table creation (after the `sessions` table):

```typescript
    CREATE TABLE IF NOT EXISTS user_profiles (
      id TEXT PRIMARY KEY,
      discord_user_id TEXT UNIQUE NOT NULL,
      linux_username TEXT NOT NULL,
      uid INTEGER NOT NULL,
      gid INTEGER NOT NULL,
      home_dir TEXT NOT NULL,
      repos TEXT NOT NULL DEFAULT '[]',
      remote_sources TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_discord
      ON user_profiles(discord_user_id);
```

Add CRUD functions after the session accessors:

```typescript
// --- User profile accessors ---

export function getUserProfile(id: string): UserProfile | undefined {
  const row = db
    .prepare('SELECT * FROM user_profiles WHERE id = ?')
    .get(id) as {
      id: string;
      discord_user_id: string;
      linux_username: string;
      uid: number;
      gid: number;
      home_dir: string;
      repos: string;
      remote_sources: string;
      created_at: string;
    } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    discordUserId: row.discord_user_id,
    linuxUsername: row.linux_username,
    uid: row.uid,
    gid: row.gid,
    homeDir: row.home_dir,
    repos: JSON.parse(row.repos),
    remoteSources: JSON.parse(row.remote_sources),
    createdAt: row.created_at,
  };
}

export function getUserProfileByDiscordId(discordUserId: string): UserProfile | undefined {
  const row = db
    .prepare('SELECT * FROM user_profiles WHERE discord_user_id = ?')
    .get(discordUserId) as {
      id: string;
      discord_user_id: string;
      linux_username: string;
      uid: number;
      gid: number;
      home_dir: string;
      repos: string;
      remote_sources: string;
      created_at: string;
    } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    discordUserId: row.discord_user_id,
    linuxUsername: row.linux_username,
    uid: row.uid,
    gid: row.gid,
    homeDir: row.home_dir,
    repos: JSON.parse(row.repos),
    remoteSources: JSON.parse(row.remote_sources),
    createdAt: row.created_at,
  };
}

export function setUserProfile(profile: UserProfile): void {
  db.prepare(
    `INSERT OR REPLACE INTO user_profiles
     (id, discord_user_id, linux_username, uid, gid, home_dir, repos, remote_sources, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    profile.id,
    profile.discordUserId,
    profile.linuxUsername,
    profile.uid,
    profile.gid,
    profile.homeDir,
    JSON.stringify(profile.repos),
    JSON.stringify(profile.remoteSources),
    profile.createdAt,
  );
}

export function deleteUserProfile(id: string): void {
  db.prepare('DELETE FROM user_profiles WHERE id = ?').run(id);
}

export function getAllUserProfiles(): UserProfile[] {
  const rows = db
    .prepare('SELECT * FROM user_profiles ORDER BY created_at')
    .all() as Array<{
      id: string;
      discord_user_id: string;
      linux_username: string;
      uid: number;
      gid: number;
      home_dir: string;
      repos: string;
      remote_sources: string;
      created_at: string;
    }>;
  return rows.map((row) => ({
    id: row.id,
    discordUserId: row.discord_user_id,
    linuxUsername: row.linux_username,
    uid: row.uid,
    gid: row.gid,
    homeDir: row.home_dir,
    repos: JSON.parse(row.repos),
    remoteSources: JSON.parse(row.remote_sources),
    createdAt: row.created_at,
  }));
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/db.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(healer): add user_profiles table with CRUD operations"
```

---

## Task 3: User Profile — Registration and /etc/passwd Lookup

**Files:**
- Create: `src/user-profile.ts`
- Create: `src/user-profile.test.ts`

**Step 1: Write failing tests**

Create `src/user-profile.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { lookupLinuxUser, validateUserSetup } from './user-profile.js';

// Mock child_process for /etc/passwd lookup
vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd.includes('getent passwd alice')) {
      return Buffer.from('alice:x:1001:1001:Alice:/home/alice:/bin/bash\n');
    }
    if (cmd.includes('getent passwd nobody')) {
      throw new Error('exit code 2');
    }
    return Buffer.from('');
  }),
}));

// Mock fs for credential checks
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((filePath: string) => {
        if (String(filePath) === '/home/alice/.claude/.credentials.json') return true;
        if (String(filePath) === '/home/alice/.config/gh/hosts.yml') return true;
        return actual.existsSync(filePath);
      }),
    },
  };
});

describe('lookupLinuxUser', () => {
  it('parses /etc/passwd entry for valid user', () => {
    const result = lookupLinuxUser('alice');
    expect(result).toEqual({
      username: 'alice',
      uid: 1001,
      gid: 1001,
      homeDir: '/home/alice',
    });
  });

  it('returns null for nonexistent user', () => {
    const result = lookupLinuxUser('nobody');
    expect(result).toBeNull();
  });
});

describe('validateUserSetup', () => {
  it('returns ok when Claude and gh credentials exist', () => {
    const result = validateUserSetup('/home/alice');
    expect(result.claudeAuth).toBe(true);
    expect(result.ghCli).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/user-profile.test.ts`
Expected: FAIL — module not found

**Step 3: Implement user-profile.ts**

Create `src/user-profile.ts`:

```typescript
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface LinuxUser {
  username: string;
  uid: number;
  gid: number;
  homeDir: string;
}

export interface UserSetupStatus {
  claudeAuth: boolean;
  ghCli: boolean;
  errors: string[];
}

/**
 * Look up a Linux user via getent passwd.
 * Returns null if the user doesn't exist.
 */
export function lookupLinuxUser(username: string): LinuxUser | null {
  // Validate username to prevent command injection
  if (!/^[a-z_][a-z0-9_-]*$/.test(username)) {
    return null;
  }

  try {
    const output = execSync(`getent passwd ${username}`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    // Format: username:password:uid:gid:gecos:home:shell
    const parts = output.split(':');
    if (parts.length < 6) return null;

    return {
      username: parts[0],
      uid: parseInt(parts[2], 10),
      gid: parseInt(parts[3], 10),
      homeDir: parts[5],
    };
  } catch {
    return null;
  }
}

/**
 * Check that a user's home directory has the required credentials.
 */
export function validateUserSetup(homeDir: string): UserSetupStatus {
  const errors: string[] = [];

  const claudeCredsPath = path.join(homeDir, '.claude', '.credentials.json');
  const claudeAuth = fs.existsSync(claudeCredsPath);
  if (!claudeAuth) {
    errors.push(
      `Claude credentials not found at ${claudeCredsPath}. ` +
      `Run \`claude\` on the VPS as this user to authenticate.`,
    );
  }

  const ghConfigPath = path.join(homeDir, '.config', 'gh', 'hosts.yml');
  const ghCli = fs.existsSync(ghConfigPath);
  if (!ghCli) {
    errors.push(
      `GitHub CLI not authenticated at ${ghConfigPath}. ` +
      `Run \`gh auth login\` on the VPS as this user.`,
    );
  }

  return { claudeAuth, ghCli, errors };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/user-profile.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/user-profile.ts src/user-profile.test.ts
git commit -m "feat(healer): add Linux user lookup and credential validation"
```

---

## Task 4: Per-User Credential Proxy Factory

**Files:**
- Modify: `src/credential-proxy.ts`
- Modify: `src/credential-proxy.test.ts`

**Step 1: Write failing tests for per-user proxy**

Add to `src/credential-proxy.test.ts`:

```typescript
import { startUserCredentialProxy } from './credential-proxy.js';

describe('per-user credential proxy', () => {
  let userProxyServer: http.Server;

  afterEach(async () => {
    await new Promise<void>((r) => userProxyServer?.close(() => r()));
  });

  it('reads OAuth token from the specified home directory', async () => {
    // Mock readFileSync to return a token for a specific home dir
    const mockFs = await import('fs');
    const originalReadFileSync = mockFs.default.readFileSync;
    vi.spyOn(mockFs.default, 'readFileSync').mockImplementation(
      (filePath: any, ...args: any[]) => {
        if (String(filePath) === '/home/testuser/.claude/.credentials.json') {
          return JSON.stringify({
            claudeAiOauth: { accessToken: 'user-specific-token' },
          });
        }
        if (String(filePath).includes('.credentials.json')) {
          throw new Error('mocked: file not found');
        }
        return originalReadFileSync(filePath, ...args);
      },
    );

    // Start upstream that captures headers
    const userUpstream = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => userUpstream.listen(0, '127.0.0.1', r));
    const userUpstreamPort = (userUpstream.address() as AddressInfo).port;

    userProxyServer = await startUserCredentialProxy(
      '/home/testuser',
      0,
      `http://127.0.0.1:${userUpstreamPort}`,
    );
    const userProxyPort = (userProxyServer.address() as AddressInfo).port;

    await makeRequest(
      userProxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer user-specific-token',
    );

    await new Promise<void>((r) => userUpstream.close(() => r()));
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/credential-proxy.test.ts`
Expected: FAIL — `startUserCredentialProxy` not exported

**Step 3: Extract per-user proxy factory**

Add to `src/credential-proxy.ts`:

```typescript
/**
 * Read OAuth token from a specific user's home directory.
 * Called fresh on every request to always use the latest token.
 */
function readUserCredentialsToken(homeDir: string): string | undefined {
  try {
    const credsPath = path.join(homeDir, '.claude', '.credentials.json');
    const raw = fs.readFileSync(credsPath, 'utf-8');
    const creds = JSON.parse(raw);
    return creds?.claudeAiOauth?.accessToken;
  } catch {
    return undefined;
  }
}

/**
 * Start a per-user credential proxy on an ephemeral port.
 * Uses the specified user's OAuth token from their home directory.
 * Always reads the token fresh on each request (never cached).
 *
 * @param homeDir - User's home directory (e.g., /home/alice)
 * @param port - Port to listen on (0 for ephemeral)
 * @param upstreamBaseUrl - Upstream API URL (optional, defaults to https://api.anthropic.com)
 * @returns Server instance — caller is responsible for closing on container exit
 */
export function startUserCredentialProxy(
  homeDir: string,
  port: number = 0,
  upstreamBaseUrl?: string,
): Promise<Server> {
  const upstreamUrl = new URL(
    upstreamBaseUrl || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        // OAuth mode only — per-user proxy always uses OAuth (Claude Max)
        if (headers['authorization']) {
          delete headers['authorization'];
          const token = readUserCredentialsToken(homeDir);
          if (token) {
            headers['authorization'] = `Bearer ${token}`;
          } else {
            logger.warn(
              { homeDir },
              'No valid OAuth token found for user — request will likely fail with 401',
            );
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url, homeDir },
            'User credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      logger.info(
        { port: addr.port, homeDir },
        'Per-user credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}
```

Note: `AddressInfo` needs to be imported — add at the top of the file:

```typescript
import type { AddressInfo } from 'net';
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/credential-proxy.test.ts`
Expected: All PASS

**Step 5: Run full test suite to check for regressions**

Run: `npx vitest run`
Expected: All PASS

**Step 6: Commit**

```bash
git add src/credential-proxy.ts src/credential-proxy.test.ts
git commit -m "feat(healer): add per-user credential proxy factory for Claude Max isolation"
```

---

## Task 5: Container Runner — Per-User UID, Mounts, and Proxy Lifecycle

**Files:**
- Modify: `src/container-runner.ts`
- Modify: `src/types.ts` (add `userProfileId` to `ContainerConfig`)

**Step 1: Add userProfileId to ContainerConfig**

In `src/types.ts`, modify `ContainerConfig`:

```typescript
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;
  userProfileId?: string; // Links group to a user profile for per-user isolation
}
```

**Step 2: Modify buildContainerArgs to accept per-user UID override**

In `src/container-runner.ts`, modify `buildContainerArgs` to accept optional `userUid` and `userGid` parameters:

```typescript
function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  userUid?: number,
  userGid?: number,
): string[] {
```

Replace the UID logic block (lines 244-252) with:

```typescript
  // Run as the target user's UID.
  // For user-profile containers, use the profile's UID (their Linux account).
  // Otherwise, fall back to the NanoClaw process UID.
  const effectiveUid = userUid ?? process.getuid?.();
  const effectiveGid = userGid ?? process.getgid?.();
  if (effectiveUid != null && effectiveUid !== 0 && effectiveUid !== 1000) {
    args.push('--user', `${effectiveUid}:${effectiveGid}`);
    args.push('-e', 'HOME=/home/node');
  }
```

**Step 3: Modify buildVolumeMounts to add user-profile mounts**

After the additional mounts block (line 210), add:

```typescript
  // User profile mounts: repos and gh CLI config
  if (group.containerConfig?.userProfileId) {
    const { getUserProfile } = await import('./db.js');
    const profile = getUserProfile(group.containerConfig.userProfileId);
    if (profile) {
      // Mount each configured repo
      for (const repo of profile.repos) {
        const repoMount = validateMount(
          { hostPath: repo.localPath, containerPath: repo.name, readonly: false },
          isMain,
        );
        if (repoMount.allowed) {
          mounts.push({
            hostPath: repoMount.realHostPath!,
            containerPath: `/workspace/extra/${repoMount.resolvedContainerPath}`,
            readonly: repoMount.effectiveReadonly!,
          });
        } else {
          logger.warn(
            { repo: repo.name, path: repo.localPath, reason: repoMount.reason },
            'Repo mount rejected by allowlist',
          );
        }
      }

      // Mount gh CLI config (read-only)
      const ghConfigDir = path.join(profile.homeDir, '.config', 'gh');
      if (fs.existsSync(ghConfigDir)) {
        mounts.push({
          hostPath: ghConfigDir,
          containerPath: '/workspace/extra/.gh-config',
          readonly: true,
        });
      }
    }
  }
```

Note: `buildVolumeMounts` needs to become `async` and import `validateMount` from `./mount-security.js`. Update the function signature:

```typescript
async function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): Promise<VolumeMount[]> {
```

And update `runContainerAgent` to `await` it:

```typescript
const mounts = await buildVolumeMounts(group, input.isMain);
```

**Step 4: Add per-user proxy lifecycle to runContainerAgent**

At the start of `runContainerAgent`, before building mounts, add proxy startup:

```typescript
import { startUserCredentialProxy } from './credential-proxy.js';
import { getUserProfile } from './db.js';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// ... inside runContainerAgent, before const mounts = ...

let userProxy: Server | null = null;
let userProxyPort: number | null = null;
let profileUid: number | undefined;
let profileGid: number | undefined;

if (group.containerConfig?.userProfileId) {
  const profile = getUserProfile(group.containerConfig.userProfileId);
  if (profile) {
    profileUid = profile.uid;
    profileGid = profile.gid;
    try {
      userProxy = await startUserCredentialProxy(profile.homeDir);
      userProxyPort = (userProxy.address() as AddressInfo).port;
      logger.info(
        { group: group.name, user: profile.linuxUsername, port: userProxyPort },
        'Per-user credential proxy started',
      );
    } catch (err) {
      logger.error(
        { group: group.name, user: profile.linuxUsername, err },
        'Failed to start per-user credential proxy',
      );
    }
  }
}
```

Pass UID to `buildContainerArgs`:

```typescript
const containerArgs = buildContainerArgs(mounts, containerName, profileUid, profileGid);
```

Override ANTHROPIC_BASE_URL if user proxy is running — in `buildContainerArgs`, this is set statically. Instead, pass the port override. Modify `buildContainerArgs`:

```typescript
function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  userUid?: number,
  userGid?: number,
  proxyPortOverride?: number,
): string[] {
  // ...
  const proxyPort = proxyPortOverride ?? CREDENTIAL_PROXY_PORT;
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${proxyPort}`,
  );
```

And call it:

```typescript
const containerArgs = buildContainerArgs(
  mounts, containerName, profileUid, profileGid, userProxyPort ?? undefined,
);
```

In the `close` handler, shut down the user proxy:

```typescript
container.on('close', (code) => {
  // Clean up per-user proxy
  if (userProxy) {
    userProxy.close(() => {
      logger.debug({ group: group.name }, 'Per-user credential proxy closed');
    });
  }
  // ... rest of existing close handler ...
```

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All PASS (existing container-runner tests should still pass since userProfileId is optional)

**Step 6: Run build**

Run: `npm run build`
Expected: No errors

**Step 7: Commit**

```bash
git add src/container-runner.ts src/types.ts
git commit -m "feat(healer): per-user UID, repo mounts, and credential proxy lifecycle in container runner"
```

---

## Task 6: Log Sync — Tailscale SSH Fetch

**Files:**
- Create: `src/log-sync.ts`
- Create: `src/log-sync.test.ts`

**Step 1: Write failing tests**

Create `src/log-sync.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSyncCommand, parseFindOutput, buildTempDir } from './log-sync.js';

describe('buildSyncCommand', () => {
  it('builds find command for today-only logs', () => {
    const cmd = buildSyncCommand(
      'alice',
      '100.84.112.81',
      '/var/log/api/',
      '*.log',
    );
    expect(cmd).toContain('ssh');
    expect(cmd).toContain('alice@100.84.112.81');
    expect(cmd).toContain('find');
    expect(cmd).toContain('/var/log/api/');
    expect(cmd).toContain('-name');
    expect(cmd).toContain('*.log');
    expect(cmd).toContain('-newermt');
    expect(cmd).toContain('today 00:00');
  });
});

describe('parseFindOutput', () => {
  it('splits find output into file paths', () => {
    const output = '/var/log/api/app.log\n/var/log/api/error.log\n';
    const files = parseFindOutput(output);
    expect(files).toEqual(['/var/log/api/app.log', '/var/log/api/error.log']);
  });

  it('handles empty output', () => {
    expect(parseFindOutput('')).toEqual([]);
    expect(parseFindOutput('\n')).toEqual([]);
  });
});

describe('buildTempDir', () => {
  it('creates deterministic temp path from profile and source', () => {
    const dir = buildTempDir('prof-1', 'prod-api');
    expect(dir).toBe('/tmp/nanoclaw-logs/prof-1/prod-api');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/log-sync.test.ts`
Expected: FAIL — module not found

**Step 3: Implement log-sync.ts**

Create `src/log-sync.ts`:

```typescript
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { RemoteLogSource, UserProfile } from './types.js';

const TEMP_BASE = '/tmp/nanoclaw-logs';

export function buildTempDir(profileId: string, sourceName: string): string {
  return path.join(TEMP_BASE, profileId, sourceName);
}

export function buildSyncCommand(
  username: string,
  host: string,
  logPath: string,
  pattern: string,
): string {
  // Validate inputs to prevent command injection
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) throw new Error(`Invalid username: ${username}`);
  if (!/^[a-zA-Z0-9._:-]+$/.test(host)) throw new Error(`Invalid host: ${host}`);
  if (logPath.includes("'") || logPath.includes(';')) throw new Error(`Invalid logPath: ${logPath}`);
  if (pattern.includes("'") || pattern.includes(';')) throw new Error(`Invalid pattern: ${pattern}`);

  return `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new ${username}@${host} "find '${logPath}' -maxdepth 1 -name '${pattern}' -newermt 'today 00:00' -type f"`;
}

export function parseFindOutput(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Sync today's logs from a remote source to a local temp directory.
 * Runs SSH commands as the given Linux user via sudo -u.
 *
 * @returns Path to the local temp directory containing synced logs, or null on failure.
 */
export function syncRemoteLogs(
  profile: UserProfile,
  source: RemoteLogSource,
): string | null {
  const tempDir = buildTempDir(profile.id, source.name);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // Find today's log files on the remote machine
    const findCmd = buildSyncCommand(
      profile.linuxUsername,
      source.host,
      source.logPath,
      source.logPattern,
    );

    // Run as the user so Tailscale SSH authenticates as them
    const findOutput = execSync(
      `sudo -u ${profile.linuxUsername} ${findCmd}`,
      { encoding: 'utf-8', timeout: 30000 },
    ).trim();

    const remoteFiles = parseFindOutput(findOutput);

    if (remoteFiles.length === 0) {
      logger.info(
        { source: source.name, host: source.host },
        'No log files found for today',
      );
      return tempDir;
    }

    // SCP each file to the temp directory
    const fileList = remoteFiles.join(' ');
    const scpCmd = `sudo -u ${profile.linuxUsername} scp -o ConnectTimeout=10 ${profile.linuxUsername}@${source.host}:"${fileList}" "${tempDir}/"`;

    execSync(scpCmd, { timeout: 120000 });

    logger.info(
      { source: source.name, fileCount: remoteFiles.length, tempDir },
      'Remote logs synced successfully',
    );

    return tempDir;
  } catch (err) {
    logger.error(
      { source: source.name, host: source.host, err },
      'Failed to sync remote logs',
    );
    return null;
  }
}

/**
 * Sync all remote log sources for a user profile.
 * Returns a map of source name → local temp directory.
 */
export function syncAllRemoteLogs(
  profile: UserProfile,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const source of profile.remoteSources) {
    const tempDir = syncRemoteLogs(profile, source);
    if (tempDir) {
      result[source.name] = tempDir;
    }
  }

  return result;
}

/**
 * Clean up all synced logs for a profile.
 * Called after the container exits.
 */
export function cleanupSyncedLogs(profileId: string): void {
  const profileTempDir = path.join(TEMP_BASE, profileId);
  try {
    fs.rmSync(profileTempDir, { recursive: true, force: true });
    logger.debug({ profileId, dir: profileTempDir }, 'Cleaned up synced logs');
  } catch (err) {
    logger.warn(
      { profileId, dir: profileTempDir, err },
      'Failed to clean up synced logs',
    );
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/log-sync.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/log-sync.ts src/log-sync.test.ts
git commit -m "feat(healer): add remote log sync via Tailscale SSH with today-only filter"
```

---

## Task 7: Heal Prompt Generator

**Files:**
- Create: `src/heal-prompt.ts`
- Create: `src/heal-prompt.test.ts`

**Step 1: Write failing tests**

Create `src/heal-prompt.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildHealPrompt } from './heal-prompt.js';
import { RepoConfig, RemoteLogSource } from './types.js';

const repo: RepoConfig = {
  name: 'api',
  localPath: '/home/alice/projects/api',
  inspectionTypes: ['log-analysis'],
  schedule: '0 23 * * *',
  healBranchPrefix: 'heal/',
};

const logSource: RemoteLogSource = {
  name: 'prod-api',
  host: '100.84.112.81',
  logPath: '/var/log/api/',
  logPattern: '*.log',
  linkedRepo: 'api',
};

describe('buildHealPrompt', () => {
  it('builds log-analysis prompt with repo and logs', () => {
    const prompt = buildHealPrompt(repo, 'log-analysis', { 'prod-api': '/workspace/logs/prod-api' });
    expect(prompt).toContain('/workspace/extra/api');
    expect(prompt).toContain('/workspace/logs/prod-api');
    expect(prompt).toContain('heal/');
    expect(prompt).toContain('gh pr create');
    expect(prompt).toContain('log-analysis');
  });

  it('builds code-review prompt without logs', () => {
    const prompt = buildHealPrompt(repo, 'code-review', {});
    expect(prompt).toContain('/workspace/extra/api');
    expect(prompt).not.toContain('/workspace/logs');
    expect(prompt).toContain('code quality');
  });

  it('builds security-review prompt', () => {
    const prompt = buildHealPrompt(repo, 'security-review', {});
    expect(prompt).toContain('OWASP');
    expect(prompt).toContain('vulnerabilities');
  });

  it('includes date in branch name', () => {
    const prompt = buildHealPrompt(repo, 'log-analysis', {});
    const today = new Date().toISOString().split('T')[0];
    expect(prompt).toContain(`heal/${today}`);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/heal-prompt.test.ts`
Expected: FAIL — module not found

**Step 3: Implement heal-prompt.ts**

Create `src/heal-prompt.ts`:

```typescript
import { InspectionType, RepoConfig } from './types.js';

const today = () => new Date().toISOString().split('T')[0];

const COMMON_RULES = `
RULES:
- Never commit directly to main/master — always create a new branch
- Each fix gets its own branch and PR
- Include evidence (log excerpts, code snippets) in PR descriptions
- If an issue is unclear or risky, flag it in the summary instead of fixing it
- Use \`gh pr create\` to create PRs
- Configure git to use GitHub CLI credentials: run \`gh auth setup-git\` before pushing
- Set GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL from the repo's existing git config
`.trim();

const SUMMARY_FORMAT = `
SUMMARY FORMAT — After completing all fixes, send a summary using the send_message MCP tool:

## Heal Report — {repo} ({date})

### Issues Found: N

1. **Description** — evidence
   → PR #N: branch-name

### Flagged (needs human review): N

1. **Description** — why it was flagged

### Clean: no issues found (if applicable)
`.trim();

export function buildHealPrompt(
  repo: RepoConfig,
  inspectionType: InspectionType,
  syncedLogDirs: Record<string, string>,
): string {
  const date = today();
  const repoPath = `/workspace/extra/${repo.name}`;
  const branchPrefix = `${repo.healBranchPrefix}${date}`;

  const logEntries = Object.entries(syncedLogDirs);
  const hasLogs = logEntries.length > 0;

  let inspection: string;

  switch (inspectionType) {
    case 'log-analysis':
      inspection = `
INSPECTION TYPE: log-analysis

${hasLogs ? `LOGS:\n${logEntries.map(([name, dir]) => `- ${name}: ${dir}/`).join('\n')}` : 'No logs available — check the repo for recent error patterns instead.'}

WORKFLOW:
1. Read today's logs — identify errors, warnings, stack traces, and anomalies
2. Cross-reference each issue with source code at ${repoPath}/ to find the root cause
3. For each fixable issue:
   a. Create branch: ${branchPrefix}-{short-description}
   b. Implement the minimal fix
   c. Commit with a clear message: "fix: {what was broken and why}"
   d. Push the branch
   e. Create a PR with the log excerpt as evidence in the description
4. Send a summary of all findings and PRs created
`.trim();
      break;

    case 'code-review':
      inspection = `
INSPECTION TYPE: code-review

WORKFLOW:
1. Review the codebase at ${repoPath}/ for code quality issues:
   - Bugs and logic errors
   - Error handling gaps
   - Performance problems
   - Code smells and maintainability issues
2. Check recent commits: \`git log --oneline -20\` for context on recent changes
3. For each fixable issue:
   a. Create branch: ${branchPrefix}-{short-description}
   b. Implement the fix
   c. Commit with a clear message
   d. Push and create a PR explaining the issue and fix
4. Send a summary
`.trim();
      break;

    case 'security-review':
      inspection = `
INSPECTION TYPE: security-review

WORKFLOW:
1. Scan the codebase at ${repoPath}/ for security vulnerabilities:
   - OWASP Top 10 (injection, XSS, CSRF, auth issues, etc.)
   - Hardcoded secrets, API keys, or credentials
   - Insecure dependencies (check package.json / requirements.txt)
   - Insecure file permissions or path traversal risks
   - SQL injection, command injection
2. For each confirmed vulnerability:
   a. Create branch: ${branchPrefix}-{short-description}
   b. Implement the fix with a security-focused commit message
   c. Push and create a PR with severity assessment (critical/high/medium/low)
3. For potential vulnerabilities that need human review, flag them in the summary
4. Send a summary with severity ratings
`.trim();
      break;
  }

  return `You are a code healer. Analyze and repair code autonomously.

REPO: ${repo.name} at ${repoPath}
BRANCH PREFIX: ${branchPrefix}

${inspection}

${COMMON_RULES}

${SUMMARY_FORMAT.replace('{repo}', repo.name).replace('{date}', date)}`;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/heal-prompt.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/heal-prompt.ts src/heal-prompt.test.ts
git commit -m "feat(healer): add heal prompt generator for log-analysis, code-review, security-review"
```

---

## Task 8: Task Scheduler Integration — Pre-Task Sync and Post-Task Cleanup

**Files:**
- Modify: `src/task-scheduler.ts`
- Modify: `src/container-runner.ts`

This task wires log sync into the scheduled task lifecycle. The key insight: heal tasks use a special prompt prefix `[HEAL]` that the scheduler detects. When it sees this, it runs log sync before the container and cleanup after.

**Step 1: Add heal task detection to the scheduled task prompt**

Heal tasks are created with a prompt that starts with `[HEAL:profileId]`. The scheduler detects this, runs log sync, generates the real prompt from the profile config, and passes it to the container with synced log mounts.

In `src/task-scheduler.ts`, modify `runTask` — after `const group = ...` (line 112), add:

```typescript
import { syncAllRemoteLogs, cleanupSyncedLogs } from './log-sync.js';
import { buildHealPrompt } from './heal-prompt.js';
import { getUserProfile } from './db.js';

// ... inside runTask, after group lookup ...

// Detect heal tasks and run pre-task log sync
const healMatch = task.prompt.match(/^\[HEAL:([^\]]+)\]$/);
let healLogMounts: Record<string, string> = {};

if (healMatch) {
  const profileId = healMatch[1];
  const profile = getUserProfile(profileId);

  if (!profile) {
    logger.error({ taskId: task.id, profileId }, 'User profile not found for heal task');
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `User profile not found: ${profileId}`,
    });
    return;
  }

  // Sync remote logs before spawning container
  healLogMounts = syncAllRemoteLogs(profile);

  // Build prompts for each repo × inspection type combo
  // For now, concatenate all prompts into one task
  const prompts: string[] = [];
  for (const repo of profile.repos) {
    // Filter synced logs to those linked to this repo
    const repoLogs: Record<string, string> = {};
    for (const source of profile.remoteSources) {
      if (source.linkedRepo === repo.name && healLogMounts[source.name]) {
        repoLogs[source.name] = `/workspace/logs/${source.name}`;
      }
    }

    for (const inspectionType of repo.inspectionTypes) {
      prompts.push(buildHealPrompt(repo, inspectionType, repoLogs));
    }
  }

  // Replace the [HEAL:id] prompt with the generated prompts
  task = { ...task, prompt: prompts.join('\n\n---\n\n') };
}
```

**Step 2: Mount synced logs into the container**

The `group.containerConfig.additionalMounts` already handles this. Before spawning, add synced log dirs as temporary additional mounts:

```typescript
if (Object.keys(healLogMounts).length > 0) {
  // Temporarily add synced log dirs as additional mounts
  const logMounts = Object.entries(healLogMounts).map(([name, dir]) => ({
    hostPath: dir,
    containerPath: name,
    readonly: true,
  }));

  // Clone group config to avoid mutating the original
  group = {
    ...group,
    containerConfig: {
      ...group.containerConfig,
      additionalMounts: [
        ...(group.containerConfig?.additionalMounts || []),
        ...logMounts,
      ],
    },
  };
}
```

Note: the mount security allowlist needs `/tmp/nanoclaw-logs` added as an allowed root. This is done in the setup step, not in code — the admin adds it to `~/.config/nanoclaw/mount-allowlist.json`.

**Step 3: Add post-task cleanup**

After the task completes (after `logTaskRun`), add:

```typescript
// Clean up synced logs after heal task
if (healMatch) {
  cleanupSyncedLogs(healMatch[1]);
}
```

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/task-scheduler.ts
git commit -m "feat(healer): integrate log sync and heal prompts into task scheduler lifecycle"
```

---

## Task 9: MCP Tools — Chat-Based Onboarding

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

**Step 1: Add setup_profile MCP tool**

Add to `ipc-mcp-stdio.ts` after the existing tools:

```typescript
server.tool(
  'setup_healer_profile',
  `Register a user for the code healer service. Call this when a user says "set me up" or provides their Linux username for healing.

The host will:
1. Look up the Linux user in /etc/passwd
2. Verify Claude credentials exist
3. Verify GitHub CLI is authenticated
4. Create a user profile linked to this chat

Returns the profile status and next steps.`,
  {
    linux_username: z.string().describe('The Linux username on the VPS (e.g., "alice")'),
    discord_user_id: z.string().describe('The Discord user ID of the person requesting setup'),
  },
  async (args) => {
    const data = {
      type: 'healer_setup',
      action: 'create_profile',
      chatJid,
      groupFolder,
      linuxUsername: args.linux_username,
      discordUserId: args.discord_user_id,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{
        type: 'text' as const,
        text: 'Profile setup request sent. The host will validate the Linux user and credentials.',
      }],
    };
  },
);

server.tool(
  'add_healer_repo',
  `Add a repository for the code healer to monitor. The user must have a healer profile set up first.`,
  {
    discord_user_id: z.string().describe('The Discord user ID'),
    repo_name: z.string().describe('Short name for the repo (e.g., "api")'),
    local_path: z.string().describe('Absolute path on the VPS (e.g., "/home/alice/projects/api")'),
    inspection_types: z.array(z.enum(['log-analysis', 'code-review', 'security-review']))
      .describe('What types of inspection to run'),
    schedule: z.string().optional().describe('Cron expression (default: "0 23 * * *" = 11pm daily)'),
  },
  async (args) => {
    const data = {
      type: 'healer_setup',
      action: 'add_repo',
      chatJid,
      groupFolder,
      discordUserId: args.discord_user_id,
      repoName: args.repo_name,
      localPath: args.local_path,
      inspectionTypes: args.inspection_types,
      schedule: args.schedule || '0 23 * * *',
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{
        type: 'text' as const,
        text: `Repo "${args.repo_name}" configuration sent. It will be added to your heal profile.`,
      }],
    };
  },
);

server.tool(
  'add_healer_log_source',
  `Add a remote log source for the code healer. Logs are fetched via Tailscale SSH before each heal run.`,
  {
    discord_user_id: z.string().describe('The Discord user ID'),
    source_name: z.string().describe('Short name (e.g., "prod-api")'),
    host: z.string().describe('Tailscale hostname or IP (e.g., "100.84.112.81")'),
    log_path: z.string().describe('Absolute path on remote machine (e.g., "/var/log/api/")'),
    log_pattern: z.string().optional().describe('Glob pattern (default: "*.log")'),
    linked_repo: z.string().describe('Which repo name these logs relate to'),
  },
  async (args) => {
    const data = {
      type: 'healer_setup',
      action: 'add_log_source',
      chatJid,
      groupFolder,
      discordUserId: args.discord_user_id,
      sourceName: args.source_name,
      host: args.host,
      logPath: args.log_path,
      logPattern: args.log_pattern || '*.log',
      linkedRepo: args.linked_repo,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{
        type: 'text' as const,
        text: `Log source "${args.source_name}" configuration sent.`,
      }],
    };
  },
);
```

**Step 2: Handle healer IPC tasks on the host side**

In `src/ipc.ts`, add a handler for `healer_setup` task type. Find the task processing switch/if chain and add:

```typescript
import { lookupLinuxUser, validateUserSetup } from './user-profile.js';
import { getUserProfileByDiscordId, setUserProfile } from './db.js';
import { randomUUID } from 'crypto';

// ... in the task handler ...

if (task.type === 'healer_setup') {
  if (task.action === 'create_profile') {
    const user = lookupLinuxUser(task.linuxUsername);
    if (!user) {
      // Send error back to the group
      await sendMessage(task.chatJid, `Linux user "${task.linuxUsername}" not found on this system.`);
      return;
    }

    const status = validateUserSetup(user.homeDir);
    if (status.errors.length > 0) {
      await sendMessage(task.chatJid, `Setup issues:\n${status.errors.map(e => `- ${e}`).join('\n')}`);
      return;
    }

    const existing = getUserProfileByDiscordId(task.discordUserId);
    const profile: UserProfile = {
      id: existing?.id || randomUUID(),
      discordUserId: task.discordUserId,
      linuxUsername: user.username,
      uid: user.uid,
      gid: user.gid,
      homeDir: user.homeDir,
      repos: existing?.repos || [],
      remoteSources: existing?.remoteSources || [],
      createdAt: existing?.createdAt || new Date().toISOString(),
    };

    setUserProfile(profile);

    // Link this group's containerConfig to the profile
    // (update the registered group's containerConfig.userProfileId)

    await sendMessage(
      task.chatJid,
      `Profile created for ${user.username} (uid: ${user.uid}).\n` +
      `Claude auth: ✓\nGitHub CLI: ✓\n\n` +
      `Next: tell me which repos to monitor and where to find logs.`,
    );
  }

  if (task.action === 'add_repo') {
    const profile = getUserProfileByDiscordId(task.discordUserId);
    if (!profile) {
      await sendMessage(task.chatJid, 'No healer profile found. Run setup first.');
      return;
    }

    // Check for duplicate
    const existing = profile.repos.find(r => r.name === task.repoName);
    if (existing) {
      await sendMessage(task.chatJid, `Repo "${task.repoName}" already configured. Remove it first to reconfigure.`);
      return;
    }

    profile.repos.push({
      name: task.repoName,
      localPath: task.localPath,
      inspectionTypes: task.inspectionTypes,
      schedule: task.schedule,
      healBranchPrefix: 'heal/',
    });

    setUserProfile(profile);

    // Create the scheduled heal task
    const { createTask } = await import('./db.js');
    const { CronExpressionParser } = await import('cron-parser');
    const { TIMEZONE } = await import('./config.js');

    const interval = CronExpressionParser.parse(task.schedule, { tz: TIMEZONE });
    const taskId = randomUUID();

    createTask({
      id: taskId,
      group_folder: task.groupFolder,
      chat_jid: task.chatJid,
      prompt: `[HEAL:${profile.id}]`,
      schedule_type: 'cron',
      schedule_value: task.schedule,
      context_mode: 'isolated',
      next_run: interval.next().toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });

    await sendMessage(
      task.chatJid,
      `Repo "${task.repoName}" added with ${task.inspectionTypes.join(', ')} inspection.\n` +
      `Schedule: ${task.schedule}\n` +
      `Heal task created (ID: ${taskId.slice(0, 8)}).`,
    );
  }

  if (task.action === 'add_log_source') {
    const profile = getUserProfileByDiscordId(task.discordUserId);
    if (!profile) {
      await sendMessage(task.chatJid, 'No healer profile found. Run setup first.');
      return;
    }

    profile.remoteSources.push({
      name: task.sourceName,
      host: task.host,
      logPath: task.logPath,
      logPattern: task.logPattern,
      linkedRepo: task.linkedRepo,
    });

    setUserProfile(profile);

    await sendMessage(
      task.chatJid,
      `Log source "${task.sourceName}" added.\n` +
      `Host: ${task.host}\nPath: ${task.logPath}\nPattern: ${task.logPattern}\n` +
      `Linked to repo: ${task.linkedRepo}`,
    );
  }
}
```

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All PASS

**Step 4: Rebuild container to include new MCP tools**

Run: `npm run build`
Expected: No errors

**Step 5: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts src/ipc.ts
git commit -m "feat(healer): add MCP tools for chat-based profile, repo, and log source setup"
```

---

## Task 10: Container Skill — Heal Workflow Guide

**Files:**
- Create: `container/skills/heal/SKILL.md`

**Step 1: Create the heal skill**

Create `container/skills/heal/SKILL.md`:

```markdown
---
name: heal
description: Guide for automated code healing — log analysis, code review, and security review with branch + PR workflow
---

# Code Healer Skill

You are running as a code healer. Your job is to analyze code and/or logs, identify issues, and create fix PRs.

## Before Starting

1. Set up git credentials:
   ```bash
   # Configure git to use gh CLI for auth
   GH_CONFIG_DIR=/workspace/extra/.gh-config gh auth setup-git

   # Get repo's existing git config for author identity
   cd /workspace/extra/{repo}
   export GIT_AUTHOR_NAME=$(git config user.name || echo "NanoClaw Healer")
   export GIT_AUTHOR_EMAIL=$(git config user.email || echo "healer@nanoclaw.local")
   export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
   export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
   ```

2. Check you're on the default branch and up to date:
   ```bash
   git checkout main  # or master
   git pull
   ```

## Workflow Per Issue

1. **Identify**: Find the issue (from logs or code analysis)
2. **Branch**: `git checkout -b heal/YYYY-MM-DD-short-description`
3. **Fix**: Implement the minimal fix
4. **Test**: Run existing tests if available (`npm test`, `pytest`, etc.)
5. **Commit**: `git commit -m "fix: description of what was broken and why"`
6. **Push**: `git push -u origin HEAD`
7. **PR**: `GH_CONFIG_DIR=/workspace/extra/.gh-config gh pr create --title "fix: ..." --body "..."`
8. **Return**: `git checkout main` before starting the next issue

## PR Description Template

```markdown
## Issue

{What was found — include log excerpt or code reference}

## Root Cause

{Why it was happening}

## Fix

{What was changed and why this is the right fix}

## Evidence

{Log excerpts, error messages, or code that demonstrates the issue}

---
*Automated fix by NanoClaw Code Healer*
```

## Important

- One branch per issue, one PR per fix
- Never commit to main/master directly
- If unsure about a fix, flag it in the summary instead
- Always include evidence in PR descriptions
- Run tests before pushing if the project has them
- Use `send_message` MCP tool to report progress and final summary
```

**Step 2: Commit**

```bash
git add container/skills/heal/SKILL.md
git commit -m "feat(healer): add container skill for guided heal workflow"
```

---

## Task 11: Mount Allowlist Setup Documentation

**Files:**
- Modify: `docs/plans/2026-03-24-code-healer-design.md` (append setup section)

**Step 1: Add admin setup instructions to the design doc**

Append to the design doc:

```markdown
## Admin Setup

### Mount Allowlist

The NanoClaw admin must add user repo directories and the temp log directory to
`~/.config/nanoclaw/mount-allowlist.json`:

\`\`\`json
{
  "allowedRoots": [
    {
      "path": "/home",
      "allowReadWrite": true,
      "description": "User home directories — repos and gh config"
    },
    {
      "path": "/tmp/nanoclaw-logs",
      "allowReadWrite": false,
      "description": "Temporary synced logs (read-only in containers)"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": false
}
\`\`\`

### Sudoers

The NanoClaw process user needs passwordless sudo for SSH commands as other users:

\`\`\`
# /etc/sudoers.d/nanoclaw
nanoclaw_user ALL=(ALL) NOPASSWD: /usr/bin/ssh, /usr/bin/scp
\`\`\`

### Tailscale

All VPS machines must be on the same tailnet. Users must have Tailscale SSH
access to their remote log machines (configured in Tailscale ACLs).
```

**Step 2: Commit**

```bash
git add docs/plans/2026-03-24-code-healer-design.md
git commit -m "docs(healer): add admin setup instructions for mount allowlist, sudoers, tailscale"
```

---

## Task 12: End-to-End Integration Test

**Step 1: Manual integration test checklist**

Run through this sequence to verify the full flow:

1. Start NanoClaw: `npm run dev`
2. DM the Discord bot: "set me up, my Linux username is bjern"
3. Verify profile created: check SQLite `user_profiles` table
4. DM: "monitor /home/bjern/datarake with nightly log analysis"
5. Verify repo added and scheduled task created
6. DM: "add log source prod-datarake from 100.84.112.81 at /home/bjern/datarake/ pattern *.log linked to datarake"
7. Verify log source added
8. Manually trigger the task (update `next_run` to now in SQLite)
9. Verify:
   - Logs synced to `/tmp/nanoclaw-logs/{profileId}/prod-datarake/`
   - Container spawned with correct UID
   - Container has repos at `/workspace/extra/datarake`
   - Container has logs at `/workspace/logs/prod-datarake/`
   - Agent creates branch, commits, pushes, creates PR
   - Summary sent to Discord DM
   - Temp logs cleaned up after container exits

**Step 2: Commit any fixes from integration testing**

```bash
git add -A
git commit -m "fix(healer): integration test fixes"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Types | `src/types.ts` |
| 2 | DB table + CRUD | `src/db.ts`, `src/db.test.ts` |
| 3 | User profile lookup | `src/user-profile.ts`, `src/user-profile.test.ts` |
| 4 | Per-user credential proxy | `src/credential-proxy.ts`, `src/credential-proxy.test.ts` |
| 5 | Container runner changes | `src/container-runner.ts`, `src/types.ts` |
| 6 | Log sync | `src/log-sync.ts`, `src/log-sync.test.ts` |
| 7 | Heal prompt generator | `src/heal-prompt.ts`, `src/heal-prompt.test.ts` |
| 8 | Task scheduler integration | `src/task-scheduler.ts` |
| 9 | MCP onboarding tools | `container/agent-runner/src/ipc-mcp-stdio.ts`, `src/ipc.ts` |
| 10 | Container skill | `container/skills/heal/SKILL.md` |
| 11 | Admin setup docs | `docs/plans/2026-03-24-code-healer-design.md` |
| 12 | Integration test | Manual verification |
