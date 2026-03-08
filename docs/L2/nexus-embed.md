# @koi/nexus-embed — Auto-Start Local Nexus Daemon

Manages the lifecycle of a local Nexus server as a detached subprocess. When no `nexus.url` is configured, Koi auto-spawns `nexus serve` locally, health-checks it, and connects — zero manual setup. When a URL is provided, the embed package is never loaded.

---

## Why It Exists

Nexus is Koi's backend for agent state — registry, permissions, audit, filesystem, memory, and more. Without embed mode, developers must:

1. **Manually install and start** `nexus serve` before running any Koi agent
2. **Keep it running** across terminal sessions, reboots, or project switches
3. **Know the port** and pass it via config or env vars
4. **Debug connection failures** when they forget to start it

This creates a "batteries not included" experience. Embed mode eliminates the setup friction:

| Without embed mode | With embed mode |
|-------------------|-----------------|
| `pip install nexus-ai-fs` | Automatic |
| `nexus serve --port 2026` | Automatic |
| Set `NEXUS_URL=http://localhost:2026` | Automatic |
| Restart after reboot | Automatic (PID tracking + health reuse) |

---

## What This Feature Enables

### Zero-Config Local Development

```
BEFORE: Manual Nexus setup required
═════════════════════════════════════

# Terminal 1: Start Nexus
$ uv run nexus serve --port 2026 --profile lite

# Terminal 2: Run your agent
$ export NEXUS_URL=http://localhost:2026
$ koi start


AFTER: Just run your agent
══════════════════════════

$ koi start
# Nexus auto-starts in the background if not already running
```

### Seamless Local-to-Remote Transition

```yaml
# koi.yaml — development (no nexus section, auto-starts local)
name: my-agent
version: 1.0.0
model:
  name: claude-sonnet-4-5-20250514

# koi.yaml — production (explicit URL, connects to remote)
name: my-agent
version: 1.0.0
model:
  name: claude-sonnet-4-5-20250514
nexus:
  url: https://nexus.mycompany.com
```

Same `createNexusStack()` call, same agent code — the only difference is whether `baseUrl` is provided.

### CLI Integration

```bash
# Start agent with auto-embed (default when no URL configured)
koi start

# Start agent with explicit remote Nexus
koi start --nexus-url https://nexus.mycompany.com

# Stop agent AND the embed Nexus daemon
koi stop --nexus

# Environment variables also work
NEXUS_URL=http://localhost:2026 koi start
NEXUS_API_KEY=sk-xxx koi start --nexus-url https://nexus.prod.com
```

**Resolution priority** for Nexus URL:
1. `--nexus-url` CLI flag
2. `NEXUS_URL` environment variable
3. `nexus.url` in `koi.yaml`
4. No URL → embed mode (auto-start local)

---

## Architecture

### Lifecycle Flow

```
ensureNexusRunning()
    │
    ├─ 1. Read saved connection state (~/.koi/nexus/embed.json)
    │     ├─ Found + health probe alive → reuse (no spawn)
    │     └─ Found + dead → clean stale PID
    │
    ├─ 2. Probe target port (something already running?)
    │     └─ Alive → reuse (external Nexus)
    │
    ├─ 3. Resolve binary
    │     ├─ NEXUS_COMMAND env → custom command
    │     └─ Default → ["uv", "run", "nexus"]
    │
    ├─ 4. Spawn detached daemon
    │     └─ uv run nexus serve --host 127.0.0.1 --port 2026 --profile lite
    │
    ├─ 5. Write PID file (~/.koi/nexus/nexus.pid)
    │
    ├─ 6. Poll health (GET /health)
    │     └─ Exponential backoff: 100ms → 150ms → 225ms → ... → 1s max
    │     └─ Total timeout: 15s
    │
    └─ 7. Save connection state + return { baseUrl, spawned, pid }
```

### Integration with @koi/nexus (L3)

```
┌──────────────────────────────────────────────────────────┐
│  @koi/cli (L3)                                           │
│                                                          │
│  koi start / koi serve                                   │
│    └─ resolveNexusStack()                                │
│         └─ createNexusStack({ baseUrl? })                │
│              │                                           │
│              ├─ baseUrl provided → connect to remote     │
│              └─ baseUrl missing  → lazy import embed     │
│                   └─ ensureNexusRunning()                 │
│                        └─ spawn + poll → baseUrl         │
│                                                          │
│  koi stop --nexus                                        │
│    └─ stopEmbedNexus()                                   │
│         └─ SIGTERM + clean PID/state files               │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  @koi/nexus (L3)                                         │
│    createNexusStack(config)                               │
│      └─ if !baseUrl: await import("@koi/nexus-embed")    │
│                         └─ ensureNexusRunning()           │
│      └─ createNexusClient({ baseUrl, apiKey? })           │
│      └─ createGlobalBackends(...)                         │
│      └─ createNexusAgentProvider(...)                     │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  @koi/nexus-embed (L2)                                   │
│    ensureNexusRunning()  → Result<EmbedResult, KoiError>  │
│    stopEmbedNexus()      → Result<StopResult, KoiError>   │
│    probeHealth()         → boolean                        │
│    resolveNexusBinary()  → string[]                       │
└──────────────────────────────────────────────────────────┘
```

### Package Structure

```
packages/deploy/nexus-embed/
├── src/
│   ├── types.ts              ← EmbedConfig, EmbedResult, SpawnFn, FetchFn
│   ├── constants.ts          ← defaults (port 2026, host, profile, health timing)
│   ├── ensure-running.ts     ← main orchestrator
│   ├── stop.ts               ← SIGTERM + cleanup
│   ├── health-check.ts       ← probeHealth() + pollHealth() with backoff
│   ├── binary-resolver.ts    ← resolveNexusBinary() + checkBinaryAvailable()
│   ├── pid-manager.ts        ← read/write/clean PID file
│   ├── connection-store.ts   ← read/write/remove embed.json
│   └── index.ts              ← public API surface
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

---

## Configuration

### Defaults

| Setting | Default | Env override |
|---------|---------|--------------|
| Port | `2026` | — |
| Host | `127.0.0.1` | — |
| Profile | `lite` | `NEXUS_EMBED_PROFILE` |
| Binary | `uv run nexus` | `NEXUS_COMMAND` |
| Data dir | `~/.koi/nexus/` | — |
| Health timeout | 15s | — |
| Health initial delay | 100ms | — |
| Health backoff | 1.5x, max 1s | — |

### Programmatic Config

All settings are injectable via `EmbedConfig` for testability:

```typescript
import { ensureNexusRunning } from "@koi/nexus-embed";

const result = await ensureNexusRunning({
  port: 3000,
  host: "0.0.0.0",
  profile: "full",
  dataDir: "/tmp/nexus-test",
  spawn: myCustomSpawnFn,  // DI for tests
  fetch: myCustomFetchFn,  // DI for tests
});
```

---

## State Files

Embed mode persists two files under the data directory (`~/.koi/nexus/` by default):

| File | Purpose | Contents |
|------|---------|----------|
| `nexus.pid` | Process tracking | PID number (plain text) |
| `embed.json` | Connection reuse | `{ port, pid, host, profile, startedAt }` |

On next `ensureNexusRunning()` call:
- If `embed.json` exists and health probe succeeds → **reuse** (no spawn)
- If `embed.json` exists but process is dead → **clean up** stale files and respawn
- If PID file exists but no connection state → **probe health** on default port

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Detached daemon | `Bun.spawn` with `unref()` | Process survives parent exit; no zombie cleanup needed |
| No auth for embed | `apiKey` omitted | Local-only (127.0.0.1); auth adds friction for dev experience |
| Auth for remote | `NEXUS_API_KEY` env var | Remote Nexus requires authentication; env var is standard practice |
| Exponential backoff | 100ms base, 1.5x, 1s max | Responsive startup without busy-waiting; 15s total covers cold JVM starts |
| Lazy loading | Dynamic `import()` in L3 | Zero overhead when connecting to remote Nexus; embed deps only loaded when needed |
| PID-first health check | Write PID before polling | Enables cleanup even if health poll times out (orphan prevention) |
| Profile default: lite | `NEXUS_EMBED_PROFILE=lite` | Minimal resource usage for local dev; configurable via env var |
| Binary: uv run nexus | Not bare `nexus` | `uv` manages Python environment; avoids system Python conflicts |
| Graceful degradation | Nexus failure = warning | Agent can still run with local-only backends if Nexus fails to start |
| No idle timeout | Daemon runs until explicit stop | Simplicity; avoids unexpected shutdowns during debugging sessions |

---

## Testing

50 unit tests across 6 test files, ~90% coverage:

| Test file | Tests | Covers |
|-----------|-------|--------|
| `health-check.test.ts` | 12 | Probe success/failure, poll with backoff, timeout, DI fetch |
| `binary-resolver.test.ts` | 8 | NEXUS_COMMAND parsing, default resolution, availability check |
| `pid-manager.test.ts` | 8 | Read/write/remove PID, stale cleanup, process alive detection |
| `connection-store.test.ts` | 8 | Read/write/remove state, corrupt file handling |
| `ensure-running.test.ts` | 10 | Full lifecycle: reuse, respawn, binary not found, spawn failure |
| `stop.test.ts` | 4 | Stop running, stop dead, no PID file, SIGTERM failure |

---

## Layer Compliance

- [x] `@koi/nexus-embed` only imports from `@koi/core` (L0) — zero L1/L2 deps
- [x] All interface properties are `readonly`
- [x] No vendor/framework concepts in public API
- [x] DI for all I/O (spawn, fetch) — fully testable without real subprocesses
- [x] Lazy-loaded by L3 consumers — no import cost unless embed mode is active
