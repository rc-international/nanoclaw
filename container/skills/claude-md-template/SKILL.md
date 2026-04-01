---
name: claude-md-template
description: Standard CLAUDE.md template and repo analysis guide for RC International repos
---

# CLAUDE.md Template

Use this template when generating CLAUDE.md files for RC International repos.

## Analysis Steps

Before writing, gather facts from the repo:

```bash
# Language and deps
ls package.json pyproject.toml Cargo.toml go.mod Gemfile 2>/dev/null

# Scripts/commands
cat package.json 2>/dev/null | jq '.scripts' || cat pyproject.toml 2>/dev/null | grep -A20 '\[tool\.'

# CI workflows
ls .github/workflows/ 2>/dev/null

# Test setup
ls -d tests/ test/ __tests__/ spec/ 2>/dev/null

# Linting
ls .eslintrc* biome.json .prettierrc* ruff.toml pyproject.toml 2>/dev/null

# Docker
ls Dockerfile docker-compose.yml 2>/dev/null

# Project structure (top-level only)
ls -1
```

## Template

```markdown
# {Repo Name}

{One-line description from package.json/pyproject.toml or README first line}

## Setup

\`\`\`bash
{exact install command: npm install / bun install / pip install -r requirements.txt / etc.}
\`\`\`

## Run

\`\`\`bash
{exact run command from scripts section}
\`\`\`

## Tech Stack

- **Language**: {TypeScript/Python/etc.}
- **Framework**: {Express/FastAPI/Next.js/etc.}
- **Database**: {PostgreSQL/SQLite/etc. — only if present}
- **Key deps**: {2-3 most important dependencies}

## Project Structure

{5-10 lines covering the key directories}

## Testing

\`\`\`bash
{exact test command: npm test / bun test / pytest / etc.}
\`\`\`

{Test framework name, rough test count if visible}

## CI/CD

{List workflow files and what they do}

## Conventions

{Only include if there are non-obvious patterns — otherwise omit this section entirely}
```

## Rules

- Only document what you can verify from the code
- Use exact commands, not guesses
- If something is unclear, write `TODO: verify` instead of fabricating
- Keep it under 80 lines — CLAUDE.md should be scannable
- Don't duplicate the README — focus on what an AI agent needs to know
- Omit empty sections rather than writing "N/A"
