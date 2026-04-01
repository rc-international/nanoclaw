---
name: dependency-update
description: Check for outdated dependencies, assess breaking change risk, and create update PRs with test verification
---

# Dependency Update

When updating dependencies for a repo, follow this process.

## Step 1: Identify Outdated Deps

### Node/TypeScript
```bash
npm outdated --json 2>/dev/null || bun outdated 2>/dev/null
```

### Python
```bash
pip list --outdated --format=json 2>/dev/null
```

## Step 2: Assess Risk

For each outdated dependency:

1. **Check semver jump**: patch (safe) → minor (usually safe) → major (review changelog)
2. **Check changelog**: Look for breaking changes in the release notes
3. **Check usage**: Search the codebase for how the dep is used — more usage = more risk

### Risk levels

| Jump | Usage | Risk | Action |
|------|-------|------|--------|
| Patch | Any | Low | Update, run tests |
| Minor | Light | Low | Update, run tests |
| Minor | Heavy | Medium | Update, run tests, review changes |
| Major | Any | High | Read changelog, update code if needed, run tests |

## Step 3: Update

### Node
```bash
# Safe updates (patch + minor)
npm update

# Specific major update
npm install {package}@latest
```

### Python
```bash
pip install --upgrade {package}
# Regenerate lockfile
pip-compile --upgrade requirements.in
```

## Step 4: Verify

```bash
# Run tests
npm test || bun test || pytest

# Run linter
npm run lint || ruff check .

# Run build
npm run build || tsc --noEmit
```

## Step 5: PR

Branch: `chore/update-deps-{date}`

PR body should include:
- List of updated packages with old → new versions
- Risk assessment for major bumps
- Test results
- Any code changes required for compatibility

## Security Vulnerabilities

If the update is triggered by a security advisory:
- Prioritize the vulnerable package
- Include the CVE/advisory ID in the PR title
- Note severity level (critical/high/medium/low)
