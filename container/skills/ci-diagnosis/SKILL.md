---
name: ci-diagnosis
description: Diagnose GitHub Actions CI failures — parse log output, identify failure patterns, and map to fix strategies
---

# CI Diagnosis

When diagnosing a CI failure, follow this structured approach.

## Step 1: Get the Failure Logs

```bash
# Get the latest failed run
GH_CONFIG_DIR=/workspace/extra/.gh-config gh run list --repo rc-international/{repo} --status failure --limit 3

# Get detailed logs for a specific run
GH_CONFIG_DIR=/workspace/extra/.gh-config gh run view {run_id} --repo rc-international/{repo} --log-failed
```

## Step 2: Identify the Failure Pattern

| Pattern | Indicator | Fix Strategy |
|---------|-----------|-------------|
| **Expired token/secret** | `Error: Resource not accessible`, `Bad credentials`, `RequestError [HttpError]: 401` | Regenerate token/secret in repo settings |
| **Dependency install fail** | `npm ERR!`, `pip install failed`, `ModuleNotFoundError` | Fix lockfile, update dep version, or pin compatible version |
| **Lint/format error** | `eslint`, `biome`, `ruff`, `black --check` exit non-zero | Run linter with `--fix`, commit results |
| **Test failure** | `FAIL`, `AssertionError`, `Expected X got Y` | Read test, read code, fix the bug or update the test |
| **Build failure** | `tsc` errors, `Type error`, `Cannot find module` | Fix type errors, missing imports, or tsconfig |
| **Version mismatch** | `engines.node`, `python_requires`, matrix version fails | Update CI matrix or fix compatibility |
| **Flaky test** | Passes on retry, timeout errors, race conditions | Add retry, increase timeout, or fix the race |
| **Missing env/secret** | `undefined`, `ENOENT .env`, `KeyError` | Add secret to repo settings or fix env loading |
| **Playwright/E2E fail** | `Timeout`, `Element not found`, `net::ERR_CONNECTION_REFUSED` | Check if target service is running, update selectors |

## Step 3: Verify Before Fixing

Before implementing a fix:
1. Check if the failure is consistent (same error in last 3+ runs)
2. Check if the failure is in the CI config vs the source code
3. Check if someone else already has a fix PR open

## Step 4: Common Quick Fixes

### Lint errors blocking tests
```bash
# TypeScript
npx biome check --write .
# or
npx eslint --fix .

# Python
ruff check --fix .
ruff format .
```

### Outdated lockfile
```bash
# Node
rm package-lock.json && npm install
# or
rm bun.lockb && bun install

# Python
pip-compile --upgrade requirements.in
```

### CI matrix version too old
Edit `.github/workflows/*.yml` — drop unsupported versions from the matrix.
