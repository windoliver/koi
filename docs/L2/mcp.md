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

## Design Decisions

1. **Wrapper over SDK Transport** — Koi's `KoiMcpTransport` wraps the SDK transport to avoid leaking SDK types into the API surface. SDK changes are absorbed in `transport.ts` only.
2. **Discriminated union state machine** — Explicit states prevent impossible state combinations. Exhaustive switches catch missed states at compile time.
3. **Structured error codes first** — HTTP status codes and JSON-RPC error codes are protocol contract; message text is not. Regex is fallback only.
4. **Reuses `@koi/errors` backoff** — `computeBackoff` with `DEFAULT_RECONNECT_CONFIG` provides full jitter out of the box. No custom backoff implementation.
5. **AbortController-based shutdown** — `close()` aborts the controller, canceling all in-flight operations. Prevents reconnect-after-close race condition.
