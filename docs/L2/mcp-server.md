# @koi/mcp-server — Agent-as-MCP-Server

`@koi/mcp-server` is an L2 package that exposes a Koi agent's tools via the MCP (Model Context Protocol) JSON-RPC interface. External MCP clients can discover and call the agent's tools — including dynamically forged ones — through a standard protocol.

---

## Why It Exists

Koi agents accumulate tools over their lifetime: built-in tools, MCP-sourced tools, and auto-forged composite tools. Without `@koi/mcp-server`, these tools are only available within the Koi runtime. This package makes the agent a **tool server** that any MCP client can connect to.

```
BEFORE: Tools trapped inside the agent
┌──────────────────────────────┐
│  Koi Agent                   │
│  ┌────┐ ┌────┐ ┌──────────┐ │
│  │read│ │parse│ │fetch-    │ │     External tools
│  │file│ │json │ │parse-save│ │     can't reach these
│  └────┘ └────┘ └──────────┘ │
└──────────────────────────────┘

AFTER: Agent exposes tools via MCP
┌──────────────────────────────┐         ┌─────────────┐
│  Koi Agent                   │   MCP   │ Claude Code  │
│  ┌────┐ ┌────┐ ┌──────────┐ │◄───────►│ IDE plugins  │
│  │read│ │parse│ │fetch-    │ │  JSON-  │ Other agents │
│  │file│ │json │ │parse-save│ │  RPC    │ Workflows    │
│  └────┘ └────┘ └──────────┘ │         └─────────────┘
└──────────────────────────────┘
```

### Hot-reload

When auto-forge creates a new tool, the MCP server automatically picks it up:

```
1. Auto-forge saves new brick to ForgeStore
2. ForgeStore.watch() fires StoreChangeEvent
3. Tool cache invalidates
4. Server sends `notifications/tools/list_changed`
5. MCP client re-fetches tool list
6. New tool is available — zero restart required
```

---

## Architecture

### Layer position

```
L0  @koi/core                ─ Agent, Tool, ForgeStore, JsonObject (types only)
L2  @koi/mcp-server          ─ this package (depends on L0 + @modelcontextprotocol/sdk)
```

### Internal module map

```
index.ts                     ← public re-exports
│
├── server.ts                ← createMcpServer() factory
├── handler.ts               ← MCP request handler registration
├── tool-cache.ts            ← event-driven tool cache
└── transport.ts             ← createStdioServerTransport()
```

### Request flow

```
MCP Client                        MCP Server
    │                                  │
    │── initialize ──────────────────→ │  capabilities negotiation
    │← { tools: { listChanged: true }}│
    │                                  │
    │── tools/list ──────────────────→ │
    │                                  │  ToolCache.list()
    │                                  │  → agent.query<Tool>("tool:")
    │← [{ name, description, ... }]   │
    │                                  │
    │── tools/call("read_file", {})──→ │
    │                                  │  ToolCache.get("read_file")
    │                                  │  → tool.execute(args)
    │← { content: [{ text: "..." }] } │
    │                                  │
    │                                  │  ┌── ForgeStore change ──┐
    │                                  │  │  cache.invalidate()   │
    │← tools/list_changed ───────────  │  │  sendToolListChanged()│
    │                                  │  └───────────────────────┘
    │── tools/list ──────────────────→ │
    │← [{ ..., new_forged_tool }]      │  ← includes newly forged tool
```

---

## API Reference

### `createMcpServer(config)`

Factory that returns an `McpServer` with lifecycle control.

```typescript
import { createMcpServer } from "@koi/mcp-server";
import { createStdioServerTransport } from "@koi/mcp-server";

const server = createMcpServer({
  agent,                        // Koi Agent entity
  transport: createStdioServerTransport(),
  name: "my-agent-server",     // default: agent.manifest.name
  version: "1.0.0",            // default: "1.0.0"
  forgeStore,                   // optional: enables hot-reload
});

await server.start();
console.log(`Serving ${server.toolCount()} tools`);

// On shutdown:
await server.stop();
```

**Config:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | `Agent` | required | Agent whose tools to expose |
| `transport` | `Transport` | required | MCP SDK transport (stdio, HTTP, in-memory) |
| `name` | `string` | `agent.manifest.name` | Server name in MCP handshake |
| `version` | `string` | `"1.0.0"` | Server version in MCP handshake |
| `forgeStore` | `ForgeStore` | `undefined` | Enables hot-reload via `watch()` |

**Returns:** `McpServer`

| Method | Signature | Description |
|--------|-----------|-------------|
| `start` | `() => Promise<void>` | Connect transport and begin accepting requests |
| `stop` | `() => Promise<void>` | Dispose cache and close server |
| `toolCount` | `() => number` | Number of tools currently exposed |

### `createToolCache(config)`

Event-driven tool cache with lazy rebuild and ForgeStore subscription.

```typescript
import { createToolCache } from "@koi/mcp-server";

const cache = createToolCache({
  agent,
  forgeStore,            // optional: subscribes to watch() for invalidation
  onChange: () => {       // called when cache is invalidated
    notifyClients();
  },
});

cache.list();           // → readonly ToolCacheEntry[]
cache.get("read_file"); // → ToolCacheEntry | undefined
cache.count();          // → number
cache.invalidate();     // force rebuild on next access
cache.dispose();        // unsubscribe from ForgeStore
```

### `createStdioServerTransport()`

Creates a stdio-based MCP transport (stdin/stdout JSON-RPC).

```typescript
import { createStdioServerTransport } from "@koi/mcp-server";

const transport = createStdioServerTransport();
```

---

## Integration Example

### Full self-extension pipeline

```typescript
import { createCrystallizeMiddleware, createAutoForgeMiddleware } from "@koi/crystallize";
import { createOptimizerMiddleware } from "@koi/forge-optimizer";
import { createMcpServer, createStdioServerTransport } from "@koi/mcp-server";

// 1. Pattern detection
const crystallize = createCrystallizeMiddleware({
  readTraces: async () => ({ ok: true, value: traces }),
  onCandidatesDetected: (candidates) => {
    console.log(`${candidates.length} patterns detected`);
  },
});

// 2. Auto-forge (closes the pipeline gap)
const autoForge = createAutoForgeMiddleware({
  crystallizeHandle: crystallize,
  forgeStore,
  scope: "agent",
});

// 3. Statistical optimization
const optimizer = createOptimizerMiddleware({
  store: forgeStore,
});

// 4. Expose tools via MCP (including forged ones)
const mcpServer = createMcpServer({
  agent,
  transport: createStdioServerTransport(),
  forgeStore,  // hot-reload when new tools are forged
});

await mcpServer.start();
```

---

## Design Decisions

1. **SDK-based protocol handling** — Uses `@modelcontextprotocol/sdk` for JSON-RPC framing, capabilities negotiation, and transport abstraction. No custom protocol implementation.
2. **Lazy caching** — Tool cache rebuilds from `agent.query("tool:")` only when accessed after invalidation. No periodic polling.
3. **Input validation at boundary** — Tool call arguments are validated as JSON objects before being passed to tool executors. The MCP client is an external system boundary.
4. **`listChanged` capability** — Advertised when a ForgeStore is provided. The server sends `notifications/tools/list_changed` when the store fires change events, enabling clients to re-fetch the tool list.
5. **Transport-agnostic** — The server accepts any MCP SDK `Transport`. Stdio is provided as a convenience; HTTP and in-memory transports can be injected.
6. **No L1 dependency** — The server only needs an `Agent` entity (L0 type) and optionally a `ForgeStore`. It can run in any environment that provides these.
