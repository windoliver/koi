# Package Descriptions

Every `package.json` in the Koi monorepo must have a `description` field. This document
explains why, what the rules are, and how enforcement works.

---

## Why

Koi has 194 workspace packages. Without descriptions:

- `npm search`, `bun pm ls`, and `npx` show blank entries — users cannot tell what a package does
- IDE tooltips (VS Code, WebStorm) show `(no description)` on hover
- Onboarding developers must open source code to understand each package's purpose
- Automated tooling (dependency audits, changelogs, registry pages) has no metadata to surface

With descriptions, every package is self-documenting at the registry level:

```
@koi/engine-loop   Execute pure TypeScript ReAct loop with parallel tool calls
@koi/middleware-pii Detect and redact PII (email, SSN, card, IP, MAC, phone, URL) in agent I/O
@koi/channel-slack  Connect Slack bots via Socket Mode or HTTP Events API
```

---

## Description Rules

| Rule | Constraint |
|------|-----------|
| **Required** | Every `package.json` must have a `description` field |
| **Non-empty** | Must be a non-empty string |
| **Max length** | ≤120 characters |
| **Voice** | Verb-first active voice (npm convention) |
| **No articles** | Must not start with "A " or "The " |

### Good examples

```
"Detect and redact PII (email, SSN, card, IP, MAC, phone, URL) in agent I/O"
"Execute pure TypeScript ReAct loop with parallel tool calls and iterative Reason+Act cycles"
"Connect Slack bots via Socket Mode or HTTP Events API"
```

### Bad examples

```
"A middleware for PII detection"          ← starts with "A "
"The Slack channel adapter"               ← starts with "The "
""                                        ← empty
"This package provides a comprehensive…"  ← marketing tone, likely >120 chars
```

---

## CI Enforcement

**`scripts/check-descriptions.ts`** validates all workspace packages on every pull request.

### What it checks

1. Every `package.json` under `packages/`, plus root, `tests/e2e/`, and `recipes/`, has a `description`
2. Description is a non-empty string
3. Description is ≤120 characters
4. Description does not start with "A " or "The "

### Running the check

```bash
# Standalone
bun scripts/check-descriptions.ts

# Via npm script
bun run check:descriptions
```

### CI integration

The check runs in `.github/workflows/ci.yml` after lint and before build:

```yaml
- name: Check package descriptions
  run: bun run check:descriptions
```

A violation blocks the PR immediately.

---

## Adding a Description to a New Package

When creating a new workspace package:

1. Add a `"description"` field to `package.json` immediately after `"name"`
2. Follow the rules above (verb-first, ≤120 chars, no article prefix)
3. Run `bun run check:descriptions` to verify
4. Optionally add the entry to `scripts/add-descriptions.ts` lookup table for reference

---

## Bulk Update Script

**`scripts/add-descriptions.ts`** is a one-time script that maintains a lookup table of all
package descriptions. It can be re-run safely (idempotent).

```bash
# Preview changes without writing
bun scripts/add-descriptions.ts --dry-run

# Apply descriptions
bun scripts/add-descriptions.ts
```

The script inserts `"description"` immediately after `"name"` in each `package.json`,
preserving all other fields and formatting.

---

## New Packages (Post Engine Split)

The following packages were introduced during the engine split (#871):

| Package | Layer | Description |
|---------|-------|-------------|
| `@koi/engine-compose` | L1 | Compose middleware chains into onion-wrapped engine adapters |
| `@koi/engine-reconcile` | L1 | K8s-style desired-state reconciliation with Erlang/OTP supervision strategies |
| `@koi/session-state` | L0u | Per-session state management with FIFO eviction for middleware authors |
| `@koi/test-utils-contracts` | L0u | Interface conformance test suites for L0 contracts |
| `@koi/test-utils-mocks` | L0u | Mock agent, registry, and middleware implementations for testing |
| `@koi/test-utils-store-contracts` | L0u | Storage backend conformance test suites |
