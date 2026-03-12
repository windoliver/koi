# @koi/cli — Interactive CLI for Agent Execution

Command-line interface for running Koi agents locally. Provides interactive (`start`), headless (`serve`), standalone admin (`admin`), and operator console (`tui`) flows, plus automatic Nexus backend wiring, conversation persistence, and graceful shutdown.

---

## What This Enables

### Nexus Integration (embed or remote)

Both `koi start` and `koi serve` automatically connect to Nexus backends — the persistence, permissions, audit, and search layer that agents need for production use. No manual wiring required:

- **Embed mode** (default): When no `--nexus-url` is provided, the CLI auto-starts a local Nexus daemon via `@koi/nexus-embed`. Zero configuration for local development.
- **Remote mode**: Pass `--nexus-url https://nexus.example.com` to connect to a shared Nexus server. Auth via `NEXUS_API_KEY` env var.
- **Graceful fallback**: If Nexus initialization fails, the agent continues with local-only backends and logs a warning. The agent is never blocked by Nexus availability.

### Conversation Persistence (`koi serve`)

The `serve` command wires `@koi/context-arena` with an in-memory `ThreadStore` for multi-turn conversation support:

- Messages are tracked per session via `channel:senderId:threadId` keys
- Context compaction and squash partitioning happen automatically via arena middleware
- If arena initialization fails, the agent falls back to stateless mode (no crash, just a warning)

### Headless Deployment (`koi serve`)

Purpose-built for running agents as background services (systemd, launchd, Docker):

- HTTP health endpoint on configurable port (default 9100)
- Structured shutdown via `@koi/shutdown` (SIGTERM → drain → cleanup)
- Per-session message serialization (runtime single-flight constraint)
- Exit codes: 78 for config errors, 1 for runtime errors

### Channel-Based I/O

Both commands resolve channels from the manifest. `start` falls back to a CLI channel (stdin/stdout REPL), while `serve` operates headless with only manifest-declared channels (Slack, Discord, HTTP webhook, etc.).

### Shared Nexus Resolution (`resolve-nexus.ts`)

Centralized Nexus URL resolution with clear priority:

```
1. --nexus-url CLI flag       (highest priority)
2. NEXUS_URL env var
3. Embed mode — auto-start    (lowest priority, default)
```

---

## Commands

### `koi start`

Interactive REPL mode for local development.

```bash
koi start                           # Load ./koi.yaml, start REPL
koi start path/to/koi.yaml          # Explicit manifest
koi start --verbose                 # Show model, engine, token usage
koi start --dry-run                 # Validate manifest without running
koi start --nexus-url http://...    # Connect to remote Nexus
```

**Flags:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--manifest` | string | `koi.yaml` | Path to manifest file |
| `--verbose` / `-v` | boolean | false | Print startup info and per-turn metrics |
| `--dry-run` | boolean | false | Validate manifest and exit |
| `--nexus-url` | string | — | Nexus server URL (embed mode if omitted) |

### `koi admin`

Standalone admin panel server or proxy for a running `koi serve --admin` instance.

```bash
koi admin                          # Manifest-backed admin server on :9200
koi admin --connect localhost:9100 # Proxy a running koi serve --admin instance
```

### `koi tui`

Interactive terminal console for operators. Defaults to `http://localhost:3100/admin/api`, which matches `koi start --admin`.

```bash
koi tui
koi tui --url http://localhost:9100/admin/api
```

### `koi serve`

Headless mode for background deployment.

```bash
koi serve                           # Load ./koi.yaml, start health server on :9100
koi serve path/to/koi.yaml          # Explicit manifest
koi serve --port 8080               # Custom health port
koi serve --verbose                 # Show agent, model, Nexus, and health info
koi serve --nexus-url http://...    # Connect to remote Nexus
```

**Flags:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--manifest` | string | `koi.yaml` | Path to manifest file |
| `--port` / `-p` | number | 9100 | Health server port |
| `--verbose` / `-v` | boolean | false | Print startup and shutdown details |
| `--nexus-url` | string | — | Nexus server URL (embed mode if omitted) |

---

## Architecture

`@koi/cli` is an **L3 meta-package** — it composes L0, L0u, L1, and L2 packages with command-specific orchestration logic.

### Bootstrap Sequence (both commands)

```
1. RESOLVE   → Find manifest path (flag > positional > ./koi.yaml)
2. VALIDATE  → loadManifest() from @koi/manifest
3. RESOLVE   → resolveAgent() — BrickDescriptor resolution into middleware + model + engine + channels
4. ASSEMBLE  → Use resolved engine or fall back to @koi/engine-pi adapter
5. NEXUS     → resolveNexusOrWarn() — embed or remote, graceful fallback
6. WIRE      → createKoi() with middleware chain: [resolved + arena + nexus]
7. CONNECT   → Channel.connect() for each resolved channel
8. RUN       → Message loop (REPL for start, serial queue for serve)
9. SHUTDOWN  → Signal handling → drain → disconnect → dispose
```

### Module Structure

```
packages/meta/cli/src/
├── args.ts                  ← CLI argument parsing (subcommand-aware)
├── helpers.ts               ← Shared utilities (extractTextFromBlocks)
├── resolve-agent.ts         ← Manifest → runtime resolution via @koi/resolve
├── resolve-bootstrap.ts     ← Context source resolution
├── resolve-nexus.ts         ← Nexus stack resolution (embed/remote/fallback)
├── commands/
│   ├── start.ts             ← Interactive REPL command
│   ├── serve.ts             ← Headless service command
│   └── ...                  ← init, deploy, status, stop, logs, doctor
└── __tests__/
    └── test-helpers.ts      ← Shared test utilities
```

### Key Dependencies

| Package | Layer | Used For |
|---------|-------|----------|
| `@koi/core` | L0 | Types: ContentBlock, EngineInput, InboundMessage, KoiMiddleware, sessionId |
| `@koi/engine` | L1 | createKoi() runtime factory |
| `@koi/engine-pi` | L2 | Default engine adapter (Pi protocol) |
| `@koi/manifest` | L0u | Manifest loading and validation |
| `@koi/context` | L2 | Context extension from manifest sources |
| `@koi/context-arena` | L3 | Conversation persistence bundle (serve only) |
| `@koi/snapshot-chain-store` | L0u | In-memory ThreadStore (serve only) |
| `@koi/nexus` | L3 | Nexus backend stack (embed or remote) |
| `@koi/deploy` | L2 | HTTP health server (serve only) |
| `@koi/shutdown` | L0u | Graceful shutdown handler + exit codes (serve only) |
| `@koi/channel-cli` | L2 | stdin/stdout REPL channel (start only) |
| `@koi/resolve` | L0u | BrickDescriptor-based middleware/model/channel resolution |

---

## Nexus Resolution

The `resolve-nexus.ts` module provides two exported functions:

### `resolveNexusStack(nexusUrl)`

Core resolver. Creates the full Nexus stack via `@koi/nexus.createNexusStack()`. Returns `NexusResolution` with middlewares, providers, dispose, and baseUrl.

### `resolveNexusOrWarn(nexusUrl, verbose)`

Safe wrapper used by both commands. Returns `NexusResolvedState` — on success returns the Nexus stack directly, on failure returns empty defaults (`EMPTY_NEXUS`) and logs a warning. The agent always starts, even if Nexus is unavailable.

```typescript
// In start.ts and serve.ts:
const nexus = await resolveNexusOrWarn(flags.nexusUrl, flags.verbose);

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [...resolved.value.middleware, ...nexus.middlewares],
  providers: [...nexus.providers],
  extensions,
});
```

---

## Conversation Persistence (serve)

The `serve` command wires `@koi/context-arena` for multi-turn conversation:

```
InboundMessage → deriveSessionKey() → serial queue → runtime.run()
                                                        ↓
                                        arena middleware injects history
                                                        ↓
                                        model sees full conversation context
```

- **ThreadStore**: In-memory via `@koi/snapshot-chain-store` (durable SQLite/Nexus planned)
- **Session key**: `channel:senderId:threadId` — deterministic, stable per conversation
- **Fallback**: If `createContextArena()` throws, arena middleware is empty and the agent runs stateless

---

## Testing

31 tests across 4 test files:

| Test file | Tests | Covers |
|-----------|-------|--------|
| `helpers.test.ts` | 5 | Text extraction from content blocks |
| `resolve-nexus.test.ts` | 8 | URL priority, apiKey passthrough, graceful fallback, verbose logging |
| `serve.test.ts` | 8 | Manifest errors, startup/shutdown, message handling, concurrency, arena fallback, error recovery |
| `start.test.ts` | 10 | Manifest loading, REPL loop, verbose mode, dry-run, shutdown |

Coverage: helpers 100%, resolve-nexus 100%, serve 93%, start 86%.

---

## Layer Compliance

- [x] Only imports from L0 (`@koi/core`), L0u utilities, L1 (`@koi/engine`), and L2/L3 packages
- [x] No circular dependencies between CLI modules
- [x] No vendor types leak into public interfaces
- [x] All interface properties are `readonly`
- [x] Listed in `L3_PACKAGES` in `scripts/layers.ts`
