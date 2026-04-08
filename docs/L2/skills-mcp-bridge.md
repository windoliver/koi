# Skills-MCP Bridge

**Layer:** L3 (lives in `@koi/runtime`)  
**Location:** `packages/meta/runtime/src/skills-mcp-bridge.ts`  
**Purpose:** Connects MCP tool discovery to the skill registry so MCP-derived tools appear as skills.

Thin bridge that maps `McpResolver` tool descriptors to `SkillMetadata` with `source: "mcp"` and registers them via `SkillsRuntime.registerExternal()`. Subscribes to resolver change notifications for live updates.

## Architecture

```
createSkillsMcpBridge({ resolver, runtime })
  ├── sync()    ← discover() → map → registerExternal(), subscribe onChange
  └── dispose() ← unsubscribe, clear skills
```

### Mapping: ToolDescriptor → SkillMetadata

| ToolDescriptor field | SkillMetadata field | Notes |
|---------------------|---------------------|-------|
| `name` | `name` | Already namespaced `server__tool` |
| `description` | `description` | Direct passthrough |
| — | `source` | Always `"mcp"` |
| `server` | `dirPath` | `"mcp://{server}"` URI |
| `tags` | `tags` | Prefixed with `["mcp", server]` |
| `inputSchema` | — | Dropped (no SkillMetadata field) |

### Race Safety

The bridge serializes sync operations to prevent concurrent `discover()` calls:

- **`disposed`** flag — prevents `registerExternal` after dispose
- **`syncInFlight`** flag — queues onChange as dirty instead of concurrent discover
- **`dirty`** flag — triggers re-sync after current sync completes
- **`version`** counter — discards stale results

### Lifecycle

```
Host creates:  McpResolver → SkillsRuntime → SkillsMcpBridge
Host calls:    bridge.sync()   — initial discovery + onChange subscription
Host disposes: bridge.dispose() → resolver.dispose()
```

The bridge does NOT own the resolver or runtime lifecycle. `dispose()` unsubscribes onChange and calls `registerExternal([])` to clear stale skills.

## Precedence

MCP skills have the lowest priority: `project > user > bundled > mcp`. Any filesystem skill with the same name shadows the MCP skill.

## Dependencies

- `@koi/core` (L0) — `ToolDescriptor` type
- `@koi/mcp` (L2) — `McpResolver` interface
- `@koi/skills-runtime` (L2) — `SkillsRuntime`, `SkillMetadata`
