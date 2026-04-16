# Design: Wire `manifest.filesystem.backend: nexus` Safely

**Issue:** #1814
**Date:** 2026-04-15
**Branch:** `feat/1814-nexus-fs-backend`
**Status:** Draft

## Context

PR #1813 fixed the silent-drop of `manifest.filesystem` and shipped full support for `backend: local` with operations gating. It rejects `backend: nexus` on both `koi start` and `koi tui` with a clear "not supported yet" error. This design addresses the 4 architectural gaps that must close before that rejection can be removed.

V1 had the scoped-filesystem pattern (`archive/v1/packages/security/scope/src/scoped-filesystem.ts`) but never faced the OAuth or multi-backend checkpoint problems. This work is partially "port from v1" and partially "genuinely new in v2."

## Design Decisions (from brainstorming)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scope | All 4 gaps in one branch, sequential sub-projects | User preference; gaps are interdependent enough to ship together |
| Gap 2 approach | Full backend-aware rewind | No feature regression for nexus users; checkpoint schema gains backend discriminator |
| Gap 4 gate | Manifest scope + explicit `--allow-remote-fs` CLI flag | Scope alone is self-attestation; operator must also opt in. No Nexus ReBAC dependency. Enforcer stack is future work |
| Gap 1 path display | Scope enforces containment; approval shows backend label for non-local backends | Bare paths hide provenance — non-local backends get `[nexus: <transport>]` prefix in approval prompts and audit trail |
| Gap 3 auth UX | Inline paste in TUI chat input | Simplest thing that works; no extra TUI modal plumbing; iterate later if needed |

## Sub-project 1: Backend-Aware Permission Middleware (Gap 1) — [high]

### Problem

`koi tui` classifies file paths for approval display via `resolveFsPath(raw, cwd)` and auto-approves `fs_read` under `${cwd}/**`. A manifest-supplied nexus backend rooted elsewhere would cause the approval prompt and audit trail to misrepresent where data actually lives — a trust-boundary break.

### V1 Reference

`archive/v1/packages/security/scope/src/scoped-filesystem.ts` (184 lines):
- `compileFileSystemScope(scope)` — resolve root path, cache `rootWithSep` for O(1) boundary check
- `normalizePath()` — resolve against root, verify `startsWith(rootWithSep)`, reject traversal
- `writeGuard()` — block write/edit/delete/rename for `mode: "ro"` scopes
- `filterSearchResults()` — post-filter search matches to enforce root boundary

V1 used absolute resolved paths in all user-facing messages. Permission rules were tool-based (`fs:read`, `fs:write`), not path-based. The scope layer enforced containment; the UI just showed the truth.

### Design

**New package: `@koi/fs-scoped` (L0u)**

Depends on `@koi/core` (L0) and `@koi/errors` (L0u). No other dependencies.

```typescript
// Types
interface FileSystemScope {
  readonly root: string;
  readonly mode: "ro" | "rw";
}

interface CompiledFileSystemScope {
  readonly root: string;
  readonly rootWithSep: string;
  readonly mode: "ro" | "rw";
}

// Public API
function compileFileSystemScope(scope: FileSystemScope): CompiledFileSystemScope;
function createScopedFileSystem(backend: FileSystemBackend, scope: FileSystemScope): FileSystemBackend;
```

**Behavior:**
- `normalizePath(raw, compiled)` — `resolve(compiled.root, raw)`, check `startsWith(rootWithSep)`, return `PERMISSION` error on escape
- `writeGuard(operation, compiled)` — return `PERMISSION` error if `mode === "ro"` and operation is write/edit/delete/rename
- All `FileSystemBackend` methods delegate to inner backend after normalization + write guard
- `search()` results post-filtered to enforce root boundary
- Error messages include the absolute resolved path and root (v1 pattern) — no information hiding

**Wiring in `resolve-filesystem.ts`:**
- After resolving the raw backend (local or nexus), wrap with `createScopedFileSystem()` when manifest declares `filesystem.root` + `mode`
- If `filesystem.root` is relative, resolve against manifest directory (existing `anchorFilesystemPaths` pattern)

**Permission rules:** Stay tool-based (`fs:read`, `fs:write`). No path-based rules needed. Scope layer handles containment.

**Approval display:**
- **Local backends:** Show absolute resolved path (existing behavior). No label needed — path is under `cwd`.
- **Non-local backends:** Show `[nexus: <transport>] /resolved/path` in approval prompts and audit trail. Concrete examples:
  - `[nexus: local-bridge] /mnt/workspace/src/main.ts` (local bridge transport)
  - `[nexus: http] /agents/coder/workspace/src/main.ts` (HTTP nexus endpoint)
  - The backend label makes provenance explicit so operators can distinguish local workspace access from remote storage access
  - Applies to both TUI approval prompts and any audit log entries
- Permission rules stay tool-based (`fs:read`, `fs:write`). Scope layer handles containment.

### Files to Create/Modify

| Action | Path | Description |
|--------|------|-------------|
| Create | `packages/lib/fs-scoped/` | New L0u package |
| Create | `packages/lib/fs-scoped/src/scoped-filesystem.ts` | Core implementation |
| Create | `packages/lib/fs-scoped/src/scoped-filesystem.test.ts` | Unit tests |
| Create | `packages/lib/fs-scoped/src/index.ts` | Package exports |
| Create | `docs/L2/fs-scoped.md` | Package documentation |
| Modify | `packages/meta/runtime/src/resolve-filesystem.ts` | Wire scoped wrapping |
| Modify | `scripts/layers.ts` | Register `@koi/fs-scoped` as L0u |

## Sub-project 2: Checkpoint/Rewind Backend-Awareness (Gap 2) — [high]

### Problem

`koi tui`'s `/rewind` stack reconstructs paths under `ctx.cwd` and applies snapshots to the local tree. Manifest-backed edits would be restored to the wrong filesystem or silently dropped during rollback.

### V1 Reference

None — `/rewind` didn't exist in v1. Checkpoint middleware only fired callbacks; there was no rollback UX.

### Design

**Schema change in checkpoint SQLite store:**

Add `backend TEXT NOT NULL DEFAULT 'local'` column to the snapshot table. Existing snapshots default to `"local"` — no migration breakage. Column-add migration runs on first open.

Backend discriminator format: `"local"` or `"nexus:<transport>"` (e.g., `"nexus:local-bridge"`, `"nexus:http"`).

**Snapshot entry type change:**

```typescript
interface CheckpointEntry {
  readonly path: string;
  readonly content: Buffer;
  readonly backend: string;  // NEW: "local" | "nexus:<transport>"
}
```

**Capture flow:**
- On tool call (fs_write, fs_edit), checkpoint middleware reads backend type from the filesystem context attached to the agent session
- Stores `backend` alongside path + content in SQLite

**Rewind flow:**
- For each snapshot entry, resolve the correct `FileSystemBackend` instance by matching `entry.backend` against available backends in the session
- Restore through the matched backend
- Entries restored in reverse chronological order (existing behavior)

**Atomicity guarantee:** Rewind is all-or-nothing. Before starting any restore operations, validate that ALL required backends are available. If any backend instance is unavailable at rewind time (e.g., nexus bridge crashed): **fail the entire rewind** without advancing transcript or head. Surface error: `"rewind aborted — backend '{backend}' unavailable. No changes were made."` This preserves the existing atomic restore contract: transcript and file state always move together, never partially.

**Pre-flight check sequence:**
1. Collect the set of unique `backend` values from all snapshot entries in the rewind range
2. For each backend, verify the `FileSystemBackend` instance is available and responsive (e.g., ping/health check for nexus transports)
3. If any backend is unavailable: abort with error, do not touch transcript or files
4. If all backends available: proceed with ordered restore (existing protocol)

**Edge case — mixed backends in one rewind:**
A session might edit local files and nexus files in the same turn. Rewind must restore both. The per-entry backend discriminator handles this naturally — but the atomicity guarantee means either ALL entries restore or NONE do.

### Files to Modify

| Action | Path | Description |
|--------|------|-------------|
| Modify | `packages/meta/cli/src/preset-stacks/checkpoint.ts` | Add backend to capture/rewind |
| Create | `packages/meta/cli/src/preset-stacks/checkpoint.test.ts` | Tests for backend-aware rewind |
| Modify | Snapshot SQLite schema (inline in checkpoint.ts) | Add `backend` column |

## Sub-project 3: OAuth `auth_required` Channel Loop (Gap 3) — [medium]

### Problem

The fs-nexus local-bridge transport emits `auth_required` notifications for OAuth-gated mounts (gdrive, gmail, etc.). Neither `koi start` nor `koi tui` wires this loop — any OAuth-requiring mount hard-exits on first filesystem call.

### V1 Reference

None — v1's fs-nexus was HTTP-only, no local bridge, no OAuth notifications.

### Design

**Existing pieces:**
- `createAuthNotificationHandler(channel)` in `@koi/fs-nexus` — converts `BridgeNotification` to channel messages (outbound: show OAuth URL to user)
- `NexusTransport.submitAuthCode(redirectUrl, correlationId)` — inbound: paste redirect URL back to bridge
- `resolveFileSystemAsync()` returns `{ backend, operations, transport }` — transport is the handle

**New wiring in `tui-command.ts`:**

1. Capture `transport` from `resolveFileSystemAsync()` return value
2. Wire outbound: `createAuthNotificationHandler(channel)` as the `onNotification` callback — displays OAuth URLs in TUI chat
3. Wire inbound: register a message interceptor on the TUI channel that:
   - Checks each user message against a URL pattern for OAuth callbacks (e.g., `http://localhost:*/callback*` or provider redirect patterns)
   - On match: call `transport.submitAuthCode(url, correlationId)` and suppress the message from reaching the model
   - On no match: pass through normally
4. Correlation ID tracking: when `auth_required` fires with `mode: "remote"`, store `correlationId` in TUI state. Inbound interceptor uses it for `submitAuthCode`.

**`koi start` behavior:**
- Stays fail-closed for OAuth mounts
- If `resolveFileSystemAsync()` encounters an OAuth-requiring scheme: reject with clear error `"OAuth-gated mounts (gdrive://, gmail://, s3://) require 'koi tui' for interactive authentication"`
- Non-OAuth nexus mounts (e.g., `local://` via bridge) work fine on `koi start`

**Auth flow sequence (TUI):**

```
1. User starts koi tui with manifest declaring gdrive:// mount
2. resolveFileSystemAsync() spawns bridge → bridge emits auth_required
3. createAuthNotificationHandler() renders: "Google Drive requires authentication. Open: https://accounts.google.com/..."
4. User opens URL in browser, completes OAuth, gets redirected to localhost callback
5a. mode: "local" → bridge auto-captures callback, emits auth_complete → done
5b. mode: "remote" → user pastes redirect URL into TUI chat
6. Interceptor matches URL → transport.submitAuthCode(url, correlationId)
7. Bridge emits auth_complete → TUI shows "Google Drive connected as user@gmail.com"
```

**Scheme allowlist relaxation:**
Once this sub-project ships, remove OAuth-requiring schemes from `SUPPORTED_NEXUS_LOCAL_BRIDGE_SCHEMES` reject list. The auth loop handles them.

### Files to Modify

| Action | Path | Description |
|--------|------|-------------|
| Modify | `packages/meta/cli/src/tui-command.ts` | Wire transport + auth handler + interceptor |
| Create | `packages/meta/cli/src/auth-interceptor.ts` | URL pattern matching + submitAuthCode |
| Create | `packages/meta/cli/src/auth-interceptor.test.ts` | Unit tests |
| Modify | `packages/meta/cli/src/commands/start.ts` | Reject OAuth mounts with clear error |
| Modify | `packages/meta/runtime/src/resolve-filesystem.ts` | Remove scheme allowlist entries |

## Sub-project 4: Remote-Nexus Trust Boundary on `koi start` (Gap 4) — [medium]

### Problem

`koi start`'s permission backend is `allow: ["*"]` (auto-allow), so wiring a manifest-supplied nexus backend would grant unreviewed read/write access to remote storage.

### V1 Reference

V1 used a composable trust stack: `Raw backend → Enforced (async Nexus ReBAC) → Scoped (sync path boundary)`. Trust was manifest-driven + enforcer-driven. No explicit CLI flags — the enforcer was optional but default-enabled via config. Nexus ReBAC does not exist in v2, so we use the simpler manifest-scope gate.

### Design

**Two-gate logic in `start.ts`:**

Remove the blanket nexus rejection. Replace with a two-gate check: manifest scope (necessary) + CLI flag (sufficient). A repo-local manifest declaring its own scope is self-attestation — not a trust boundary. The operator must explicitly opt in via `--allow-remote-fs`.

```typescript
if (manifest.filesystem?.backend === "nexus") {
  const scope = manifest.filesystem.root;
  const mode = manifest.filesystem.mode;

  // Gate 1: manifest must declare scope
  if (scope === undefined || mode === undefined) {
    process.stderr.write(
      "koi start: nexus backends require 'filesystem.root' and 'filesystem.mode' " +
      "in the manifest.\n" +
      "Add filesystem.root and filesystem.mode to your manifest, or use 'koi tui'.\n"
    );
    return ExitCode.FAILURE;
  }

  // Gate 2: operator must opt in
  if (!flags.allowRemoteFs) {
    process.stderr.write(
      "koi start: nexus filesystem backends require --allow-remote-fs.\n" +
      "This flag confirms the operator (not the manifest) authorizes remote storage access.\n" +
      "Scope: " + scope + " (mode: " + mode + ")\n"
    );
    return ExitCode.FAILURE;
  }

  // Both gates passed — createScopedFileSystem (sub-project 1) enforces the boundary
}
```

**Why two gates:**
- Manifest scope ensures containment (path boundary enforcement via `createScopedFileSystem`)
- `--allow-remote-fs` ensures the operator — not the manifest author — authorizes remote access
- Mirrors the existing `--allow-side-effects` posture: operator decisions are CLI flags, not manifest declarations

**`koi tui` behavior:**
- Accepts nexus with or without scope declaration (interactive UI provides per-operation approval)
- If scope declared: wraps with `createScopedFileSystem` (additional safety layer)
- If scope not declared: user can approve/deny per-operation via interactive UI
- No `--allow-remote-fs` flag needed — the TUI's interactive approval is the trust mechanism

**Future work:** When Nexus ReBAC lands in v2, add `ScopeEnforcer` as an additional layer in the trust stack (between raw backend and scoped filesystem). Both the scope gate and CLI flag remain as fail-safes.

### Files to Modify

| Action | Path | Description |
|--------|------|-------------|
| Modify | `packages/meta/cli/src/commands/start.ts` | Replace blanket reject with two-gate (scope + `--allow-remote-fs`) |
| Modify | `packages/meta/cli/src/tui-command.ts` | Accept nexus, optional scope wrapping |
| Create | `packages/meta/cli/src/commands/start.test.ts` | Test scope gate logic |

## Implementation Order

```
Sub-project 1 (fs-scoped)
    ↓ (sub-project 4 depends on scope enforcement)
Sub-project 4 (trust boundary gate)
    ↓ (can be parallelized with 2)
Sub-project 2 (checkpoint backend-awareness)
    ↓
Sub-project 3 (OAuth channel loop)
    ↓
Integration tests + golden query recording
```

Sub-projects 2 and 3 are independent of each other and can be parallelized after sub-project 1 ships.

## Testing Strategy

| Sub-project | Test Type | What |
|-------------|-----------|------|
| 1 | Unit | Path normalization, traversal rejection, write guard, search filtering |
| 1 | Integration | `resolve-filesystem` wraps nexus backend with scope |
| 2 | Unit | Snapshot capture with backend discriminator, rewind per-backend restore |
| 2 | Unit | Mixed-backend rewind, unavailable-backend aborts entire rewind |
| 3 | Unit | URL pattern matching for OAuth callback interception |
| 3 | Integration | Auth notification → TUI display → paste → submitAuthCode flow |
| 4 | Unit | Two-gate (scope + `--allow-remote-fs`) accepts/rejects correctly on `koi start` |
| 4 | Integration | `koi tui` accepts nexus with and without scope |
| All | Golden | New golden query: nexus-mount tool use through scoped filesystem |

## Acceptance Criteria (from issue #1814)

- [ ] All 4 gaps have merged fixes
- [ ] `koi start --manifest` and `koi tui --manifest` both accept `filesystem.backend: nexus` with no silent-drop and no trust-boundary regression
- [ ] `SUPPORTED_NEXUS_LOCAL_BRIDGE_SCHEMES` allowlist relaxed (OAuth schemes accepted)
- [ ] Nexus-reject branches in `start.ts` and `tui-command.ts` removed
- [ ] Integration tests cover: valid local-bridge mount E2E, OAuth-gated mount auth flow, scope gate on `koi start`, approval display for scoped paths, `/rewind` against manifest-mounted backend
