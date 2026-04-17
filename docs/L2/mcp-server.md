# @koi/mcp-server — Agent + Platform as MCP Server

`@koi/mcp-server` is an L2 package that exposes a Koi agent's tools **and platform capabilities** via the MCP (Model Context Protocol) JSON-RPC interface. External MCP clients can discover and call the agent's tools — including dynamically forged ones — through a standard protocol. Additionally, platform tools expose mailbox, task board, and agent registry to external agents.

---

## Why It Exists

Koi agents accumulate tools over their lifetime: built-in tools, MCP-sourced tools, and auto-forged composite tools. Without `@koi/mcp-server`, these tools and platform capabilities are only available within the Koi runtime. This package makes the agent a **tool server** and **platform gateway** that any MCP client can connect to.

```
BEFORE: Tools + platform trapped inside the agent
┌──────────────────────────────────┐
│  Koi Agent                       │
│  ┌────┐ ┌────┐ ┌──────────────┐ │
│  │read│ │parse│ │ mailbox/tasks │ │     External agents
│  │file│ │json │ │ registry     │ │     can't reach these
│  └────┘ └────┘ └──────────────┘ │
└──────────────────────────────────┘

AFTER: Agent exposes tools + platform via MCP
┌──────────────────────────────────┐         ┌─────────────┐
│  Koi Agent                       │   MCP   │ Claude Code  │
│  ┌────┐ ┌────┐ ┌──────────────┐ │◄───────►│ Containers   │
│  │read│ │parse│ │ mailbox/tasks │ │  JSON-  │ IDE plugins  │
│  │file│ │json │ │ registry     │ │  RPC    │ Other agents │
│  └────┘ └────┘ └──────────────┘ │         └─────────────┘
└──────────────────────────────────┘
```

### Hot-reload (agent tools)

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
L0  @koi/core                ─ Agent, Tool, ForgeStore, MailboxComponent, ManagedTaskBoard, AgentRegistry
L0u @koi/tools-core          ─ buildTool() for real Koi Tool creation
L2  @koi/mcp-server          ─ this package (depends on L0 + L0u + @modelcontextprotocol/sdk)
```

### Internal module map

```
index.ts                     ← public re-exports
│
├── server.ts                ← createMcpServer() factory
├── handler.ts               ← MCP request handler registration
├── tool-cache.ts            ← event-driven tool cache (agent + platform tools)
├── transport.ts             ← createStdioServerTransport()
├── config.ts                ← McpServerConfig, PlatformCapabilities
├── platform-tools.ts        ← 7 platform tool builders (real Koi Tools)
└── errors.ts                ← error sanitization for MCP boundary
```

### Two modes

1. **Agent tools mode** (v1): proxies `agent.query("tool:")` via ToolCache with ForgeStore hot-reload
2. **Platform tools mode** (v2): exposes mailbox, tasks, registry as dedicated MCP tools built via `buildTool()`

Both modes are capability-gated and composable. Platform tools pass through the existing Koi safety envelope (permissions middleware, exfiltration guard) because they are real `Tool` objects.

---

## Platform Tools (7)

| MCP Tool | Subsystem | Security |
|----------|-----------|----------|
| `koi_send_message` | MailboxComponent | `from` = callerId enforced, `kind` = "event" only |
| `koi_list_messages` | MailboxComponent | Max 100, lean projections |
| `koi_list_tasks` | ManagedTaskBoard | Status filter, lean projections, max 100 |
| `koi_get_task` | ManagedTaskBoard | Full task details by ID |
| `koi_update_task` | ManagedTaskBoard | Atomic `startTask()`, owned `completeOwnedTask`/`failOwnedTask` |
| `koi_task_output` | ManagedTaskBoard | Completed task results only |
| `koi_list_agents` | AgentRegistry | `VisibilityContext` with callerId, strict projection (no metadata/generation) |

---

## API Reference

### `createMcpServer(config)`

Factory that returns an `McpServer` with lifecycle control.

```typescript
import { createMcpServer, createStdioServerTransport } from "@koi/mcp-server";

const server = createMcpServer({
  agent,                                // Koi Agent entity
  transport: createStdioServerTransport(),
  name: "my-agent-server",              // default: agent.manifest.name
  version: "1.0.0",                     // default: "1.0.0"
  forgeStore,                            // optional: enables hot-reload
  platform: {                            // optional: enables platform tools
    callerId: agentId("mcp-client-1"),
    mailbox,                             // enables koi_send_message + koi_list_messages
    taskBoard,                           // enables koi_list_tasks + koi_get_task + koi_update_task + koi_task_output
    registry,                            // enables koi_list_agents
  },
});

await server.start();
console.log(`Serving ${server.toolCount()} tools`);
await server.stop();
```

**Config:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | `Agent` | required | Agent whose tools to expose |
| `transport` | `Transport` | required | MCP SDK transport (stdio) |
| `name` | `string` | `agent.manifest.name` | Server name in MCP handshake |
| `version` | `string` | `"1.0.0"` | Server version in MCP handshake |
| `forgeStore` | `ForgeStore` | `undefined` | Enables hot-reload via `watch()` |
| `platform` | `PlatformCapabilities` | `undefined` | Enables platform tools |

**PlatformCapabilities:**

| Field | Type | Description |
|-------|------|-------------|
| `callerId` | `AgentId` | required — identity for platform operations |
| `mailbox` | `MailboxComponent` | optional — enables mailbox tools |
| `taskBoard` | `ManagedTaskBoard` | optional — enables task tools |
| `registry` | `AgentRegistry` | optional — enables agent list tool |

**Returns:** `McpServer`

| Method | Signature | Description |
|--------|-----------|-------------|
| `start` | `() => Promise<void>` | Connect transport and begin accepting requests |
| `stop` | `() => Promise<void>` | Dispose cache and close server |
| `toolCount` | `() => number` | Number of tools currently exposed |

---

## Security Design

Security was validated by Codex adversarial review before implementation:

1. **Stdio only** — HTTP/SSE transports deferred until per-connection authentication is designed
2. **Real Koi Tools** — platform tools are built via `buildTool()` with proper `ToolPolicy` and `origin: "primordial"`, passing through the existing safety envelope
3. **callerId enforcement** — `koi_send_message` always sets `from` to the configured `callerId`, never caller-supplied
4. **Event-only mailbox** — external clients can only send `"event"` kind messages, no request/response flows
5. **Owned task mutations** — uses atomic `startTask()` and owned variants (`completeOwnedTask`, `failOwnedTask`) to prevent cross-agent races
6. **Visibility-filtered registry** — passes `VisibilityContext` with `callerId` to `registry.list()`, returns strict projections excluding `metadata` and `generation`
7. **Sanitized errors** — error messages are stripped of stack traces and internal details before returning to MCP clients

---

## Design Decisions

1. **SDK-based protocol handling** — Uses `@modelcontextprotocol/sdk` for JSON-RPC framing, capabilities negotiation, and transport abstraction
2. **Lazy caching** — Tool cache rebuilds from `agent.query("tool:")` only when accessed after invalidation
3. **`listChanged` capability** — Advertised when a ForgeStore is provided. The server sends `notifications/tools/list_changed` when the store fires change events
4. **Transport-agnostic** — The server accepts any MCP SDK `Transport`. Stdio is provided as a convenience
5. **No L1 dependency** — The server only needs an `Agent` entity (L0 type) and optional L0 subsystem handles
6. **Capability gating** — Only tools for provided subsystem handles are registered. If `platform.mailbox` is undefined, mailbox tools are not exposed

## Notes (#1557 review — PR #1659)

No behavioral changes in this package. Two mock `TaskBoard` fixtures in
`contract.test.ts` and `platform-tools.test.ts` were updated to include a
`blockedBy: () => undefined` stub — the `TaskBoard` interface gained a
`blockedBy(taskId)` method in `@koi/task-board` (review issue 14A) and these
fixtures need to satisfy the new interface shape. No runtime logic or public
surface touched.

## E2E test helper (#1852)

`src/__test-echo-server__.ts` is a minimal stdio MCP echo server used to reproduce and verify fix #1852 (stdio servers must show `connected`, not `needs-auth`). It is a dev/test artifact — not part of the public package exports — and should not be removed without updating the `.mcp.json` E2E configuration that references it.

## Completion output defaulting (#1785)

`koi_update_task(action: "complete")` now defaults `output` to
`"Completed: <task.subject>"` when omitted, matching the `task_update` behavior in
`@koi/task-tools`. Non-string `output` values (objects, numbers) are rejected with a
type error before the default applies — only `undefined` or empty string triggers the
fallback. This aligns both task-completion surfaces (library tools and MCP platform
tools) so callers get consistent behavior regardless of entry point.
