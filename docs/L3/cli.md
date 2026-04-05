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

Interactive REPL or single-prompt mode backed by a live OpenRouter model. Wires
`@koi/model-openai-compat` → `EngineAdapter` (via `@koi/query-engine` `runTurn`) →
`@koi/engine` `createKoi` → `@koi/harness` `createCliHarness`.

```bash
koi start                           # Interactive REPL (stdin/stdout)
koi start --prompt "list files"     # Single-prompt mode, then exit
koi start -p "list files"           # Shorthand for --prompt
koi start --verbose                 # Stream tool calls and thinking to stdout
koi start --resume <session-id>     # Resume a prior session (tracking: #1504)
koi start --no-tui                  # Force raw-stdout mode even if TUI is available
```

**Flags:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--prompt` / `-p` | string | — | Single-prompt text; omit for interactive REPL |
| `--resume` | string | — | Session ID to resume (not yet implemented, #1504) |
| `--no-tui` | boolean | false | Disable TUI adapter, use raw stdout |
| `--manifest` | string | — | Agent manifest path (not yet implemented, #1264) |
| `--verbose` / `-v` | boolean | false | Stream tool calls and turn delimiters |
| `--dry-run` | boolean | false | Validate config and exit (not yet implemented, #1264) |
| `--log-format` | `text`\|`json` | `text` | Output format (`json` not yet implemented, #1264) |

**Wiring (as of PR #1518):**

- Model: `google/gemini-2.0-flash-001` via OpenRouter (`OPENROUTER_API_KEY` required)
- Transcript: sliding window of last 20 messages; committed only on `stopReason === "completed"`
- Turn limit: 50 interactive turns, 10 agent loop turns per prompt
- **Agent spawn**: `createAgentResolver({ projectDir: cwd })` loads built-ins + project agents from `.koi/agents/`. A `Spawn` tool is registered via `createSpawnToolProvider` so the model can delegate tasks to researcher, coder, reviewer, or coordinator agents.
- Error handling: truncated streams throw and map to `ExitCode.FAILURE` + stderr message
- SIGINT: aborts gracefully, exits with `ExitCode.FAILURE` so automation can detect cancellation

### `koi admin`

Standalone admin panel server or proxy for a running `koi serve --admin` instance.

```bash
koi admin                          # Manifest-backed admin server on :9200
koi admin --connect localhost:9100 # Proxy a running koi serve --admin instance
```

### `koi tui`

Interactive terminal console. Opens a full-screen OpenTUI terminal UI with conversation view,
command palette (Ctrl+P), and view switching (sessions, doctor, help).

```bash
koi tui
```

**Flags:** none yet — engine adapter wiring (`--agent <manifest>`) is pending full #1459 integration.

**Current behaviour:** The TUI shell renders and accepts input. Submitting a message shows an
`ENGINE_NOT_CONFIGURED` error until the engine adapter is wired in a follow-up PR. Requires a
real TTY; exits 1 with an error message when stdout is not a terminal (e.g. CI pipes).

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
├── bin.ts                   ← Entry point — dispatches tui before COMMAND_LOADERS registry
├── tui-command.ts           ← `koi tui` handler: drainEngineStream + runTuiCommand
├── engine-worker.ts         ← Bun worker thread entry point for engine adapter loop (TUI; gated by _IS_CONFIGURED pending full #1459 wiring)
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

### Engine Worker (`engine-worker.ts`)

A Bun worker thread entry point that runs `EngineAdapter.stream(input)` off the main thread to keep TUI rendering non-blocking (#1484 §2 worker thread isolation):

- **Messages in** (`MainToWorkerMessage`): `stream_start`, `stream_interrupt`, `approval_response`, `shutdown`
- **Messages out** (`WorkerToMainMessage`): `ready`, `engine_event`, `approval_request`, `engine_error`, `stream_done`
- **Approval bridge**: Posts `approval_request` to the main thread when middleware needs HITL; resolves the local Promise when `approval_response` arrives
- **`_IS_CONFIGURED` guard**: Until `createRuntime()` wiring lands in #1459, `stream_start` returns `engine_error` immediately rather than silently misbehaving
- **Input type**: `WorkerEngineInput` — a clone-safe subset of `EngineInput` that excludes non-transferable fields (`callHandlers`, `AbortSignal`)

### Key Dependencies

| Package | Layer | Used For |
|---------|-------|----------|
| `@koi/core` | L0 | Types: ContentBlock, EngineInput, EngineAdapter, InboundMessage, TuiAdapter |
| `@koi/engine` | L1 | `createKoi()` runtime factory |
| `@koi/harness` | L2 | `createCliHarness()` — single-prompt + interactive REPL loop, TUI bridge |
| `@koi/channel-cli` | L2 | stdin/stdout REPL channel (`start` interactive mode) |
| `@koi/model-openai-compat` | L2 | OpenAI-compatible model adapter (OpenRouter) |
| `@koi/query-engine` | L2 | `runTurn()` — model→tool→model agent loop |
| `@koi/tools-builtin` | L2 | Built-in tools: Glob, Grep, Read, ToolSearch |
| `@koi/runtime` | L3 | Full-stack runtime used transitively |
| `@koi/tui` | L2 | TUI shell: `createTuiApp`, `done()` keepalive (`tui` command only) |

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
