# @koi-agent/cli — Interactive CLI for Agent Execution

**Current version: 0.1.0** | **npm**: `@koi-agent/cli`

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

`runTurn` provides within-turn tool call dedup (#1580) — identical tool calls in a
single model response are collapsed to one execution, preventing duplicate side effects.

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

**Wiring (current):**

- Model: `anthropic/claude-sonnet-4-6` via OpenRouter (`OPENROUTER_API_KEY` required)
- Transcript: sliding window of last 20 messages; committed only on `stopReason === "completed"`
- Turn limit: 50 interactive turns, 10 agent loop turns per prompt
- **Tools wired:** Glob, Grep, web_fetch, Bash, **TodoWrite** (in-conversation task tracking), and **notebook tools** (notebook_read, notebook_add_cell, notebook_replace_cell, notebook_delete_cell — workspace-contained via `cwd`). MCP tools loaded from `.mcp.json` in cwd (optional). Hooks loaded from `~/.koi/hooks.json` (optional).
- **Interaction tools (partial):** `TodoWrite` is wired. `EnterPlanMode`, `ExitPlanMode`, and `AskUserQuestion` are intentionally NOT wired — plan-mode requires a real permission backend to enforce the read-only gate; without it the mode flag flips but no permissions are restricted. The TUI wires the full interaction provider because it has a real permission backend. `koi start` uses `TodoWrite` only.
- **No Spawn**: `agent_spawn` is not registered — built-in agents (researcher, coder, coordinator) depend on Glob/Grep/web/task tools that require manifest-level wiring (#1264).
- Error handling: truncated streams throw and map to `ExitCode.FAILURE` + stderr message
- SIGINT: aborts gracefully, exits with `ExitCode.FAILURE` so automation can detect cancellation

### `koi admin`

Standalone admin panel server or proxy for a running `koi serve --admin` instance.

```bash
koi admin                          # Manifest-backed admin server on :9200
koi admin --connect localhost:9100 # Proxy a running koi serve --admin instance
```

### `koi tui`

Interactive terminal console. Opens a full-screen OpenTUI terminal UI with progressive model streaming,
conversation history, command palette (Ctrl+P), and view switching (sessions, doctor, help).

**Streaming pipeline:** `drainEngineStream` consumes the async engine stream with frame-rate-limited
yielding (flush + yield every 16ms for text/thinking/tool events) so OpenTUI can paint intermediate
frames. The EventBatcher coalesces events into 16ms batches; the SolidJS store uses `reconcile()` for
fine-grained signal updates.

**Keyboard shortcuts:** Ctrl+E toggles tool result expansion; arrow up/down navigates prompt history
(session-scoped); PageUp/PageDown pauses auto-scroll.

```bash
koi tui
```

**Environment variables:**

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENROUTER_API_KEY` | one of these | — | Key for OpenRouter (default provider) |
| `OPENAI_API_KEY` | one of these | — | Key for OpenAI (`api.openai.com/v1`) |
| `KOI_MODEL` | no | `anthropic/claude-sonnet-4-6` | Model name passed to the provider |
| `OPENAI_BASE_URL` / `OPENROUTER_BASE_URL` | no | — | Override the provider base URL |

**Provider URL selection:** If `OPENROUTER_API_KEY` is set, the adapter uses OpenRouter's default
base URL. If only `OPENAI_API_KEY` is set, the adapter defaults to `https://api.openai.com/v1`
so the key is not forwarded to OpenRouter.

**Flags:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--goal` | string (repeatable) | — | Goal objectives for adaptive reminder middleware |

Engine adapter is wired directly from environment variables. Manifest-based
`--agent` wiring is pending full #1459 integration.

**Behaviour:**
- Runtime assembly is delegated to `createTuiRuntime()` (`tui-runtime.ts`), which wires the full L2 tool stack including memory-tools (in-memory backend), spawn-tools (stub spawn function), semantic-retry middleware, hook observer (ATIF recording of hook executions), and hooks loaded from `~/.koi/hooks.json`.
- Submitting a message streams a real model response via `@koi/model-openai-compat` + `@koi/runtime`.
- Tree-sitter client is initialized at startup (`getTreeSitterClient()` + `initialize()`), enabling `<markdown>` rendering with full prose, headings, code fences, and tables in assistant text blocks.
- Tool call results are displayed with structured title/subtitle/chips (e.g., `✓ Read  package.json`, `✓ Shell  echo hello`) via `getToolDisplay()` mapper. Result metadata chips (exitCode, status, bytesWritten) are extracted from JSON results via `getResultDisplay()`.
- Engine events are batch-dispatched via `store.dispatchBatch()` — the EventBatcher flushes all events in one pass with a single store notification, avoiding N signal invalidations per 16ms window.
- A system prompt middleware (`createSystemPromptMiddleware`) is injected that tells the model it has tool access and should use tools rather than answering from memory.
- **Tools wired:** Glob, Grep, web_fetch, Bash, fs_read/write/edit (via `createRuntime`), task_create/get/update/list/stop/output/delegate (via `@koi/task-tools`), and **TodoWrite**.
- **Interaction tools (partial):** `TodoWrite` is wired. `EnterPlanMode`, `ExitPlanMode`, and `AskUserQuestion` are intentionally NOT registered until real TUI dialogs are wired (tracked in #1582). Without dialog integration: plan-mode would flip a boolean without gating Bash/fs access, and AskUserQuestion would auto-answer without showing the user.
- **No agent_spawn:** `agent_spawn` is intentionally not registered — child workers only have Glob/Grep (read-only) but the child prompt says "write files, run commands" which they cannot do. Deferred until workers route through `createKoi` with full middleware (#1582).
- **Skill injection:** At startup, `createSkillsRuntime().loadAll()` discovers SKILL.md files from `~/.claude/skills/` (user) and `.claude/skills/` (project). Loaded skill content is prepended to the system prompt so the model follows skill guidance. Standard tier precedence applies (project > user > bundled > mcp).
- **MCP wiring:** If `.mcp.json` exists in CWD, `createTuiRuntime()` loads MCP server configs, creates an `McpResolver` + `McpComponentProvider` (tools appear as available tools), and bridges MCP tools into the skill registry via `createSkillsMcpBridge` (tools discoverable via `query({ source: "mcp" })`). MCP connections are cleaned up on shutdown. Without `.mcp.json`, MCP loading is silently skipped.
- **Skill tool:** `@koi/skill-tool` is wired as the `Skill` meta-tool (#1594). The model can invoke `Skill({ skill: "name", args?: "..." })` to load skills on demand. Budget-aware advertising lists available skills in the tool description. Inline mode returns the substituted skill body; fork mode is disabled in TUI (no `spawnFn`). The Skill tool is only registered when `createSkillTool()` succeeds at startup.
- **Goal middleware:** `@koi/middleware-goal` is optionally wired when `--goal` flags are provided. Injects adaptive goal reminders into model context, tracks drift and completion across turns. Goal state persists across session resets (known limitation — full fix requires runtime hot-swapping).
- The exfiltration guard middleware is now enabled (`exfiltrationGuard: {}`) for the TUI session to prevent accidental credential leakage through shell commands or web_fetch, even on the user's own machine.
- **Hook loading:** At startup, `loadHooks()` reads `~/.koi/hooks.json` (if present) and passes the loaded hooks to `createHookMiddleware()`. The hook observer tap (`createHookObserver`) records hook executions as ATIF trajectory steps. If the hooks file is absent or unreadable, no hooks are configured (middleware is a no-op).
- Multi-turn conversation history is maintained in-process and replayed with every submit.
- Ctrl+C (or palette → Interrupt) aborts the active stream; partial turns are not persisted to history.
- `/clear` and `session:new` abort the in-flight stream, drop buffered events, clear rendered messages, and reset conversation history atomically. `activeController` is nulled immediately so a fresh submit is unblocked even if the aborted stream's async teardown settles late.
- Session picker: session resume is not yet implemented — selecting a session fails closed (aborts stream, clears state) and shows `SESSIONS_NOT_IMPLEMENTED`.
- Unimplemented commands surface an explicit `COMMAND_NOT_IMPLEMENTED` error rather than silently no-oping.
- Overlapping submits are rejected with `SUBMIT_IN_PROGRESS`; user must Ctrl+C first.
- Requires a real TTY; exits 1 with an error message when stdout is not a terminal (e.g. CI pipes).

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
├── tui-runtime.ts           ← createTuiRuntime() — full L2 tool stack assembly for `koi tui`
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

### OS Sandbox Wiring (`tui-command.ts`)

`koi tui` now wires OS-level sandboxing into the Bash tool at startup. `createOsAdapter()`
is called once; when available (macOS seatbelt or Linux bwrap), a `restrictiveProfile()`
is merged with workspace-specific overrides (network allowed, write access to `cwd`,
`/tmp`, `/var/folders`) and injected into `createBashTool()` via `sandboxAdapter` +
`sandboxProfile`. The sandbox is transparent to the model — it calls the ordinary Bash
tool and all commands run inside the OS sandbox automatically. Falls back gracefully to
the unsandboxed denylist-only path when the platform is unsupported.

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
| `@koi/harness` | L2 | `createCliHarness()` — single-prompt + interactive REPL loop, TUI bridge. Renders `plan_update`/`task_progress` in verbose mode (#1555) |
| `@koi/channel-cli` | L2 | stdin/stdout REPL channel (`start` interactive mode) |
| `@koi/model-openai-compat` | L2 | OpenAI-compatible model adapter (OpenRouter) |
| `@koi/query-engine` | L2 | `runTurn()` — model→tool→model agent loop, doom loop detection (#1593), tool arg type coercion (#1611) |
| `@koi/tools-builtin` | L2 | Built-in tools: Glob, Grep, Read, ToolSearch |
| `@koi/task-tools` | L2 | LLM-callable task tools (create/get/update/list/stop/output/delegate) + ComponentProvider |
| `@koi/tasks` | L2 | Task board stores + runtime task system (output streaming, task kinds, registry, runner). Supports `onEngineEvent` bridging for plan/progress visibility (#1555). Task kind validation, unsupported lifecycle stubs, atomic `killIfPending()` (#1242) |
| `@koi/runtime` | L3 | Full-stack runtime used transitively |
| `@koi/sandbox-os` | L2 | OS sandbox adapter — `createOsAdapter()` + `restrictiveProfile()` for Bash confinement (`tui` command) |
| `@koi/middleware-exfiltration-guard` | L2 | Secret exfiltration prevention — now enabled by default for TUI sessions |
| `@koi/middleware-extraction` | L2 | Post-turn learning extraction — intercepts spawn-family tool outputs, extracts reusable knowledge via regex + LLM, persists to in-memory memory backend |
| `@koi/middleware-goal` | L2 | Adaptive goal reminders — optional, activated via `--goal` flag |
| `@koi/middleware-semantic-retry` | L2 | Semantic retry middleware — retry signal coordination with event-trace for retry step annotations |
| `@koi/memory-tools` | L2 | Memory read/write/list tools — in-memory backend for TUI sessions (no filesystem persistence) |
| `@koi/spawn-tools` | L2 | Agent spawn tool — stub spawn function in TUI (full spawning requires agent-runtime + harness wiring) |
| `@koi/hook-prompt` | L0u | Prompt hook executor — single-shot LLM verdict parsing (hardened JSON extraction, denial language detection) |
| `@koi/hooks` | L2 | Hook middleware — loads hooks from `~/.koi/hooks.json`, wires observer tap for ATIF trajectory recording. Prompt hooks supported via `PromptModelCaller` backed by the TUI model adapter. HTTP hooks protected by DNS-level SSRF guard, header injection prevention, and bounded response body (#1278, #1279) |
| `@koi/tui` | L2 | TUI shell: `createTuiApp`, `done()` keepalive (`tui` command only). Reducer handles `plan_update`/`task_progress` events, stores `planTasks` (#1555). `TrajectoryView` for ATIF execution trace viewing via `nav:trajectory` |

> **`@koi/sandbox-os` Linux backend hardening (PR #1617, issue #1339):** No CLI wiring changes. Internal improvements to the integrated `@koi/sandbox-os` L2 package: AppArmor usability probe (real `bwrap --unshare-all` smoke-test replaces sysctl-only check), per-exec named systemd transient scopes (`--unit=koi-sb-<id>`) for cgroup teardown on abort, `denyRead` file vs. directory differentiation (`--bind /dev/null` for files like `~/.netrc`/`~/.npmrc`; `--tmpfs` for directories), and `/bin/bash` absolute path in the ulimit wrapper. Linux bwrap confinement behavior in `tui-command.ts` improves on Ubuntu 24.04+ and systems with systemd user sessions.

> **Outcome linkage (#1465):** `@koi/event-trace` allowlist updated with `decisionCorrelationId` for decision-outcome correlation. No CLI-facing changes — the correlation ID is internal trajectory metadata set by upstream middleware.

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

## ATIF Decision Metadata in TUI

All decision-making middleware wired into the CLI runtime emit structured
decision metadata via `ctx.reportDecision`. Spans with decisions are persisted
to the ATIF store and surfaced in the TUI via the `/trajectory` command.

The TUI reads from the store directly — no mid-turn EngineEvent streaming is
needed. When users type `/trajectory` in the TUI, they see:
- Permission decisions per tool call (allow/deny + reason + source)
- Hook dispatch results (tool.before / tool.succeeded / compact.before)
- Goal injection events (which objectives were active + the injected block)
- Skill attachments (which skills + systemPrompt preview)
- Exfiltration-guard detections (when secrets were blocked or redacted)
- Semantic-retry actions (rewrite/abort with failure history)

See each L2 package's "ATIF Trace Integration" section in `docs/L2/*.md` for
the exact decision payload shapes. The CI enforcement test in
`packages/meta/runtime/src/__tests__/golden-replay.test.ts` ensures every
decision-making middleware wired into the runtime emits at least one span
with non-empty `decisions` metadata in full-stack replay.

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

## CI Gates

### `check:cli-wiring`

Dynamic CI gate (`scripts/check-cli-wiring.ts`) that enforces parity between `@koi/runtime`
and `@koi-agent/cli`:

- **Phase 1**: Every non-exempt `@koi/runtime` L2 dependency must appear in the CLI's
  `package.json` dependencies (not devDependencies).
- **Phase 2**: Every non-exempt, non-infra L2 dependency must be imported in `tui-runtime.ts`.

Packages that are intentionally not wired into the TUI (e.g., `@koi/mcp`, `@koi/fs-nexus`,
`@koi/skills-runtime`) are listed in the `EXEMPT` set with justification comments.
Infrastructure packages (`@koi/core`, `@koi/engine`, etc.) are in `INFRA_ONLY` -- checked
for dependency presence but not required in `tui-runtime.ts` imports.

## Layer Compliance

- [x] Only imports from L0 (`@koi/core`), L0u utilities, L1 (`@koi/engine`), and L2/L3 packages
- [x] No circular dependencies between CLI modules
- [x] No vendor types leak into public interfaces
- [x] All interface properties are `readonly`
- [x] Listed in `L3_PACKAGES` in `scripts/layers.ts`

> **`createTuiRuntime` extraction + full L2 wiring (current branch):** `koi tui` now delegates runtime assembly to `createTuiRuntime()` in `tui-runtime.ts`. This factory wires the full L2 tool stack: `@koi/memory-tools` (in-memory backend), `@koi/spawn-tools` (stub `SpawnFn`), `@koi/middleware-semantic-retry` (retry signal coordination), `@koi/hooks` (hook middleware with `loadHooks()` from `~/.koi/hooks.json`), and `createHookObserver` (ATIF trajectory recording of hook executions). Returns `TuiRuntimeHandle` with `runtime`, `transcript`, `getTrajectorySteps()`, `resetSessionState()`, `shutdownBackgroundTasks()`, `hasActiveBackgroundTasks()`, and `sandboxActive`. The `check:cli-wiring` CI gate (`scripts/check-cli-wiring.ts`) dynamically enforces that every `@koi/runtime` L2 dependency is wired into the CLI.
