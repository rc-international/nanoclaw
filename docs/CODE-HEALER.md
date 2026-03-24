# Code Healer

Automated code analysis and repair for multi-user NanoClaw installations. Each user configures their own repos, remote log sources, and inspection schedules via Discord DM with a shared bot.

## How It Works

```
11pm cron fires
  → Sync today's logs from remote machine (Tailscale SSH)
  → Spawn container as the user's Linux UID
  → Agent analyzes logs + source code
  → Creates branch, fix, commit, push, PR per issue
  → Sends summary to user's Discord DM
  → Cleans up local log copies
```

## User Setup

Users DM the bot to register. All configuration happens through chat — no config files.

**1. Register your Linux account:**

```
set me up as a healer, my linux username is alice
```

NanoClaw resolves `alice` via `/etc/passwd`, verifies `~/.claude/.credentials.json` (Claude Max) and `~/.config/gh/hosts.yml` (GitHub CLI) exist, and creates a profile.

**2. Add a repo to monitor:**

```
monitor ~/projects/api with nightly log analysis
```

Creates a scheduled task (default 11pm) that runs the heal workflow against that repo.

**3. Add a remote log source:**

```
pull logs from prod-server:/var/log/api/*.log and link them to api
```

Logs are synced before each heal run via Tailscale SSH. Only today's files are pulled. Local copies are deleted after the task completes.

## Inspection Types

| Type | What it does |
|------|-------------|
| `log-analysis` | Errors/warnings in logs → trace to source code → fix root causes |
| `code-review` | Review recent commits or full codebase for bugs, quality, code smells |
| `security-review` | OWASP top 10, dependency vulnerabilities, secrets in code |

## Identity Chain

Each user's identity flows through:

```
Discord User ID → Linux user on VPS → their Claude Max OAuth token
                                     → their repos (owned by their UID)
                                     → their gh CLI auth
                                     → their Tailscale SSH identity
                                     → container runs as their UID/GID
```

Containers run as the user's Linux account (`--user uid:gid`), use the user's Claude Max subscription via a per-user credential proxy, and push code with the user's GitHub credentials.

## Per-User Credential Proxy

Each container gets its own credential proxy on an ephemeral port. The proxy reads the user's OAuth token fresh on every request from `~/.claude/.credentials.json` — never cached at startup. If the token expires, the user gets a Discord DM asking them to run `claude` on the VPS to refresh it.

## Admin Setup

### Mount Allowlist

Add user directories and the temp log path to `~/.config/nanoclaw/mount-allowlist.json`:

```json
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
  ]
}
```

### Sudoers

The NanoClaw process user needs passwordless sudo for SSH/SCP as other users:

```
# /etc/sudoers.d/nanoclaw
nanoclaw_user ALL=(ALL) NOPASSWD: /usr/bin/ssh, /usr/bin/scp
```

### Tailscale

All machines must be on the same tailnet. Users must have Tailscale SSH access to their remote log machines (configured in Tailscale ACLs).

## Output

After each run, the user gets a Discord DM summary:

```
## Heal Report — api (2026-03-24)

### Issues Found: 2

1. **Unhandled null in /src/parser.ts:42** — TypeError in logs (12 occurrences)
   → PR #87: heal/2026-03-24-null-parser

2. **Memory leak in WebSocket handler** — connections not cleaned up on error
   → Flagged only (complex fix, needs human review)
```

## Files

| File | Purpose |
|------|---------|
| `src/user-profile.ts` | UserProfile CRUD, `/etc/passwd` lookup, validation |
| `src/credential-proxy.ts` | Shared + per-user credential proxy factories |
| `src/log-sync.ts` | Remote log sync via Tailscale SSH |
| `src/heal-prompt.ts` | Generates agent prompts per inspection type |
| `container/skills/heal/SKILL.md` | Guides the container agent through the heal workflow |
| `docs/plans/2026-03-24-code-healer-design.md` | Full design document |

## Requirements

- Tailscale installed on all machines (VPS + remote log sources)
- Each user needs: Linux account on the VPS, Claude Max subscription, `gh` CLI authenticated
- NanoClaw admin must configure mount allowlist and sudoers
