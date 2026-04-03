# Codex MCP Recipe

Run [OpenAI Codex](https://github.com/openai/codex) as a governed MCP tool server inside a Koi agent — zero code, just YAML.

## Prerequisites

- Bun 1.3.x installed
- `codex` CLI installed and on PATH (`npm install -g @openai/codex`)
- `OPENAI_API_KEY` environment variable set

## Quick Start

```bash
# From the repo root
bun install

# Run the recipe tests (no Codex install needed — tests use mocks)
bun test recipes/codex-mcp/

# Use the manifest with koi (when running a real agent)
koi run recipes/codex-mcp/koi.yaml
```

## What This Recipe Does

```
┌─────────────────────────────────────────────────────────┐
│                    Koi Agent                            │
│                                                         │
│  koi.yaml ──► Manifest Loader                          │
│                   │                                     │
│                   ▼                                     │
│  ┌─────────────────────────────────┐                   │
│  │   Middleware Stack (in order)   │                   │
│  │  1. permissions — allow/deny    │                   │
│  │  2. pay — $500/day budget cap   │                   │
│  │  3. audit — full call logging   │                   │
│  └───────────────┬─────────────────┘                   │
│                  │                                      │
│                  ▼                                      │
│  ┌─────────────────────────────────┐                   │
│  │  MCP Component Provider         │                   │
│  │  tools: mcp/codex/codex_*      │                   │
│  └───────────────┬─────────────────┘                   │
│                  │ stdio                                │
│                  ▼                                      │
│  ┌─────────────────────────────────┐                   │
│  │  codex mcp-server               │                   │
│  │  (CODEX_SANDBOX=true)           │                   │
│  └─────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────┘
```

All Codex tools are namespaced as `mcp/codex/<tool_name>` and pass through the governance middleware stack before execution.

## Customization

### Permissions

Edit the `permissions` section in `koi.yaml`:

```yaml
permissions:
  allow:
    - "mcp/codex/codex_generate"          # Always allowed
  deny:
    - "mcp/codex/*:production/**"         # Block production paths
  ask:
    - "mcp/codex/codex_edit"              # Requires human approval
```

### Budget

Adjust the daily budget in the middleware options:

```yaml
middleware:
  - name: "@koi/middleware-pay"
    options:
      dailyBudget: 1000   # Raise to $1000/day
```

### Additional Middleware

Add more middleware to the stack (order matters — first in the list runs first):

```yaml
middleware:
  - name: "@koi/middleware-permissions"
  - name: "@koi/middleware-pay"
    options:
      dailyBudget: 500
  - name: "@koi/middleware-audit"
  - name: "@koi/middleware-semantic-retry"  # Add retry logic
```

## Security Considerations

- **Sandbox mode**: `CODEX_SANDBOX=true` is set by default — Codex runs file operations in a sandboxed environment
- **Permission rules**: The deny rule `mcp/codex/*:production/**` blocks any Codex tool from operating on production paths
- **Human-in-the-loop**: `codex_edit` requires explicit approval via the `ask` permission
- **Budget cap**: The pay middleware enforces a $500/day spending limit by default
- **Audit trail**: All tool calls are logged by the audit middleware

## Running Tests

```bash
# Run recipe tests only
bun test recipes/codex-mcp/

# Type-check
bunx tsc --noEmit -p recipes/codex-mcp/tsconfig.json

# Lint
biome check recipes/codex-mcp/
```
