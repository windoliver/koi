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

## Recent updates

**Transport extracted to `@koi/nexus-client` (#1399):** The HTTP JSON-RPC transport is now a separate L0u package (`@koi/nexus-client`) shared with `@koi/permissions-nexus` and `@koi/audit-sink-nexus`. `@koi/fs-nexus` delegates to `createHttpTransport` re-exported from `@koi/nexus-client` instead of owning it directly. No public API change — manifests and hosts wire the same `url` + `apiKey` + `mountPoint` fields.

**Nested bytes envelope fix (#1399):** When the Nexus server is called with `return_metadata: true`, it wraps the content in a nested envelope: `{ content: { __type__: "bytes", data: "<base64>" }, etag: "..." }`. `decodeNexusContent` now recurses into `obj.content` to handle this shape, fixing the zero-byte reads that occurred with HTTP transport.

**String transport guard (#1399):** Manifest configs pass `transport: "http"` (a string selector) in the same config field used for injected test transports. `createNexusFileSystem` now guards with `typeof config.transport === "object"` before treating it as an injected `NexusTransport`, preventing the string value from reaching `transport.call(...)` at runtime.

**`KOI_FS_NEXUS_DEBUG=1` logging:** Set this env var to emit step-by-step `[fs-nexus]` lines to stderr in the `read()` path — logs the full path sent to Nexus, the raw response shape, and the decoded character count. Useful for diagnosing content-decode issues without adding ad-hoc console calls.

---

## Layer & Dependencies

| Property | Value |
|----------|-------|
| Layer | L2 |
| Imports from | `@koi/core` (L0), `@koi/errors` (L0u), `@koi/nexus-client` (L0u) |
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
  readonly call: <T>(method: string, params: Record<string, unknown>) => Promise<Result<T, KoiError>>;
  /** Subscribe to bridge notifications (auth_required/complete/progress). Returns unsubscribe fn. */
  readonly subscribe: (handler: (n: BridgeNotification) => void) => () => void;
  /** Remote OAuth paste-back: forward pasted redirect URL to bridge with correlation ID. */
  readonly submitAuthCode: (redirectUrl: string, correlationId?: string) => void;
  readonly close: () => void;
  readonly mounts?: readonly string[];
}

/** Create an HTTP JSON-RPC transport to a Nexus server. Re-exported from @koi/nexus-client (L0u) — shared with @koi/permissions-nexus and @koi/audit-sink-nexus. */
function createHttpTransport(config: NexusFileSystemConfig): NexusTransport;
/** Spawns bridge.py subprocess for local/OAuth-gated mounts. */
function createLocalTransport(config: LocalTransportConfig): Promise<NexusTransport>;
```

### Inline OAuth (local bridge transport)

When mounting OAuth-gated connectors (gdrive, gmail, etc.) via the local bridge transport, the bridge drives the full OAuth flow inline — no separate CLI auth step needed.

**Flow:**

1. Agent calls `backend.read("/gdrive/my-drive/file.txt")`
2. Bridge catches `AuthenticationError` → generates PKCE auth URL via `nexus.fs.generate_auth_url()`
3. Bridge sends `auth_required` notification — Koi shows URL to user via channel
4. **Local** (macOS/Linux desktop): localhost callback server catches browser redirect automatically
5. **Remote** (SSH/headless): user pastes redirect URL back; Koi calls `transport.submitAuthCode(url, correlationId)`
6. Bridge exchanges code via `nexus.fs.exchange_auth_code()` → token stored → retries original operation
7. Bridge sends `auth_complete` notification

**Wire auth notifications to a channel:**

```typescript
import { createAuthNotificationHandler, createLocalTransport } from "@koi/fs-nexus";

const transport = await createLocalTransport({ mountUri: "gdrive://my-drive" });
// oauthChannel receives structured auth_required/auth_complete events;
// channel receives auth_progress keepalive text messages.
const handler = createAuthNotificationHandler(oauthChannel, channel);
const unsubscribe = transport.subscribe(handler);
// on teardown:
unsubscribe();
handler.dispose(); // cancel pending watchdog timers + gate late callbacks
```

The handler dedupes `auth_progress` heartbeats per-provider: only the first
heartbeat in a flow emits to the channel; subsequent ones are suppressed until
`auth_required` / `auth_complete` resets the flow. Per-provider epochs and
per-send attempt tokens guard against stale `channel.send()` callbacks
corrupting later flows. A 45 s watchdog clears `pending` entries if a
`channel.send()` never settles so heartbeats resume. Call `handler.dispose()`
synchronously during teardown before awaiting the transport close — the
dispose-then-unsubscribe ordering prevents pre-queued microtasks from firing
against a closed transport.

**Notification types:**

```typescript
type BridgeNotification =
  | { method: "auth_required"; params: { provider, user_email, auth_url, message,
        mode: "local" | "remote", correlation_id?, instructions? } }
  | { method: "auth_complete"; params: { provider, user_email } }
  | { method: "auth_progress"; params: { provider, elapsed_seconds, message } };
```

**New L0 error code:** `AUTH_REQUIRED` (`retryable: true`) — raised when auth times out or code exchange fails.

**nexus-fs version required:** `>= 0.4.6` (provides `AuthenticationError` with `.provider`/`.auth_url`, `generate_auth_url()`, `exchange_auth_code()`).

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
| Auth flow timed out / user abandoned (`-32007`) | `AUTH_REQUIRED` | true |
| Auth succeeded but access denied — wrong OAuth scope (`-32004`) | `PERMISSION` | false |

---

## Local Transport Graceful Shutdown

`close()` on the local bridge transport now performs graceful shutdown: it sends stdin EOF to the bridge subprocess and waits up to 2 seconds for the process to exit before sending SIGKILL. This prevents orphaned bridge processes during test teardown and normal shutdown. Test cleanup also removes any leaked CAS directories created by the bridge subprocess.

---

## Startup Failure Diagnostics

When the Python bridge crashes during startup, `createLocalTransport` captures the full stderr output (e.g. Python tracebacks) and includes it in the thrown error message. This is bounded for safety:

- **Time**: stderr drain races against a 3-second timeout — if the bridge ignores SIGTERM and keeps stderr open, the drain gives up and preserves whatever was already collected
- **Size**: stderr capture is capped at 256 KiB — output exceeding the cap is clipped with a `[truncated]` marker
- **Cleanup**: after stderr drain, a SIGKILL fallback ensures the bridge process is always terminated, even if it ignored the initial SIGTERM
- **Cause chain**: the original startup error (e.g. "Stream ended before newline" or "Bridge process exited with code N") is preserved as `error.cause` for programmatic access

---

## Path Safety

All user-provided paths are normalized through `computeFullPath()` which:

1. Rejects null bytes
2. Normalizes backslash separators
3. Decodes percent-encoded sequences
4. Resolves `..` segments immutably
5. Verifies the result stays within the `basePath` boundary

Traversal attempts return `VALIDATION` errors — they never reach the Nexus server.
