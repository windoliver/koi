# @koi/filesystem-nexus — Nexus-Backed FileSystemBackend

Remote `FileSystemBackend` implementation backed by a Nexus JSON-RPC server. Each of the 7 filesystem operations (read, write, edit, list, search, delete, rename) delegates to a single `client.rpc()` call with path traversal protection.

**Layer:** L2 (depends on `@koi/core`, `@koi/nexus-client`)

---

## Why It Exists

The `FileSystemBackend` contract (L0) defines what filesystem operations agents can perform — but has no implementation that talks to a remote server. For multi-agent deployments:

1. **Agents need persistent storage** — files must survive restarts and be accessible across sessions
2. **Nexus indexes on write** — semantic search comes for free when files are stored on Nexus
3. **Per-file permissions** — Nexus ReBAC tuples enable fine-grained access control per path
4. **Same interface** — consumers see `FileSystemBackend`, unaware whether files are local or remote

`@koi/filesystem-nexus` solves this by translating every `FileSystemBackend` method into a Nexus JSON-RPC call.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  @koi/filesystem-nexus  (L2)                                  │
│                                                                │
│  nexus-filesystem-backend.ts  ← createNexusFileSystem()       │
│  validate-config.ts           ← config validation              │
│  types.ts                     ← NexusFileSystemConfig          │
│  index.ts                     ← public API surface             │
│                                                                │
├──────────────────────────────────────────────────────────────  │
│  Dependencies                                                  │
│                                                                │
│  @koi/core          (L0)   FileSystemBackend, Result,          │
│                             KoiError, RETRYABLE_DEFAULTS       │
│  @koi/nexus-client  (L0u)  NexusClient (injected)              │
└──────────────────────────────────────────────────────────────  ┘
```

---

## How It Works

All operations go through Nexus JSON-RPC. Paths are joined with a configurable `basePath` and normalized to prevent traversal attacks.

```
  Agent                     filesystem-nexus              Nexus Server
  ┌─────────┐              ┌──────────────────┐          ┌──────────────┐
  │ write() ├─── path ───→ │ computeFullPath  │          │              │
  │         │              │ basePath + path   │          │  JSON-RPC    │
  │         │              │ ↓                 │          │  filesystem  │
  │         │              │ client.rpc("write"│────────→ │  endpoint    │
  │         │              │   { path, content}│          │              │
  │         │              │ )                 │          │              │
  │         │ ◄── Result ──│                   │◄─────── │              │
  └─────────┘              └──────────────────┘          └──────────────┘
```

### Path Resolution

`computeFullPath(basePath, userPath)` joins paths and returns `Result<string, KoiError>`:

- Rejects null bytes → `VALIDATION` error
- Decodes percent-encoded sequences (`%2e%2e` → `..`)
- Normalizes backslash separators (`\` → `/`)
- Resolves `..` segments immutably
- Verifies result stays within basePath boundary → `VALIDATION` error on escape

### RPC Method Mapping

| Backend method | Nexus RPC | Params |
|---------------|-----------|--------|
| `read(path, options?)` | `read` | `{ path, offset?, limit?, encoding? }` |
| `write(path, content, options?)` | `write` | `{ path, content, createDirectories?, overwrite? }` |
| `edit(path, edits, options?)` | `edit` | `{ path, edits, dryRun? }` |
| `list(path, options?)` | `list` | `{ path, recursive?, glob? }` |
| `search(pattern, options?)` | `search` | `{ pattern, basePath, glob?, maxResults?, caseSensitive? }` |
| `delete(path)` | `delete` | `{ path }` |
| `rename(from, to)` | `rename` | `{ from, to }` |
| `dispose()` | — | No-op (NexusClient has no connection state) |

### Error Mapping

- Nexus "Not found" errors → `NOT_FOUND` (via `mapNotFoundError`)
- Path traversal attempts → `VALIDATION` (client-side, never reaches Nexus)
- Network/RPC errors → pass through from NexusClient with `retryable: true`

---

## Configuration

```typescript
interface NexusFileSystemConfig {
  readonly client: NexusClient;        // Injected — L3 creates and shares
  readonly basePath?: string;          // Default: "/fs"
}
```

| Config | Default | Description |
|--------|---------|-------------|
| `client` | (required) | NexusClient instance for JSON-RPC calls |
| `basePath` | `"/fs"` | Path prefix for all file operations |

---

## Examples

### Basic — Remote File Storage

```typescript
import { createNexusFileSystem } from "@koi/filesystem-nexus";
import { createNexusClient } from "@koi/nexus-client";

const client = createNexusClient({
  baseUrl: "https://nexus.example.com/rpc",
  apiKey: process.env.NEXUS_API_KEY!,
});

const backend = createNexusFileSystem({ client, basePath: "/agents/a1/workspace" });

// Write a file
const writeResult = await backend.write("/notes.md", "# Hello");
// → { ok: true, value: { path: "/notes.md", bytesWritten: 7 } }

// Read it back
const readResult = await backend.read("/notes.md");
// → { ok: true, value: { content: "# Hello", path: "/notes.md", size: 7 } }

// Search across files
const searchResult = await backend.search("Hello");
// → { ok: true, value: { matches: [...], truncated: false } }
```

### Testing with Fake Nexus

```typescript
import { createNexusFileSystem } from "@koi/filesystem-nexus";
import { createNexusClient } from "@koi/nexus-client";
import { createFakeNexusFetch } from "@koi/test-utils";

const backend = createNexusFileSystem({
  client: createNexusClient({
    baseUrl: "http://fake",
    apiKey: "test",
    fetch: createFakeNexusFetch(),  // in-memory JSON-RPC server
  }),
});
```

### With Governance (typical production usage)

```typescript
import { createWorkspaceStack } from "@koi/workspace-stack";
import { createGovernanceStack } from "@koi/governance";

// workspace-stack creates the raw backend
const { backend, enforcer, retriever } = createWorkspaceStack({
  nexusBaseUrl: "https://nexus.example.com",
  nexusApiKey: "sk-...",
  agentId: agentId("agent_42"),
});

// governance composes enforcement + scope + provider
const governance = createGovernanceStack({
  preset: "standard",
  backends: { filesystem: backend },
  enforcer,
});
```

---

## API Reference

### Factory

| Function | Returns | Description |
|----------|---------|-------------|
| `createNexusFileSystem(config)` | `FileSystemBackend` | Creates a Nexus-backed filesystem |

### Validation

| Function | Returns | Description |
|----------|---------|-------------|
| `validateNexusFileSystemConfig(config)` | `Result<NexusFileSystemConfig, KoiError>` | Validates config at boundary |

### Types

| Type | Description |
|------|-------------|
| `NexusFileSystemConfig` | `{ client, basePath? }` |

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Flat RPC method names (`read`, `write`, etc.) | Matches store-nexus pattern. Nexus server uses flat namespace. |
| `NexusClient` injected via config | L3 creates and shares one client. L2 never creates its own transport. |
| `computeFullPath` returns `Result` | Path traversal is an expected failure — return typed error, don't throw. |
| Null byte + percent-encoding defense | Prevents bypass of path traversal checks via encoding tricks. |
| Immutable path resolution | Uses `reduce` instead of mutable `push`/`pop` per project conventions. |
| `mapNotFoundError` for read/edit | Nexus returns generic EXTERNAL errors — remap to semantic NOT_FOUND. |
| No retry in L2 | Return `retryable: true` errors. Callers (middleware, governance) handle retry. |
| No caching or batching | Let Nexus handle efficiency. Keep L2 simple. |
| `dispose()` is no-op | NexusClient has no connection state. Included for contract completeness. |

---

## Swappable Backends

`@koi/filesystem-nexus` is one implementation of the L0 `FileSystemBackend` interface:

```
                    FileSystemBackend           (L0 interface)
                          │
             ┌────────────┼────────────┐
             ▼            ▼            ▼
        In-Memory       Local        Nexus
       (tests)         (future)     (multi-node,
                                     shared via
                                     JSON-RPC)
```

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────┐
    FileSystemBackend, FileReadResult, FileWriteResult,       │
    FileEditResult, FileListResult, FileSearchResult,         │
    FileDeleteResult, FileRenameResult, Result, KoiError,     │
    RETRYABLE_DEFAULTS                                        │
                                                               │
L0u @koi/nexus-client ────────────────────────────────────  │
    NexusClient (injected — rpc<T>() method)                  │
                                                               ▼
L2  @koi/filesystem-nexus ◄───────────────────────────────  ┘
    imports from L0 and L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external npm dependencies
    ✓ All interface properties readonly
    ✓ NexusClient is injected, not created
    ✓ Path traversal returns Result, never throws
```

---

## Related

- Issue: #673 — feat: Nexus-backed filesystem + workspace stack
- `@koi/workspace-stack` — L3 bundle that creates this backend from Nexus config
- `@koi/filesystem` — Wraps any `FileSystemBackend` as agent tools
- `@koi/store-nexus` — Same pattern for ForgeStore (brick storage)
- `@koi/nexus-client` — Shared JSON-RPC transport
