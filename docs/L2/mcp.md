# @koi/mcp — MCP Transport Layer

**Layer:** L2  
**Depends on:** `@koi/core` (L0), `@koi/errors` (L0u), `@koi/validation` (L0u), `@modelcontextprotocol/sdk`

## Purpose

Transport abstraction and connection lifecycle management for Model Context Protocol (MCP) servers. Provides:

- Transport factory for stdio, Streamable HTTP, and SSE (deprecated) transports
- Connection state machine with explicit states and deterministic transitions
- Pluggable auth provider interface with bearer token support
- Structured error mapping (HTTP status > JSON-RPC code > message pattern)
- Reconnection with exponential backoff and full jitter

## Transport State Machine

```
idle ──► connecting ──► connected ──► closed
              │              │
              ▼              ▼
         auth-needed    reconnecting ──► error ──► connecting
              │              │                        │
              ▼              ▼                        ▼
          connecting      connected                closed
```

Seven states: `idle`, `connecting`, `connected`, `reconnecting`, `auth-needed`, `error`, `closed`.

`closed` is terminal — no transitions out.

## Config Schema

```yaml
servers:
  - name: my-server
    transport:
      transport: http
      url: https://mcp.example.com/v1
      headers:
        Authorization: "Bearer ${MCP_TOKEN}"
    timeoutMs: 30000
    connectTimeoutMs: 10000
    maxReconnectAttempts: 3
```

Transport config is a discriminated union on the `transport` field. Zod validates transport-specific required fields in a single pass.

## Auth Provider

```typescript
const auth: McpAuthProvider = {
  token: () => process.env.MCP_TOKEN,
  onUnauthorized: async ({ status }) => {
    // Refresh token, rotate credentials, etc.
  },
};
```

Built-in: `createBearerAuthProvider(token)` for static tokens.

## Error Mapping Priority

1. **HTTP status code** (401, 403, 429, 5xx) — most reliable for Streamable HTTP
2. **JSON-RPC error code** (-32700, -32600, etc.) — protocol-level
3. **Message pattern** (regex fallback) — last resort for unstructured errors

## Module Structure

| Module | Purpose |
|--------|---------|
| `config.ts` | Discriminated Zod schema, validation, defaults |
| `state.ts` | TransportState union, state machine, transitions |
| `auth.ts` | McpAuthProvider interface, bearer provider |
| `errors.ts` | Structured error mapping (HTTP > JSON-RPC > regex) |
| `transport.ts` | KoiMcpTransport wrapper, SDK transport factory |
| `connection.ts` | McpConnection lifecycle manager |
| `schema.ts` | `normalizeToolSchema()` — MCP schema normalization |
| `tool-adapter.ts` | MCP→Koi tool mapping, namespacing helpers |
| `resolver.ts` | `createMcpResolver()` — Resolver<ToolDescriptor, Tool> |
| `component-provider.ts` | `createMcpComponentProvider()` — ECS integration |

## Resolver

`createMcpResolver(connections)` implements `Resolver<ToolDescriptor, Tool>` for MCP tool discovery.

```typescript
const resolver = createMcpResolver([conn1, conn2]);
const tools = await resolver.discover();     // ToolDescriptor[]
const tool = await resolver.load("server__echo"); // Result<Tool, KoiError>
resolver.onChange?.(() => { /* tools changed */ });
resolver.dispose();
```

### Tool Namespacing

Tools are namespaced as `{serverName}__{toolName}` (double underscore separator). The structured `ToolDescriptor.server` field provides provenance without parsing name conventions.

### Lazy Connection

Servers connect on the first `discover()` call, not at construction. Agent startup is not blocked by MCP server availability.

### Per-Server Cache

- Each server's tool list is cached independently
- `notifications/tools/list_changed` invalidates only the changed server's cache (not all servers)
- Dirty flag per server: `discover()` skips re-mapping for unchanged servers
- Debounced `onChange` notifications (100ms) prevent listener storms

### Partial Failures

Failed servers don't block successful ones. Failures are accessible via `resolver.failures`:

```typescript
await resolver.discover();
for (const f of resolver.failures) {
  console.warn(`${f.serverName}: ${f.error.message}`);
}
```

### Schema Normalization

`normalizeToolSchema(raw)` ensures all inbound MCP schemas are valid JSON Schema before reaching `ToolDescriptor.inputSchema`:

- Missing `type` → adds `type: "object"`
- Missing `properties` → adds `properties: {}`
- `anyOf`/`oneOf` at root → preserved as-is
- `undefined`/`null`/non-object → `{ type: "object", properties: {} }`

## Component Provider

`createMcpComponentProvider({ resolver })` wraps the resolver as a `ComponentProvider` for ECS assembly.

```typescript
const provider = createMcpComponentProvider({ resolver });
const result = await provider.attach(agent); // AttachResult
// result.components — Map<string, Tool>
// result.skipped   — failed servers as SkippedComponent[]
```

- Delegates all discovery/loading to the resolver (single mapping point)
- Failed servers appear in `AttachResult.skipped` with structured error info
- Tools are keyed by `toolToken(name)` in the component map

## Auth Provider

```typescript
interface McpAuthProvider {
  readonly token: () => string | Promise<string> | undefined;
}
```

Async-ready: implementations can be sync (static bearer token) or async (OAuth 2.1 token refresh). Callers always `await` the result.

Built-in: `createBearerAuthProvider(token)` for static API keys.

## Tool Origin

All MCP tools have `origin: "operator"` — they are operator-configured, not bundled (`primordial`) or agent-created (`forged`).

## Design Decisions

1. **Wrapper over SDK Transport** — Koi's `KoiMcpTransport` wraps the SDK transport to avoid leaking SDK types into the API surface. SDK changes are absorbed in `transport.ts` only.
2. **Discriminated union state machine** — Explicit states prevent impossible state combinations. Exhaustive switches catch missed states at compile time.
3. **Structured error codes first** — HTTP status codes and JSON-RPC error codes are protocol contract; message text is not. Regex is fallback only.
4. **Reuses `@koi/errors` backoff** — `computeBackoff` with `DEFAULT_RECONNECT_CONFIG` provides full jitter out of the box. No custom backoff implementation.
5. **AbortController-based shutdown** — `close()` aborts the controller, canceling all in-flight operations. Prevents reconnect-after-close race condition.
6. **Single mapping point** — Resolver is the sole authority for MCP→Koi type conversion. Connection returns raw `McpToolInfo`; resolver normalizes, namespaces, and maps. ComponentProvider delegates to resolver — no direct mapping.
7. **Per-server cache invalidation** — `onChange` from one server does not flush other servers' caches. Reduces `discover()` from O(N) to O(1) network calls for single-server changes.
8. **Lazy connect on first discover** — Agent startup is not blocked by MCP server availability. Servers that are down at startup can connect later via `ensureConnected()`.
9. **Async-ready auth** — `token()` returns `string | Promise<string> | undefined` so the interface never needs a breaking change when OAuth 2.1 support is added.
