# Recipe: Codex MCP Integration

Run OpenAI Codex as a governed MCP tool server inside a Koi agent — zero code, just YAML.

---

## Why It Exists

Codex exposes an MCP-compatible server (`codex mcp-server`) that provides code generation and editing tools over stdio. This recipe shows how to wire it into a Koi agent with full governance: permission rules control which tools are allowed, a budget middleware caps daily spend, and an audit middleware logs every call.

```
WITHOUT governance:
  Agent ──► codex mcp-server ──► unrestricted code edits

WITH this recipe:
  Agent ──► permissions ──► pay ($500/day) ──► audit ──► codex mcp-server
            │                                             │
            deny production/**                            sandboxed execution
```

---

## Data Flow

```
koi.yaml
  │
  ▼
loadManifest()          ← validates YAML, returns LoadedManifest
  │
  ├─ tools.mcp[0]      ← { name: "codex", options: { command: "codex mcp-server", ... } }
  ├─ middleware[0..2]   ← permissions → pay → audit
  └─ permissions        ← allow / deny / ask rules
  │
  ▼
createMcpComponentProvider()   ← connects to Codex via stdio, discovers tools
  │
  ▼
mcp/codex/codex_generate       ← namespaced tool components
mcp/codex/codex_edit           ← attached to agent via ECS
```

All tool calls flow through the middleware stack before reaching the MCP transport.

---

## Manifest Anatomy

### MCP Tool Declaration

```yaml
tools:
  mcp:
    - name: codex
      options:
        command: "codex mcp-server"
        transport: stdio
        env:
          CODEX_SANDBOX: "true"
```

The `tools.mcp` section declares MCP servers. Each entry becomes a set of `mcp/<server>/<tool>` components after discovery. The `options.env` map is passed to the child process — `CODEX_SANDBOX=true` tells Codex to run file operations in a sandboxed environment.

### Governance Middleware

```yaml
middleware:
  - name: "@koi/middleware-permissions"
  - name: "@koi/middleware-pay"
    options:
      dailyBudget: 500
  - name: "@koi/middleware-audit"
```

Middleware runs in declaration order. The permissions middleware evaluates allow/deny/ask rules before each tool call. The pay middleware tracks token spend against a daily budget. The audit middleware logs every call for compliance review.

### Permission Rules

```yaml
permissions:
  allow:
    - "mcp/codex/codex_generate"        # Always allowed — no approval needed
  deny:
    - "mcp/codex/*:production/**"       # Block all Codex tools on production paths
  ask:
    - "mcp/codex/codex_edit"            # Requires human approval each time
```

Rules are evaluated in order: deny > ask > allow. The glob pattern `mcp/codex/*:production/**` matches any Codex tool when the argument contains a production path.

---

## Layer Position

```
L0   @koi/core         ← Agent, Tool, toolToken (types + branded constructors)
L0u  @koi/manifest     ← loadManifest() validates koi.yaml
L2   @koi/mcp          ← createMcpComponentProvider() wires MCP servers
     recipes/codex-mcp ← this recipe (private, test-only workspace)
```

The recipe imports from L0 and L2 only. No L1 (`@koi/engine`) dependency — it validates the manifest and MCP wiring without running the kernel.

---

## Test Coverage

| Test | Validates |
|------|-----------|
| `koi.yaml loads without errors` | Manifest parses with zero warnings |
| `manifest has codex MCP tool config` | `tools[0].name === "codex"` with correct command in options |
| `manifest declares governance middleware` | permissions + pay ($500) + audit all present |
| `codex tools wrap as mcp/codex/*` | Mock MCP server tools namespaced correctly |
| `wrapped tool executes via mock` | End-to-end tool call through mock transport |

Tests use the same mock factory DI pattern as `@koi/mcp`'s own test suite — no real Codex installation needed.

---

## Extending This Recipe

**Add more MCP servers** — append entries to `tools.mcp`:

```yaml
tools:
  mcp:
    - name: codex
      options:
        command: "codex mcp-server"
        transport: stdio
        env:
          CODEX_SANDBOX: "true"
    - name: filesystem
      options:
        command: "npx @anthropic/mcp-server-filesystem /workspace"
        transport: stdio
```

**Adjust budget** — change `dailyBudget` in the pay middleware options.

**Add retry logic** — append `@koi/middleware-semantic-retry` to the middleware stack.

**Switch to HTTP transport** — for remote Codex servers, use `transport: http` with a `url` field instead of `command`.

---

## Running

```bash
# Tests (mocked — no Codex install needed)
bun test recipes/codex-mcp/

# Type check
bunx tsc --noEmit -p recipes/codex-mcp/tsconfig.json

# Lint
bunx biome check recipes/codex-mcp/
```
