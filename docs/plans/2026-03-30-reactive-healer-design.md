# Reactive Code Healer — Event-Driven Error Detection & Repair

**Date:** 2026-03-30
**Status:** Approved design, pending implementation
**Branch:** `feature/reactive-healer`

## Overview

Extends the Code Healer from scheduled-only to event-driven. NanoClaw watches Discord channels for structured error notifications. When errors arrive, it debounces them per repo, clones the repo on demand, traces the error to source code via `git blame`, optionally resumes the original Claude session that authored the code, creates a fix branch + PR, and posts the result back to the same Discord channel.

Scheduled healing continues unchanged. Reactive healing adds a parallel trigger path.

## Notification Contract

Devs send error notifications to Discord as webhook embeds. The embed description must contain a JSON block with this structure:

```json
{
  "nanoclaw": "heal",
  "user": "bjern",
  "repo": "datarake",
  "repo_url": "https://github.com/bjern/datarake",
  "error": "Client error '400 Bad Request' for url '...'",
  "traceback": "File \"src/datarake/parqinglot.py\", line 305, in insert_scrape_failure\n    resp.raise_for_status()\nhttpx.HTTPStatusError: ...",
  "file": "src/datarake/parqinglot.py",
  "line": 305,
  "commit": "a1b2c3d",
  "severity": "error"
}
```

| Field | Required | Purpose |
|-------|----------|---------|
| `nanoclaw` | yes | Sentinel — must be `"heal"`. Tells the bot this is a heal request |
| `user` | yes | Linux username — maps to user profile for creds |
| `repo` | yes | Repo name — used for deduplication and display |
| `repo_url` | yes | Clone URL — used to `git clone` on demand |
| `error` | yes | Error message — the core symptom |
| `traceback` | no | Stack trace — pinpoints the code path |
| `file` | no | Source file — can be extracted from traceback |
| `line` | no | Line number — can be extracted from traceback |
| `commit` | no | Deployed commit SHA — hint for checkout |
| `severity` | no | `"error"` or `"warning"` — defaults to `"error"` |

The `user` field is the Linux username, not a Discord user ID. The healer is channel-agnostic — Discord is one input, the core logic is identity + repo + error.

## Message Flow & Debouncing

### Detection

The Discord bot already receives all messages. When a message contains a JSON code block or embed with `"nanoclaw": "heal"`, it is routed to the reactive healer instead of the normal message handler.

### Debounce Window

5 minutes per `user + repo` combination, with timer reset on each new error:

```
12:00:01  Error arrives: bjern/datarake — start 5-min timer
12:00:03  Error arrives: bjern/datarake — add to batch, reset timer
12:00:15  Error arrives: bjern/datarake — add to batch, reset timer
12:02:40  Error arrives: alice/api      — separate timer for alice/api
12:05:15  Timer fires for bjern/datarake — spawn heal with 3 errors
12:07:40  Timer fires for alice/api     — spawn heal with 1 error
```

Timer resets ensure burst errors from a bad deploy or crash loop are fully captured before acting.

### Deduplication

Within a batch, same `file + line + error` is collapsed into one entry with an occurrence count. If `parqinglot.py:305` errors 20 times, the healer sees it once with `occurrences: 20`.

### Queue Integration

When the timer fires, the batch becomes a heal task submitted to the existing `GroupQueue`. This respects per-group concurrency — a reactive heal won't stampede alongside a scheduled heal for the same user.

## Heal Execution Flow

### 1. Resolve User Profile

Look up the linux username in `user_profiles`. If no profile exists, post to the Discord channel: "Unknown user `bjern` — register with the bot first." Stop.

### 2. Clone the Repo

```bash
git clone --depth 50 <repo_url> /tmp/nanoclaw-heal/<user>/<repo>-<timestamp>
```

Shallow clone (50 commits) keeps it fast while giving `git blame` enough history. If `commit` is in the payload, `git checkout <commit>` to match the deployed version.

### 3. Trace Errors to Source

For each error in the batch:

- If `file` + `line` are provided, use them directly
- If only `traceback` is provided, parse it for file paths and line numbers (Python and Node.js formats supported)
- Run `git blame -L <line>,<line> <file>` to find the authoring commit
- Read the commit message, extract `Session-Id` trailer if present

### 4. Build the Heal Prompt

Error-driven prompt with batch context:

```
You are a code healer. These errors were reported in production:

ERROR 1 (12 occurrences):
  File: src/datarake/parqinglot.py:305
  Error: Client error '400 Bad Request'
  Traceback: ...
  Authored by commit: a1b2c3d (Session-Id: 9f8e7d6c)

ERROR 2: ...

REPO: /workspace/repo (cloned from github.com/bjern/datarake)

WORKFLOW:
1. Investigate each error in the source code
2. Create branch heal/YYYY-MM-DD-<descriptor> per fix
3. Push and create PR with evidence
4. Send summary to the channel via send_message
```

### 5. Spawn Container

- Mount the cloned repo at `/workspace/repo` (read-write)
- Mount user's `~/.config/gh` for GitHub auth (read-only)
- Mount user's `.credentials.json` for Claude auth (read-only)
- Run as user's UID/GID
- If a Session-Id was found, pass `--resume <session_id>` to the Claude CLI

### 6. Cleanup

Delete `/tmp/nanoclaw-heal/<user>/<repo>-<timestamp>` after the container exits.

### 7. Post Results

The container agent uses `send_message` to post back to the Discord channel where the error originated — PR links, fix summaries, or "flagged for human review."

## Session ID Convention

### Commit Message Format

```
fix: handle null response in parser

Closes #42. The API can return null when the store is inactive,
which wasn't handled in the response mapping.

Session-Id: c7e0c991-4c19-46c5-9def-ea609efb5c8e
```

`Session-Id` goes in the commit message trailer (like `Co-Authored-By`). Standard git convention, parseable with `git log --format=%(trailers:key=Session-Id)`.

### How to Automate

- A `prepare-commit-msg` git hook that detects `$CLAUDE_SESSION_ID` and appends the trailer
- Or a Claude Code hook/skill that adds it automatically when committing

### How the Healer Uses It

```bash
# Get the commit that authored line 305
sha=$(git blame -L 305,305 --porcelain src/parqinglot.py | head -1 | cut -d' ' -f1)

# Extract session ID from that commit
session_id=$(git log -1 --format='%(trailers:key=Session-Id,valueonly)' $sha)
```

If `session_id` is found, the container runs `claude -p <prompt> --resume $session_id`. If not found (human-authored code, old commits), the healer starts a fresh session. No degradation, just less context.

Session reuse is a core feature. The commit convention adoption is gradual — devs add it to their workflows over time. The healer is ready for it from launch.

## Gap Analysis

### Reused As-Is

- `GroupQueue` — concurrency control
- `runContainerAgent()` — container spawning with UID/GID, credential mounts
- Container heal skill (`container/skills/heal/SKILL.md`) — branch/PR/summary workflow
- `send_message` MCP tool — posting results back to Discord
- User profile system — linux user lookup, credential validation
- Discord bot connection — already receives all messages

### New Code

| Component | Purpose |
|-----------|---------|
| Message interceptor | Detect `"nanoclaw": "heal"` in Discord messages before normal routing |
| Debouncer | Per `user+repo` timer with batch collection and dedup |
| Traceback parser | Extract `file`, `line` from Python/Node.js stack traces |
| Repo cloner | `git clone --depth 50`, checkout specific commit, cleanup |
| Blame resolver | `git blame` on file:line, extract Session-Id from commit message |
| Reactive heal prompt builder | Error-driven prompt from a batch of errors |
| Contract validator | Validate incoming JSON against required fields |

### Modified Existing Code

| File | Change |
|------|--------|
| Discord channel handler | Route heal payloads to interceptor |
| `src/container-runner.ts` | Accept temp clone dir as repo mount, pass `--resume` flag |
| `docs/CODE-HEALER.md` | Add reactive healing docs and contract |

## New & Modified Files

### New Files

| File | Purpose |
|------|---------|
| `src/reactive-healer.ts` | Message interceptor, debouncer, contract validator, orchestrator |
| `src/reactive-healer.test.ts` | Tests for parsing, debouncing, dedup, validation |
| `src/traceback-parser.ts` | Extract file+line from Python/Node.js/generic stack traces |
| `src/traceback-parser.test.ts` | Tests against real traceback samples |
| `src/repo-cloner.ts` | Clone, checkout, blame, session ID extraction, cleanup |
| `src/repo-cloner.test.ts` | Tests |
| `src/reactive-heal-prompt.ts` | Build error-driven prompt from a batch of errors |

### Modified Files

| File | Change |
|------|--------|
| Discord channel handler | Detect heal payloads, route to `reactive-healer.ts` |
| `src/container-runner.ts` | Accept temp clone dir as repo mount, pass `--resume` flag |
| `src/types.ts` | Add `HealRequest`, `HealBatch`, `ReactiveHealError` types |
| `docs/CODE-HEALER.md` | Add reactive healing section and notification contract |
| `CLAUDE.md` | Add reactive healer to key files table |

## Implementation Order

1. Types + contract validator — `HealRequest` type, validate incoming JSON
2. Traceback parser — extract file+line from Python/Node.js traces
3. Repo cloner — clone, checkout, blame, session ID extraction, cleanup
4. Reactive heal prompt builder — error-batch to agent prompt
5. Debouncer — per user+repo timer, batch collection, dedup
6. Message interceptor — detect heal payloads in Discord, wire to debouncer
7. Container runner changes — temp clone mounts, `--resume` support
8. Channel response — post results back to originating channel
9. Docs — update CODE-HEALER.md with contract and reactive flow

## Out of Scope

- Non-Discord input channels (webhooks, Slack, email) — future work
- Auto-discovery of repos — explicit `repo_url` in payload
- Retry on failed heals — manual re-trigger by posting the error again
- Log-based reactive healing (watching log files in real-time) — scheduled healer handles this
