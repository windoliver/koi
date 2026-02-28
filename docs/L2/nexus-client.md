# @koi/nexus-client — Shared JSON-RPC 2.0 Transport for Nexus

Thin, typed JSON-RPC 2.0 client for communicating with the Nexus server. Extracted from `@koi/artifact-client` so every Nexus-backed package shares one transport layer instead of duplicating HTTP plumbing.

---

## Why It Exists

Koi has multiple packages that talk to Nexus (artifact storage, permissions, revocations, pay, search, audit). Without a shared client, every package would copy-paste the same JSON-RPC request/response envelope, error mapping, and authentication header logic.

This package solves three problems:

1. **Single transport** — one place for JSON-RPC 2.0 envelope, Bearer auth, and error mapping
2. **Consistent errors** — HTTP status codes and JSON-RPC error codes map to `KoiError` the same way everywhere
3. **Testability** — injectable `fetch` means tests never hit the network

---

## Architecture

`@koi/nexus-client` is an **L0u utility package** — it depends only on L0 (`@koi/core`). Zero external dependencies.

```
┌──────────────────────────────────────────────────┐
│  @koi/nexus-client  (L0u)                         │
│                                                    │
│  nexus-client.ts   ← createNexusClient() factory  │
│  errors.ts         ← HTTP + RPC error mapping      │
│  types.ts          ← NexusClientConfig, JSON-RPC   │
│  index.ts          ← public API surface             │
│                                                    │
├──────────────────────────────────────────────────┤
│  Dependencies                                      │
│                                                    │
│  @koi/core  (L0)   KoiError, Result               │
└──────────────────────────────────────────────────┘
```

### Who Uses It

```
@koi/nexus-client (L0u)
        │
        ├── @koi/artifact-client    (L2)  artifact storage
        ├── @koi/permissions-nexus  (L2)  ReBAC permissions
        ├── @koi/pay-nexus          (L2)  credits & ledger   (planned)
        ├── @koi/search-nexus       (L2)  retriever + indexer (planned)
        └── @koi/audit-sink-nexus   (L2)  audit log sink     (planned)
```

---

## How It Works

### JSON-RPC 2.0 Protocol

Every Nexus call is a single HTTP POST carrying a JSON-RPC 2.0 envelope:

```
Client                                     Nexus Server
  │                                              │
  │  POST /rpc                                   │
  │  Authorization: Bearer <apiKey>              │
  │  Content-Type: application/json              │
  │                                              │
  │  { "jsonrpc": "2.0",                        │
  │    "id": 1,                                  │
  │    "method": "permissions.check",            │
  │    "params": { ... } }                       │
  │──────────────────────────────────────────────▶│
  │                                              │
  │  { "jsonrpc": "2.0",                        │
  │    "id": 1,                                  │
  │    "result": { "allowed": true } }           │
  │◀──────────────────────────────────────────────│
```

### Error Mapping

Errors from two layers are normalized into `KoiError`:

```
HTTP layer:
  401 → { code: "PERMISSION", retryable: false }
  403 → { code: "PERMISSION", retryable: false }
  404 → { code: "NOT_FOUND",  retryable: false }
  409 → { code: "CONFLICT",   retryable: true  }
  429 → { code: "RATE_LIMIT", retryable: true  }
  5xx → { code: "EXTERNAL",   retryable: true  }

JSON-RPC layer:
  -32600 (invalid request)  → { code: "VALIDATION", retryable: false }
  -32601 (method not found) → { code: "NOT_FOUND",  retryable: false }
  -32602 (invalid params)   → { code: "VALIDATION", retryable: false }
  -32603 (internal error)   → { code: "EXTERNAL",   retryable: true  }
  other                     → { code: "EXTERNAL",   retryable: true  }
```

### Request ID Generation

Each client instance maintains a monotonic counter starting at 1. IDs are local to the client — no global state, no UUIDs, no collision risk across instances.

---

## API Reference

### Factory Functions

#### `createNexusClient(config)`

Creates a Nexus JSON-RPC client.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.baseUrl` | `string` | **required** | Nexus server base URL |
| `config.apiKey` | `string` | **required** | Bearer token for authentication |
| `config.fetch` | `typeof fetch` | `globalThis.fetch` | Injectable fetch for testing |

**Returns:** `NexusClient`

```typescript
interface NexusClient {
  readonly rpc: <T>(
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Result<T, KoiError>>;
}
```

### Error Mapping Functions

#### `mapHttpError(status, message)`

Maps HTTP status code to `KoiError`. Used internally and exported for custom error handling.

#### `mapRpcError(rpcError)`

Maps JSON-RPC error object to `KoiError`. Used internally and exported for custom error handling.

### Types

| Type | Description |
|------|-------------|
| `NexusClientConfig` | `{ baseUrl, apiKey, fetch? }` |
| `NexusClient` | `{ rpc<T>(method, params) => Promise<Result<T, KoiError>> }` |
| `JsonRpcRequest` | JSON-RPC 2.0 request envelope |
| `JsonRpcResponse<T>` | Union: `JsonRpcSuccess<T> \| JsonRpcErrorResponse` |
| `JsonRpcSuccess<T>` | `{ jsonrpc, id, result: T }` |
| `JsonRpcErrorResponse` | `{ jsonrpc, id, error: { code, message, data? } }` |

---

## Examples

### Basic Usage

```typescript
import { createNexusClient } from "@koi/nexus-client";

const client = createNexusClient({
  baseUrl: "https://nexus.example.com",
  apiKey: process.env.NEXUS_API_KEY!,
});

const result = await client.rpc<{ allowed: boolean }>("permissions.check", {
  principal: "agent:coder",
  action: "read",
  resource: "/src/main.ts",
});

if (result.ok) {
  console.log(result.value.allowed); // true
} else {
  console.error(result.error.message); // "connection refused"
}
```

### With Injectable Fetch (Testing)

```typescript
import { createNexusClient } from "@koi/nexus-client";

const fakeFetch = async () =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { allowed: true },
    }),
    { status: 200 },
  );

const client = createNexusClient({
  baseUrl: "http://localhost:9999",
  apiKey: "test-key",
  fetch: fakeFetch as typeof fetch,
});

const result = await client.rpc<{ allowed: boolean }>("permissions.check", {
  principal: "agent:test",
  action: "read",
  resource: "/file.ts",
});
// result.ok === true, result.value.allowed === true
```

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────┐
    KoiError, Result                         │
                                              │
                                              ▼
L0u @koi/nexus-client ◄─────────────────────┘
    imports from L0 only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external dependencies
```
