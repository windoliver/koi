# @koi/mcp — MCP Transport Layer

**Layer:** L2  
**Depends on:** `@koi/core` (L0), `@koi/errors` (L0u), `@koi/secure-storage` (L0u), `@koi/validation` (L0u), `@modelcontextprotocol/sdk`

## Purpose

Transport abstraction and connection lifecycle management for Model Context Protocol (MCP) servers. Provides:

- Transport factory for stdio, Streamable HTTP, and SSE (deprecated) transports
- Connection state machine with explicit states and deterministic transitions
- Pluggable auth provider interface with bearer token support
- Structured error mapping (HTTP status > JSON-RPC code > message pattern)
- Reconnection with exponential backoff and full jitter
- **`AuthToolFactory`** callback type for emitting auth pseudo-tools when a server returns AUTH_REQUIRED. The component provider calls it once per AUTH_REQUIRED failure during `attach()` so the model can see and trigger the OAuth flow inline (CC pattern).

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
| `oauth/provider.ts` | `createOAuthAuthProvider()` — OAuth 2.0 lifecycle |
| `oauth/tokens.ts` | Token + client-info persistence + locked refresh via `@koi/secure-storage` |
| `oauth/discovery.ts` | RFC 9728/8414 metadata discovery |
| `oauth/pkce.ts` | PKCE code verifier + S256 challenge |
| `oauth/registration.ts` | RFC 7591 dynamic client registration |
| `oauth/types.ts` | `OAuthRuntime`, `OAuthTokens`, `OAuthClientInfo`, `McpOAuthConfig` |

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

Async-ready: implementations can be sync (static bearer token) or async (OAuth 2.0 token refresh). Callers always `await` the result.

Built-in providers:
- `createBearerAuthProvider(token)` — static API keys
- `createOAuthAuthProvider(options)` — full OAuth 2.0 with PKCE, token refresh, and keychain storage

## OAuth 2.0 Support

OAuth is supported for HTTP transport only (SSE does not inject auth headers).

### Configuration

```json
{
  "mcpServers": {
    "remote-server": {
      "type": "http",
      "url": "https://mcp.example.com/v1",
      "oauth": {
        "clientId": "my-client-id",
        "callbackPort": 8912,
        "authServerMetadataUrl": "https://auth.example.com/.well-known/oauth-authorization-server"
      }
    }
  }
}
```

`clientId` is optional. When omitted, Koi falls back to **Dynamic Client Registration (RFC 7591)** against the authorization server's `registration_endpoint` — the registered client id is persisted in `@koi/secure-storage` under key `mcp-oauth-client|{name}|{sha256(url)[:16]}` and reused across sessions. Registration happens once per server URL; clearing tokens (`koi mcp logout`) does not invalidate the stored client. If neither `clientId` nor a discoverable `registration_endpoint` is available, `startAuthFlow()` returns `false` and `koi mcp auth` fails closed.

### Architecture

OAuth is split across two layers:

- **Transport layer** (`@koi/mcp`): token management, PKCE, metadata discovery, token exchange, refresh
- **Host layer** (CLI): browser launch, callback server, user interaction via `OAuthRuntime` interface

```typescript
interface OAuthRuntime {
  readonly authorize: (authorizationUrl: string, redirectUri: string) => Promise<string>;
  readonly onReauthNeeded: (serverName: string) => Promise<void>;
}
```

### Token Storage

Tokens are stored in the OS keychain via `@koi/secure-storage` (L0u):
- macOS: Keychain Services via `security` CLI
- Linux: libsecret via `secret-tool` CLI
- No insecure fallback — throws on unsupported platforms

File-based locking (`~/.koi/locks/`) ensures safe concurrent access across agent and CLI processes.

### OAuth Flow

1. **Discovery**: RFC 9728 (Protected Resource Metadata) → RFC 8414 (Authorization Server Metadata)
2. **Client resolution**: configured `clientId` → stored registered client → DCR (RFC 7591) fallback
3. **Authorization**: PKCE challenge → browser → callback server → auth code (includes `resource` per RFC 8707)
4. **Token Exchange**: POST to token endpoint with code + verifier + `resource`
5. **Refresh**: Automatic on `token()` when access token is expired; refresh body also carries `resource`
6. **Re-auth**: On 401 mid-session, connection transitions to `auth-needed` state

### RFC 8707 Resource Indicators

Every authorization request, token exchange, and refresh carries `resource={serverUrl}` so the authorization server can bind the issued access token to the specific MCP server. Required by the 2025-03-26 MCP spec for servers that enforce per-resource scoping.

Set `oauth.includeResourceParameter: false` for legacy authorization servers that reject the `resource` parameter with `invalid_target`/`invalid_request`. The default is `true` (spec-compliant); the opt-out exists only as a per-server compatibility escape hatch.

### CLI Commands

| Command | Description |
|---------|-------------|
| `koi mcp list` | List configured servers and transport type |
| `koi mcp auth <server>` | Run OAuth flow (opens browser) |
| `koi mcp logout <server>` | Clear stored tokens |
| `koi mcp debug <server>` | Connection diagnostic |

All support `--json` for machine-readable output.

### Mid-Session 401 Handling

When `listTools()` or `callTool()` receives a 401/403, the connection attempts a silent token refresh first via the `onUnauthorized` dep. The dep returns an `UnauthorizedOutcome` tri-state:

- `"refreshed"` — new access token obtained; connection silently reconnects and retries
- `"needs-auth"` — refresh token gone; connection transitions to `auth-needed` state and `onAuthNeeded` is called for interactive OAuth
- `"transient-failure"` — tokens preserved but temporarily unavailable; connection transitions to `error` state (not `auth-needed`) to avoid prematurely expiring valid tokens

`McpConnection` exposes two additional methods for the host layer:

- `reconnect()` — force a transport rebuild without terminating the connection; transitions through `reconnecting` state so the token manager is re-consulted; used after a token refresh to pick up fresh credentials even when currently `connected`
- `triggerAuth?()` — user-initiated auth entry point that shares the same singleflight as automatic 401-recovery; at most one browser window opens per server at a time; skips the silent-refresh attempt and goes directly to interactive OAuth

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

> **OAuthChannel unification (issue #1982):** `handleUnauthorized` on `OAuthProvider` now returns `UnauthorizedOutcome` (`"refreshed" | "needs-auth" | "transient-failure"`) instead of `void`. `McpConnection.onUnauthorized` dep updated to match. `reconnect()` and `triggerAuth?()` added to the `McpConnection` interface. `OAuthProvider.startAuthFlow` gains a singleflight gate so concurrent calls coalesce. The `auth-needed` state is now reserved for cases where the refresh token is confirmed gone; transient refresh failures produce `error` state instead.

> **Maintenance note (PR #1506):** Fixed Biome lint warnings in test files (`noTemplateCurlyInString` in env-var expansion tests, `noNonNullAssertion` in e2e test). No functional changes.

<!-- biome lint suppression pass: noNonNullAssertion / noTemplateCurlyInString (pre-existing patterns; no behavioral change) -->
