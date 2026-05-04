# @koi/nexus-sandbox — Local Nexus Subprocess via SANDBOX Profile

Spawns a local Nexus server in `nexus-ai-fs[sandbox]` profile — zero Docker, zero external services. Single SQLite file, in-process LRU, BM25S keyword search. Designed for local dev and per-agent isolation.

> v2 scope (Issue #1403): replaces v1 `@koi/nexus-embed`. Drops Docker bootstrap. Default lifecycle is `nexus serve` subprocess on `NEXUS_PROFILE=sandbox`.

---

## Why It Exists

The v1 `nexus-embed` package supported two paths: subprocess and Docker Compose. Docker dragged in pulls, volumes, healthcheck loops, and a multi-GB image just to run a single dev agent. The Nexus team's `[sandbox]` extra (`nexus/docs/deployment/sandbox-profile.md`) is purpose-built for the per-agent local case:

| Axis                | v1 nexus-embed (Docker) | v2 nexus-sandbox       |
|---------------------|-------------------------|------------------------|
| Bootstrap           | image pull → run → mount → poll | spawn `nexus serve` |
| Daemon dep          | Docker                  | Python 3.14 + `uvx`    |
| Boot time           | 15–60 s                 | < 5 s warm             |
| RSS                 | multi-GB                | < 400 MB               |
| Storage             | named volume            | `~/.nexus/sandbox/nexus.db` |
| External services   | Postgres, Dragonfly, Zoekt | none                |
| Production?         | No                      | No (use external Nexus) |

Same goal, ~75% less LOC, no Docker on the golden path.

---

## Architecture

L2 feature package — depends only on L0 and L0u utilities.

```
┌────────────────────────────────────────────────────────┐
│  @koi/nexus-sandbox  (L2)                              │
│                                                        │
│  binary-resolver.ts    ← uvx --from nexus-ai-fs nexus  │
│  health-check.ts       ← poll GET /health w/ backoff   │
│  lifecycle.ts          ← spawn / shutdown / state      │
│  errors.ts             ← typed KoiError factories      │
│  index.ts              ← public API                    │
├────────────────────────────────────────────────────────┤
│  Dependencies                                          │
│  @koi/core    (L0)   Result, KoiError, RETRYABLE_DEFAULTS │
│  @koi/errors  (L0u)  error helpers                     │
└────────────────────────────────────────────────────────┘
```

---

## Public API

```typescript
import { startSandbox, stopSandbox, probeHealth } from "@koi/nexus-sandbox";
import type { Result, KoiError } from "@koi/core";

const result: Result<SandboxHandle, KoiError> = await startSandbox({
  port: 2026,
  dataDir: "~/.nexus/sandbox",
  enableVectorSearch: false,
});
// { ok: true, value: { baseUrl, pid, dataDir, shutdown } }
```

### `startSandbox(config?)`

Spawns `nexus serve` with `NEXUS_PROFILE=sandbox`, polls `/health` until ready.

| Field                | Default                       | Notes                                 |
|----------------------|-------------------------------|---------------------------------------|
| `port`               | `2026`                        | If in use → `PORT_IN_USE` error       |
| `host`               | `127.0.0.1`                   | Bind address                          |
| `dataDir`            | `~/.nexus/sandbox`            | SQLite + state lives here             |
| `enableVectorSearch` | `false`                       | Sets `NEXUS_ENABLE_VECTOR_SEARCH=true`; requires embedding key |
| `embeddingModel`     | `text-embedding-3-small`      | Sets `NEXUS_EMBEDDING_MODEL`          |
| `healthTimeoutMs`    | `15000`                       | Total deadline for `/health` to pass  |
| `command`            | resolved from env / default   | Override via `NEXUS_COMMAND` env var  |
| `spawn`              | `Bun.spawn`                   | Injectable for tests                  |
| `fetch`              | `globalThis.fetch`            | Injectable for tests                  |

**Returns:** `Result<SandboxHandle, KoiError>` where `SandboxHandle` is:

```typescript
interface SandboxHandle {
  readonly baseUrl: string;        // http://127.0.0.1:2026
  readonly pid: number;
  readonly dataDir: string;
  readonly shutdown: () => Promise<Result<void, KoiError>>;
}
```

### `stopSandbox(handle, opts?)`

SIGTERM → drain → SIGKILL fallback. Returns `Result<void, KoiError>`.

| Field          | Default | Notes                                |
|----------------|---------|--------------------------------------|
| `drainMs`      | `5000`  | Wait for graceful exit before SIGKILL |

### `probeHealth(baseUrl, fetch?)`

Single GET on `/health`. Returns `boolean` (no throw).

### `resolveCommand(opts?)`

Returns the spawn argv: defaults to `["uvx", "--from", "nexus-ai-fs", "nexus", "serve"]`. Override priority: `opts.command` > `NEXUS_COMMAND` env > default.

---

## Lifecycle State Machine

```
   ┌───────┐  startSandbox()  ┌──────────┐  /health 200  ┌────────┐
   │ idle  │ ───────────────► │ starting │ ────────────► │ ready  │
   └───────┘                  └────┬─────┘               └───┬────┘
                                   │                         │
                       spawn fail  │                         │ shutdown()
                       health fail ▼                         ▼
                              ┌──────────┐              ┌──────────┐
                              │  error   │              │ stopping │
                              └──────────┘              └────┬─────┘
                                                             │ exit
                                                             ▼
                                                        ┌────────┐
                                                        │  done  │
                                                        └────────┘
```

The package returns plain handles, not stateful objects. State lives in the Nexus process itself + the file at `dataDir`.

---

## Typed Errors

All errors use `KoiError` from `@koi/core`. No throws on expected failure modes.

| Code                   | When                                       | `retryable` | `context`                       |
|------------------------|--------------------------------------------|-------------|---------------------------------|
| `NEXUS_BINARY_MISSING` | `uvx`/`uv` not on PATH                     | `false`     | `{ command }`                   |
| `PYTHON_TOO_OLD`       | `nexus --version` reports < 3.14           | `false`     | `{ detected, required: "3.14" }` |
| `PORT_IN_USE`          | Port bind failed before health timeout     | `true`      | `{ port }`                      |
| `HEALTH_TIMEOUT`       | `/health` did not return 200 in time       | `true`      | `{ baseUrl, timeoutMs }`        |
| `SPAWN_FAILED`         | `Bun.spawn` threw or exited immediately    | `true`      | `{ exitCode, stderr }`          |
| `SHUTDOWN_TIMEOUT`     | Process did not exit within `drainMs`      | `false`     | `{ pid, drainMs }`              |

Every error message answers: what happened + why + how to fix. Example:

```
NEXUS_BINARY_MISSING: 'uvx' not found on PATH.
Install uv (https://docs.astral.sh/uv/) or set NEXUS_COMMAND to a full path.
```

---

## Environment Variables

| Var                          | Effect                                      |
|------------------------------|---------------------------------------------|
| `NEXUS_COMMAND`              | Space-separated argv override (highest priority) |
| `NEXUS_PROFILE`              | Force-set to `sandbox` (we always pass it)  |
| `NEXUS_DATA_DIR`             | Force-set to `config.dataDir`               |
| `NEXUS_ENABLE_VECTOR_SEARCH` | Set when `enableVectorSearch: true`         |
| `NEXUS_EMBEDDING_MODEL`      | Set when `embeddingModel` provided          |

Spawned subprocess inherits the parent env minus the above.

---

## Testing

Per CLAUDE.md TDD rule — every behavior has a failing test first. Tests use injectable `spawn` + `fetch`:

| File                       | Coverage                                      |
|----------------------------|-----------------------------------------------|
| `binary-resolver.test.ts`  | default argv, `NEXUS_COMMAND` override, sourceDir mode |
| `health-check.test.ts`     | success on first try, success after retries, timeout, abort propagation |
| `lifecycle.test.ts`        | start happy path, port-in-use, spawn failure, shutdown drain, shutdown timeout fallback |
| `errors.test.ts`           | each typed error factory shape + `retryable` defaults |

No real subprocess in unit tests. Integration tests (in `__tests__/`) spawn a real `uvx` if available, skip otherwise.

---

## Non-Goals

- **No Docker provider.** Use external Nexus or run `docker run ghcr.io/nexi-lab/nexus:sandbox` manually.
- **No Postgres/Dragonfly/Zoekt support.** That's the FULL profile — out of scope.
- **No federation config.** SANDBOX delegates to peers via the Nexus config file; this package only spawns the process.
- **No production use.** `koi.optional = true` in `package.json`. Production agents set `nexus.url` and skip this package entirely.
- **No PID file management.** Each `startSandbox()` spawns a fresh process. Reuse-existing-process logic lives in higher layers if needed.

---

## v1 → v2 Migration

| v1 (`@koi/nexus-embed`)     | v2 (`@koi/nexus-sandbox`)            |
|-----------------------------|--------------------------------------|
| `ensureNexusRunning()`      | `startSandbox()`                     |
| `stopEmbedNexus()`          | `stopSandbox()`                      |
| `nexusInit/Up/Down()`       | removed (Docker path gone)           |
| `pollHealth()`              | exported, same semantics             |
| `resolveNexusBinary()`      | `resolveCommand()`                   |
| `EmbedConfig`               | `SandboxConfig`                      |
| `EmbedResult`               | `SandboxHandle`                      |
| `NexusRuntimeState`         | removed (no `.state.json` parsing)   |
| Profile: `lite` (default)   | Profile: `sandbox` (always)          |
