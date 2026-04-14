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
- Transcript: token-aware compaction via `@koi/context-manager` `enforceBudget()` — micro (tail-truncate) at 50% of model context window, full (optimal-split truncate) at 75%. Window size resolved per-model via `@koi/model-registry` (e.g. claude-opus-4-6 → 1M tokens). Falls back to sliding window of last 20 messages when budget config is unavailable. Messages committed to transcript only on `stopReason === "completed"`. Override window for testing: `KOI_COMPACTION_WINDOW=<tokens>` (#1623)
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

### `koi plugin`

Plugin lifecycle management. Subcommands operate on `~/.koi/plugins/` (user root).

```bash
koi plugin install <path>         # Copy plugin from local directory
koi plugin remove <name>          # Remove installed plugin
koi plugin enable <name>          # Enable a disabled plugin
koi plugin disable <name>         # Disable a plugin
koi plugin update <name> <path>   # Rollback-safe update from new source
koi plugin list [--json]          # List plugins with enabled/disabled status
```

Install copies the source directory into `~/.koi/plugins/<name>/` with TOCTOU validation and symlink dereferencing (`dereference: true`).
Update uses a backup+rename swap with automatic rollback on failure and crash recovery via `recoverOrphanedUpdates()`.
Enable/disable persists state in `~/.koi/plugins/state.json`; all plugins are enabled by default.
Name validation rejects non-kebab-case names to prevent path traversal.
The gated registry fails closed on corrupt state — all plugins blocked until `state.json` is readable.

**Session activation:** When `koi tui` or `koi start` launches, `loadPluginComponents()` discovers
enabled plugins via `createGatedRegistry` and wires their skills, hooks, and MCP servers into the
session. Plugin middleware names are collected but not resolved (no factory registry yet).

### `koi tui`

Interactive terminal console. Opens a full-screen OpenTUI terminal UI with progressive model streaming,
conversation history, command palette (Ctrl+P), and view switching (sessions, doctor, help).

**Streaming pipeline:** `drainEngineStream` consumes the async engine stream with frame-rate-limited
yielding (flush + yield every 16ms for text/thinking/tool events) so OpenTUI can paint intermediate
frames. The EventBatcher coalesces events into 16ms batches; the SolidJS store uses `reconcile()` for
fine-grained signal updates.

**Keyboard shortcuts:** Ctrl+E toggles tool result expansion; arrow up/down navigates prompt history
(session-scoped); PageUp/PageDown pauses auto-scroll. Ctrl+C copies selected text to clipboard
(falls through to interrupt when no selection).

**Copy-on-select:** Mouse-drag to select text auto-copies to system clipboard via OSC 52 when
the selection finishes (same pattern as OpenCode). Works in iTerm2, Ghostty, WezTerm, Kitty.
Selections exceeding 100 KB are not copied (OSC 52 terminal payload limit).

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
- **MCP wiring:** If `.mcp.json` exists in CWD, `createTuiRuntime()` loads MCP server configs and creates connections via `createOAuthAwareMcpConnection()` — HTTP servers with an `oauth` field automatically get an `OAuthAuthProvider` backed by `@koi/secure-storage` keychain tokens. Creates an `McpResolver` + `McpComponentProvider` (tools appear as available tools), and bridges MCP tools into the skill registry via `createSkillsMcpBridge` (tools discoverable via `query({ source: "mcp" })`). MCP connections are cleaned up on shutdown. Without `.mcp.json`, MCP loading is silently skipped. CLI management via `koi mcp list|auth|logout|debug` (#1633).
- **Skill tool:** `@koi/skill-tool` is wired as the `Skill` meta-tool (#1594). The model can invoke `Skill({ skill: "name", args?: "..." })` to load skills on demand. Budget-aware advertising lists available skills in the tool description. Inline mode returns the substituted skill body; fork mode is disabled in TUI (no `spawnFn`). The Skill tool is only registered when `createSkillTool()` succeeds at startup.
- **Goal middleware:** `@koi/middleware-goal` is optionally wired when `--goal` flags are provided. Injects adaptive goal reminders into model context, tracks drift and completion across turns. Goal state persists across session resets (known limitation — full fix requires runtime hot-swapping).
- The exfiltration guard middleware is now enabled (`exfiltrationGuard: {}`) for the TUI session to prevent accidental credential leakage through shell commands or web_fetch, even on the user's own machine.
- **Hook loading:** At startup, `loadRegisteredHooks()` reads `~/.koi/hooks.json` (if present) and tags loaded hooks as `"user"` tier. Plugin hooks are tagged as `"session"` tier via `createRegisteredHooks()`. Both tiers are merged and passed to `createHookMiddleware()`. Tier-phased dispatch runs hooks in managed → user → session order. The hook observer tap (`createHookObserver`) records hook executions as ATIF trajectory steps. If the hooks file is absent or unreadable, no hooks are configured (middleware is a no-op).
- **Plugin activation:** At startup, `loadPluginComponents()` discovers enabled plugins from `~/.koi/plugins/` via `createGatedRegistry` and merges their components into the session: plugin hooks are prepended to user hooks before `createHookMiddleware()`; plugin MCP server configs create additional `McpConnection`s and a separate `McpComponentProvider`; plugin skill directories are scanned for `SKILL.md` files and registered via `skillsRuntime.registerExternal()`. Plugin MCP connections are cleaned up on shutdown alongside workspace MCP.
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
├── bin.ts                   ← Entry point — raw-argv fast-path; delegates post-fast-path to dispatch.ts
├── dispatch.ts              ← Shared runDispatch helper (imported by bin.ts and bench-entry.ts; #1637)
├── bench-entry.ts           ← Non-shipped benchmark harness for startup-latency gate (#1637); excluded from npm via package.json files negation
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

**Note on `bench-entry.ts` publication exclusion (#1637):** the file is built by tsup
into `dist/bench-entry.js` alongside `dist/bin.js` so the startup-latency CI gate can
exercise real bundled code (same chunks, same minification as the shipped bin), but
`package.json`'s `files` field contains `!dist/bench-entry.js`, `!dist/bench-entry.d.ts`,
`!dist/bench-entry.d.ts.map`, and `!dist/bench-entry.js.map` negations so users who
`bun add @koi-agent/cli` never receive the benchmark entrypoint. This does not change
the set of L2 dependencies integrated into the CLI.

### OS Sandbox Wiring (`tui-command.ts`)

`koi tui` now wires OS-level sandboxing into the Bash tool at startup. `createOsAdapter()`
is called once; when available (macOS seatbelt or Linux bwrap), a `restrictiveProfile()`
is merged with workspace-specific overrides (network allowed, write access to `cwd`,
`/tmp`, `/var/folders`) and injected into `createBashTool()` via `sandboxAdapter` +
`sandboxProfile`. The sandbox is transparent to the model — it calls the ordinary Bash
tool and all commands run inside the OS sandbox automatically. Falls back gracefully to
the unsandboxed denylist-only path when the platform is unsupported.

### Bash AST Classifier (PR #1660, issue #1634)

`@koi/tools-bash` now delegates to `@koi/bash-ast` for command classification instead of
the regex-only path from `@koi/bash-security`. Both `createBashTool()` and
`createBashBackgroundTool()` await `initializeBashAst()` at the top of `execute()` before
the sync classifier reads the cached parser. The async init is idempotent via a cached
promise; on failure the cache resets so callers can retry (no permanent DoS from a
transient disk error during WASM grammar load).

The new pipeline:

1. Byte-level prefilter (null bytes, control chars, URL-encoded traversal, hex-escaped
   ANSI-C strings — reused from `@koi/bash-security`)
2. Pre-parse reject on backslash-newline line continuation (smuggling defense)
3. Tree-sitter-bash parse with a 50 ms deadline (`progressCallback`-driven cancellation)
4. Allowlist walker extracts `SimpleCommand[] = { argv, envVars, redirects, text }`
5. Unknown grammar → `too-complex`:
   - Escape-related reasons (word/string_content/line-continuation) **hard-deny** — the
     raw-text regex fallback is fooled by the same escapes the walker rejects
   - Everything else falls through to `@koi/bash-security`'s regex TTP classifier as a
     transitional compatibility shim until `#1622` ships three-state permissions with an
     `ask-user` verdict
6. `parse-unavailable` (init timeout, over-length, panic) → fail-closed hard-deny,
   NEVER falls through

End-to-end behaviour is unchanged for common commands (`git status`, `ls -la`, `echo hi`,
`ls | head -3`) — they flow through the AST walker as `kind: "simple"`. Commands with
`$VAR`, `$(cmd)`, loops, or `&&` with standalone assignments fall through to the regex
classifier, preserving current behaviour.

Codex adversarial review of the PR surfaced six real bugs (2 P1 security bypasses + 4
P2 defects in walker escape handling, init-retry semantics, matcher regex flags, and
`Tree` WASM memory management). All six are fixed in the same PR with 18 regression
tests in `@koi/bash-ast/src/__tests__/codex-findings.test.ts`.

### Elicit wiring (#1634 full closure)

`koi tui` wires an `elicit` callback into `createBashTool()` and
`createBashBackgroundTool()`. When the AST walker classifies a command as
`too-complex` (non-hard-deny), the tool calls `classifyBashCommandWithElicit`
from `@koi/bash-ast`, which invokes the elicit callback for interactive user
approval instead of silently passing through the regex TTP fallback. The
elicit callback is an adapter over the same `approvalHandler` the permissions
middleware uses, so the user sees the standard permission dialog.

Example flow for `echo $USER`:
1. Agent calls Bash tool with `echo $USER`
2. Permissions middleware allows the Bash tool call (rule-level)
3. Tool's `execute()` calls `classifyBashCommandWithElicit`
4. Prefilter passes, AST walker returns `kind: "too-complex"` with
   `nodeType: "simple_expansion"`
5. `classifyBashCommandWithElicit` calls the elicit callback with
   `{ command: "echo $USER", reason: "variable expansion...", nodeType: "simple_expansion" }`
6. Callback invokes `approvalHandler({ toolId: "Bash", input: { command }, reason })`
7. User sees permission dialog: `Allow once / Deny / Always allow Bash this session`
8. On approval: regex TTP defense-in-depth runs (no match), command spawns
9. On denial: tool returns `Command blocked by security policy`

`koi start` (non-interactive REPL) does NOT wire elicit — it uses the sync
`classifyBashCommand` with the regex fallback because there is no prompt
surface for the user. Both paths fail-closed on `parse-unavailable` and
hard-deny shell-escape ambiguity regardless.

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
| `@koi/bash-ast` | L0u | AST-based bash classifier (PR #1660) — `classifyBashCommand()`, `initializeBashAst()`, `matchSimpleCommand()`. Replaces the regex-only `@koi/bash-security` classifier for `@koi/tools-bash` |
| `@koi/bash-security` | L0u | Prefilter (injection + path validation) + transitional regex TTP fallback for `@koi/bash-ast` `too-complex` outcomes |
| `@koi/tools-bash` | L2 | Bash execution tool — `createBashTool()` and `createBashBackgroundTool()`, both routed through `@koi/bash-ast` for classification |
| `@koi/sandbox-os` | L2 | OS sandbox adapter — `createOsAdapter()` + `restrictiveProfile()` for Bash confinement (`tui` command) |
| `@koi/rules-loader` | L0u | Hierarchical project rules file injection — discovers CLAUDE.md/AGENTS.md/.koi/context.md from cwd to git root, merges root-first into system prompt |
| `@koi/context-manager` | L0u | Token-aware transcript compaction — `enforceBudget()` micro/full cascade, `resolveConfig()` + `budgetConfigFromResolved()` for per-model window from `@koi/model-registry`. Wired into `createTranscriptAdapter()` in `engine-adapter.ts`; both `koi start` and `koi tui` use it. `KOI_COMPACTION_WINDOW` env var overrides the window for testing (#1623) |
| `@koi/middleware-exfiltration-guard` | L2 | Secret exfiltration prevention — now enabled by default for TUI sessions |
| `@koi/middleware-extraction` | L2 | Post-turn learning extraction — intercepts spawn-family tool outputs, extracts reusable knowledge via regex + LLM, persists to in-memory memory backend |
| `@koi/middleware-goal` | L2 | Adaptive goal reminders — optional, activated via `--goal` flag |
| `@koi/middleware-semantic-retry` | L2 | Semantic retry middleware — retry signal coordination with event-trace for retry step annotations |
| `@koi/model-router` | L2 | LLM provider fallback chain — `createModelRouterMiddleware()` + `createModelRouter()`. Opt-in via `KOI_FALLBACK_MODEL` env var (comma-separated fallback model list). Routes model calls through a circuit-breaker-guarded fallback sequence; decision metadata surfaced in ATIF trajectory via `ctx.reportDecision`. When omitted, calls go directly to the primary model adapter. See `tui-command.ts` for construction and `TuiRuntimeConfig.modelRouterMiddleware` for injection point. |
| `@koi/memory-tools` | L2 | Memory read/write/list tools — in-memory backend for TUI sessions (no filesystem persistence) |
| `@koi/spawn-tools` | L2 | Agent spawn tool — stub spawn function in TUI (full spawning requires agent-runtime + harness wiring) |
| `@koi/hook-prompt` | L0u | Prompt hook executor — single-shot LLM verdict parsing (hardened JSON extraction, denial language detection) |
| `@koi/hooks` | L2 | Hook middleware — loads hooks from `~/.koi/hooks.json` as `"user"` tier, plugin hooks as `"session"` tier (#1282). Hook policy tiers enable tier-phased dispatch (managed → user → session) and `HookPolicy` filtering. Wires observer tap for ATIF trajectory recording. Prompt hooks supported via `PromptModelCaller` backed by the TUI model adapter. HTTP hooks protected by DNS-level SSRF guard, header injection prevention, and bounded response body (#1278, #1279) |
| `@koi/tui` | L2 | TUI shell: `createTuiApp`, `done()` keepalive (`tui` command only). Reducer handles `plan_update`/`task_progress` events, stores `planTasks` (#1555). `TrajectoryView` for ATIF execution trace viewing via `nav:trajectory`. Spinner frames/interval centralized in `src/components/spinners.ts` (`DEFAULT_SPINNER`); no CLI-facing change |
| `@koi/loop` | L2 | Convergence loop primitive — `runUntilPass()` re-runs an agent turn against a verifier gate until it passes, iteration budget exhausts, or the caller aborts. Wired into both `koi start --until-pass <cmd>` and `koi tui --until-pass <cmd>`. Argv-only subprocess gates (`createArgvGate`, no shell strings), minimal default env allowlist with `--verifier-inherit-env` opt-in, strict `stopReason === "completed"` gate rejects truncated turns, 100 ms iterator cleanup fence promotes orphaned streams to `errored`. Five terminal states: `converged`/`exhausted`/`aborted`/`circuit_broken`/`errored`. Loop mode disables session persistence (transcript orphan fence) and requires `--allow-side-effects` and `--prompt` |

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

### Trajectory Visibility

`@koi/decision-ledger` is now a dependency. `refreshTrajectoryData()` uses the decision ledger as the primary data source for the `/trajectory` view, with fallback to raw `getTrajectorySteps()`.

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

> **Task system hardening (PR #1659, issue #1557 review):** The CLI's TUI runtime picks up the `@koi/tasks` / `@koi/task-tools` / `@koi/spawn-tools` / `@koi/task-board` improvements from the review punch list automatically — no wiring changes in `tui-runtime.ts`. User-visible effects: `task_update(completed)` now reports accurate `durationMs` even if `activeForm` was patched mid-run (anchored to the new `Task.startedAt`); `task_list` polling is cheaper thanks to per-snapshot `board.blockedBy()` caching; on coordinator restart, pending tasks whose delegated child never claimed can be cleaned up via `recoverStaleDelegations()` (complements the existing `recoverOrphanedTasks`); file-store write paths refuse malformed task IDs and enforce single-writer PID locking for safety against accidental multi-process collisions. See `docs/L2/tasks.md`, `docs/L2/task-tools.md`, and `docs/L2/spawn-tools.md` for the package-level details.

> **Persistent approvals wired into TUI (#1622):** `koi tui` now creates a SQLite-backed `ApprovalStore` at `~/.koi/approvals.db` and wires it into the permissions middleware with `persistentAgentId: "koi-tui"`. The permission prompt shows `[!] Always (permanent)` which grants approval that survives TUI restart. OS username (`userInfo().username`) is passed as `userId` to `createKoi` so the grant is scoped to the local user. Store creation is wrapped in try/catch; a corrupt DB gracefully degrades to session-only approvals without crashing the TUI.

> **#1583 — Real spawning + TUI feature parity (20 features, current branch):**
>
> **Real spawning replaces stub:** `tui-runtime.ts` now uses `createSpawnToolProvider` from `@koi/engine` (with `createAgentResolver` from `@koi/agent-runtime`, `createInMemorySpawnLedger`, and a stateless child `EngineAdapter` built from `runTurn`) instead of the previous error-stub `SpawnFn`. Built-in agent definitions (`researcher`, `coder`, `reviewer`, `coordinator`) resolve normally; unknown names create dynamic ad-hoc agents (`allowDynamicAgents: true`) using the manifestTemplate's restrictive `selfCeiling` (`Glob`/`Grep`/`fs_read`/`ToolSearch` only) so they can't escalate to Bash/fs_write/fs_edit/web_fetch without an authored definition. The agent resolver is bootstrapped with `{ projectDir: cwd, userDir: homedir() }` so `.koi/agents/*.md` files in both scopes are honored.
>
> **Inherited middleware:** Spawned children inherit the parent's full security envelope: `permMw`, `exfiltrationGuardMw`, `hookMw`, and `systemPromptMw`. Session transcript middleware is intentionally NOT inherited — it holds a mutable transcript array that must stay isolated per-runtime. Each child gets a fresh transcript-backed `EngineAdapter` (`createChildBridge` pattern) so siblings cannot see each other's history. New CLI dep: `@koi/agent-runtime` (added to `package.json`).
>
> **Spawn lifecycle event bridge:** `tui-runtime.ts` accepts an `onSpawnEvent` config callback that the spawn executor (`createSpawnExecutor` in `@koi/engine`) invokes synchronously when a spawn starts/ends. The TUI bridge in `tui-command.ts` dispatches these into the store as `engine_event` (for `spawn_requested`) and `set_spawn_terminal` (for outcome — preserves `complete` vs `failed`). Without this side channel, the TUI's `SpawnBlock` component would have no event source because the engine never emits `spawn_requested` from the model stream.
>
> **TUI callback wiring (`onFork`, `onImageAttach`, `onTurnComplete`):** `CreateTuiAppConfig` extended with three new optional callbacks; `tui-command.ts` wires them: `onFork` snapshots the current session's transcript via `jsonlTranscript.load(runtime.sessionId)` and writes the entries to a fresh `crypto.randomUUID()` session file (the active session continues uninterrupted), `onImageAttach` collects `{ url, mime }` images into a `pendingImages` array that's drained into the next `add_user_message` as `image` ContentBlocks, `onTurnComplete` writes BEL (`\x07`) to stdout for terminal notification.
>
> **Output collectors read tool_result (#1583 round 6):** `createTextCollector` and `createVerdictCollector` in `@koi/engine` now read tool execution output from `tool_result.output` instead of `tool_call_end.result` (which carries `AccumulatedToolCall` arg metadata, NOT the actual output). Tool-only child agents that finish without text now return the real tool output to their parent.

> **Permission decision hook dispatch (#1627):** `@koi/middleware-permissions` now fires the `onPermissionDecision` hook via a `dispatchApprovalOutcome` callback passed into `handleAskDecision`. The dispatch fires BEFORE `next(request)` on all approval paths (persistent always-allow, session allow, cache hit, fresh approval) and BEFORE the denial throw, decoupling the permission record from tool execution success/failure. The `dispatchApprovalOutcome` pattern threads the L0 `KoiMiddleware.onPermissionDecision` hook through the middleware chain for use by `@koi/middleware-audit` and other observers without creating L2→L2 dependencies.

> **#1689 — TUI stdin parser reset after permission approval:** `@koi/tui`'s `createTuiApp` now wraps `permissionBridge.respond` so every tool-approval decision (y/n/a or Esc) flows `bridge.respond → stdinParser.reset()`. The wrap is a transport-layer concern and lives entirely inside `@koi/tui` — no CLI wiring changes in `tui-runtime.ts` or `tui-command.ts`. Visible to CLI users as: after a `fs_write`/permission-gated tool approval, Enter / Backspace / Esc / Tab on the next prompt are no longer silently dropped, and slash commands (`/rewind`, `/help`, etc.) submit cleanly. Root cause lives in `@opentui/core@0.1.96`'s stdin parser paste latch; see `docs/L2/tui.md` for the full trace. Upstream patch to `@opentui/core` is tracked separately.

> **Checkpoint middleware + /rewind command:** `koi tui` now wires `@koi/checkpoint` middleware and `@koi/snapshot-store-sqlite` into the TUI runtime. The `/rewind [n]` slash command dispatches through `tui-command.ts` to trigger checkpoint-based conversation rollback. The checkpoint middleware config receives `resolvePath` from the filesystem backend for workspace-scoped path validation.

> **#1744 — TUI quit no longer logs `EditBuffer is destroyed`:** `@koi/tui`'s `InputArea` now routes every textarea read/write through `safeText`/`safeSetText` and sets a `disposed` flag in Solid `onCleanup` so the `useKeyboard` callback bails out once the component is being torn down. Previously, keystrokes that drained through the renderer's `KeyHandler` after `appHandle.stop()` had destroyed the textarea's underlying `EditBuffer` would call `getText()` on a dead buffer, throw, and surface as `[KeyHandler] Error in global keypress handler: error: EditBuffer is destroyed` on every `koi tui` quit. No CLI wiring change in `tui-command.ts` — the fix is local to `@koi/tui`.

> **OTel opt-in for TUI sessions (#1628):** `TuiRuntimeConfig` gains `otel?: OtelMiddlewareConfig | true | false`. When truthy, `createTuiRuntime` creates an `OtelHandle` from `@koi/middleware-otel`, wires `otelHandle.onStep` into `createEventTraceMiddleware` (ATIF ↔ OTel trace identity sharing via `otel.traceId`/`otel.spanId` in `step.metadata`), and appends `otelHandle.middleware` to the middleware stack. `tui-command.ts` passes `otel: true` when `KOI_OTEL_ENABLED=true` is set in the environment. Requires an OTel SDK initialised before the TUI starts — `trace.getTracer()` reads from the global registry; no SDK = no-op tracer, zero crash.

> **Per-turn trajectory grouping (PR #1758):** `tui-command.ts` injects a synthetic `koi:tui_turn_start` ATIF step (via `runtimeHandle.appendTrajectoryStep`) before each `runtime.run()` call. This is necessary because the engine resets `ctx.turnIndex` to 0 on every `run()` invocation — in the TUI's interactive mode (one `run()` per user message), the engine's turn counter is always 0. The synthetic step carries `metadata.tuiTurnIndex` (monotonic, 0-based, reset on `/clear`). `computeTurnIndices()` uses three-tier priority: (1) `tui_turn_start` boundary steps, (2) `metadata.turnIndex` from event-trace for sub-turns within a single `run()`, (3) `totalMessages` delta for legacy ATIF fixtures. `@koi/tui`'s `TrajectoryView` consumes the resulting `turnIndex` field on `TrajectoryStepSummary` to render collapsible per-turn groups.

> **#1742 — `/clear` race + reset hardening (`@koi/tui` integration):** This PR closes a class of TUI bugs where the assistant reply was missing or truncated after 1-2 message rounds. Root causes spanned the engine, the query-engine, and the TUI host:
>
> - **Engine lifecycle:** `KoiRuntime` gains `cycleSession()`, `rebindSessionId()`, `disposing` flag, generator `.return()` fast-path, sessionEpoch invalidation, retryable `dispose()`, and fail-closed onSessionEnd. Hooks (`onSessionStart`/`onSessionEnd`) now fire per-runtime-session, not per-`run()` — `cycleSession()` is the host-driven boundary. See `docs/L2/middleware-permissions.md` and `packages/kernel/core/src/middleware.ts` for the contract.
> - **Query engine:** Tool-error recovery is now capped at one extra model turn so a deterministic tool failure can't spin until `maxTurns`. Aborted tools transition straight to interrupted instead of going through the recovery path.
> - **CLI host (`@koi-agent/cli` `tui-command.ts` + `tui-runtime.ts`):**
>   - `EventBatcher` (in `@koi/tui`) gains `readonly isDisposed: boolean`. `drainEngineStream` polls it before/after every enqueue and synthesizes a terminal `done` engine event when the batcher dies mid-stream so the reducer leaves "processing" state.
>   - `resetConversation()` defers `clear_messages`, `set_trajectory_data`, transcript splice, and `tuiTurnCounter = 0` until `resetSessionState()` resolves successfully. On failure the visible history is preserved and a `RESET_FAILED` toast tells the user to restart.
>   - `resetBarrier` carries a `Promise<boolean>` — `false` means the reset failed-closed. `/rewind` and `onSessionSelect` check the value and abort hydration on failure (otherwise stale state would mix with the resumed transcript). Both paths call `runtime.rebindSessionId(sessionId)` AFTER successfully loading the transcript so future turns persist under the resumed chain.
>   - `tui-runtime.ts resetSessionState()` reorders steps so `createManagedTaskBoard()` runs as a fail-fast pre-flight, `cycleSession()` is the atomic commit point, and `bgController.abort()` only fires after the cycle succeeds — a failed reset no longer kills `bash_background` jobs the user expected to keep.
>   - `resetIterationBudgetPerRun: true` plus a 1M cumulative token cap (10x default, down from a transient 5M during review) gives interactive sessions a fresh per-iteration turn/duration budget while keeping a real process-level spend ceiling.
>   - The submit path constructs the engine stream BEFORE dispatching `add_user_message` so a synchronous `runtime.run()` rejection (poisoned/disposed/lifecycleInFlight/already-running) doesn't leave a phantom user prompt in the visible UI without engine context.
>   - Shutdown wraps `runtime.dispose()` in a try/catch so the new fail-closed timeout path doesn't bypass `approvalStore.close()` / `process.exit()`. The 8s hard-exit failsafe is the ultimate backstop.
>
> The PR went through three full adversarial review loops (30 rounds, 30 commits) hardening race windows around `/clear`, dispose, and resume. See PR #1745 for the full review trail.

> **TUI permission bridge lifecycle + 60-minute approval window (#1759):** `createPermissionBridge({ timeoutMs: 60 * 60 * 1000 })` — long enough that realistic user decisions never trigger the fail-closed path, but finite so a wedged renderer / stuck bridge eventually aborts the turn. The matching 60-minute engine-side `approvalTimeoutMs` is passed to `createPermissionsMiddleware` in `tui-runtime.ts` so both layers share the same deadline. `abortActiveStream` now calls `permissionBridge.cancelPending("Turn cancelled by user")` AFTER `activeController.abort()` so the middleware's signal race wins (produces `stopReason: "interrupted"` rather than a synthetic permission deny). `resetConversation` adds a matching `cancelPending("Session reset")` so `agent:clear` / `session:new` / resume cannot leave a stale 60-minute approval modal on screen. `ToolRequest.callId` is threaded through the turn-runner so the TUI can dispatch per-call `tool_execution_started` reducer actions on approval; the dedicated field keeps the identifier out of the approval cache and backend policy context. See `docs/L2/tui.md` and `docs/L2/middleware-permissions.md` for the full semantics.

> **Trajectory session-leak guards + reset UX polish (#1764):**
>
> - **Session-validated `trajectoryStore` wrapper.** `createDecisionLedger()` in `tui-runtime.ts` now wraps the shared in-memory `trajectoryStore` so its `getDocument(docId)` compares `docId` against the live `runtime.sessionId` before returning data. The TUI stores all trajectory records under the fixed `TUI_DOC_ID` key ("koi-tui-session"), so a mismatch (stale/cross-session read after `session:new` or resume) would otherwise silently serve the global document and leak the prior session's steps into a freshly cleared lane. On mismatch, the wrapper returns `[]` so the caller's `set_trajectory_data` dispatch produces an empty lane instead of a leak.
>
> - **`trajectoryRefreshGen` stale-refresh guard.** Every call to `resetConversation()` bumps a monotonic `trajectoryRefreshGen` counter eagerly (before the async `cycleSession()` dispatches and before the post-settle store clears). Each fire-and-forget `refreshTrajectoryData(...)` call captures the generation at scheduling time and passes an `isStillCurrent()` closure into the refresh; the refresh skips its `set_trajectory_data` dispatch if the generation has advanced. Without this, a 500 ms post-turn refresh scheduled before `/clear` could race ahead of the reset and repopulate the just-cleared lanes with that turn's data. The bump fires immediately (not inside the success branch) so a refresh landing in the window between `/clear` invocation and `resetSessionState` resolution is still invalidated.
>
> - **`summarizeRunReport(runReport)`.** `refreshTrajectoryData` no longer calls `JSON.stringify(runReport).slice(0, 300)` for the `/trajectory` run-report lane. A delegated run with a deeply nested `childReports` tree could spike CPU/memory walking the tree on every refresh. The new helper picks high-level summary text (truncated to 180 chars), action / artifact / issue / recommendation counts, child-report count, and total token usage — bounded to 300 chars regardless of input depth. Unit-tested in `tui-command.test.ts` with a 50,000-deep synthetic report to assert output is still bounded and completes in <50 ms.
>
> - **`TrajectoryView` render hardening.** Fixed two compounding bugs that crashed `/trajectory` on first open (or nav-away-back to it): (1) the ledger-source `<Show>` re-read `ledgerSources()` inside its children closure and cast the result as `LedgerSources`, which NPE'd when the signal rotated null during a reset before Show unmounted — switched to the keyed form `when={ledgerSources()}` + accessor param so children only see the frozen non-null value; (2) OpenTUI rejects `<text>` nested inside `<text>` — the source-status row embedded styled child `<text>` elements inside an outer `<text>` and threw "only accepts strings, TextNodeRenderable instances, or StyledText instances" on render. Flattened into a `flexDirection="row"` box with sibling text elements, matching `TurnHeaderRow` / `StepRow`.
>
> - **`RESET_NOTICE` toast removed.** #1742's post-reset `add_error` dispatch warning about cumulative token spend was removed. `ErrorBlock` renders every `add_error` as red "Error: CODE" — mislabeled a successful `/clear` as a failure. If the runtime-wide spend cap is later exceeded, the budget-exceeded error itself surfaces the explanation. `/clear` is silent on success (matches Claude Code).
