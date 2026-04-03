# @koi/fs-nexus — Nexus-backed FileSystemBackend

Implements the `FileSystemBackend` (L0) contract by delegating all file operations to a Nexus instance via JSON-RPC over HTTP or Unix socket. Agents get remote filesystem access with the same interface they use for local files.

---

## Why It Exists

Koi agents need filesystem access beyond the local machine — shared workspaces, sandboxed environments, cloud-hosted codebases. Nexus provides a unified filesystem API via JSON-RPC. Without this package, agents are limited to `Bun.file()` / `node:fs` on the local disk.

`@koi/fs-nexus` bridges that gap: swap the backend, keep the same `FileSystemBackend` interface. No agent code changes required.

---

## What This Enables

```
BEFORE: agents can only read/write local files
══════════════════════════════════════════════

  ┌───────────┐        Bun.file()       ┌──────────┐
  │ Koi Agent │ ─────────────────────▶   │ Local FS │
  │           │                          └──────────┘
  └───────────┘   only local disk


AFTER: agents can read/write remote Nexus filesystems
═════════════════════════════════════════════════════

  ┌───────────┐   FileSystemBackend    ┌──────────────┐   JSON-RPC   ┌────────┐
  │ Koi Agent │ ═════════════════════▶ │ @koi/fs-nexus│ ═══════════▶│ Nexus  │
  │           │   same interface       │  (backend)   │  HTTP/Unix   │ Server │
  └───────────┘                        └──────────────┘              └────────┘

  Agent code unchanged. Backend swapped via manifest config.
```

---

## Layer & Dependencies

| Property | Value |
|----------|-------|
| Layer | L2 |
| Imports from | `@koi/core` (L0), `@koi/errors` (L0u) |
| Does NOT import | `@koi/engine` (L1), peer L2 packages |
| Runtime dependency | Nexus server (Docker or local daemon) |

---

## Public API

### Factory

```typescript
function createNexusFileSystem(config: NexusFileSystemConfig): FileSystemBackend;
```

### Config

```typescript
interface NexusFileSystemConfig {
  readonly transport: NexusTransport;  // injected JSON-RPC transport
  readonly basePath?: string;          // mount point prefix (default: "fs")
}
```

### Transport

```typescript
interface NexusTransport {
  readonly call: <T>(method: string, params: JsonObject) => Promise<T>;
  readonly close: () => Promise<void>;
}

function createHttpTransport(config: HttpTransportConfig): NexusTransport;
```

---

## Operations Mapping

| FileSystemBackend method | Nexus RPC | Notes |
|--------------------------|-----------|-------|
| `read(path, opts?)` | `read` | Maps offset/limit to params |
| `write(path, content, opts?)` | `write` | createDirectories forwarded |
| `edit(path, edits[], opts?)` | `read` + `write` | Client-side hunk application |
| `list(path, opts?)` | `list` | Handles flat + structured responses |
| `search(pattern, opts?)` | `search` | Client-side regex in Phase 1 |
| `delete(path)` | `delete` | Direct delegation |
| `rename(from, to)` | `rename` | Direct delegation |
| `dispose()` | `transport.close()` | Cleanup transport connection |

---

## Error Mapping

| Nexus error | KoiError code | Retryable |
|-------------|---------------|-----------|
| 404 / "not found" in message | `NOT_FOUND` | false |
| 409 / conflict | `CONFLICT` | false |
| 403 / permission denied | `PERMISSION` | false |
| 500 / server error | `INTERNAL` | true |
| Timeout | `TIMEOUT` | true |
| Connection refused | `EXTERNAL` | true |

---

## Path Safety

All user-provided paths are normalized through `computeFullPath()` which:

1. Rejects null bytes
2. Normalizes backslash separators
3. Decodes percent-encoded sequences
4. Resolves `..` segments immutably
5. Verifies the result stays within the `basePath` boundary

Traversal attempts return `VALIDATION` errors — they never reach the Nexus server.
