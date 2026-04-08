# @koi/runtime — Full-Stack Agent Runtime Integration

The canonical L3 integration layer. Wires every production-ready L2 package into a single coherent runtime surface, provides VCR cassette replay infrastructure for CI, and owns the golden query test suite that proves all L2 packages work end-to-end with a real LLM.

---

## What This Enables

### One-Call Full-Stack Assembly

`createRuntime()` (via `@koi/engine`'s `createKoi`) assembles an agent with every production middleware, tool, channel, and backend already wired. Consumers don't manually compose packages:

```typescript
import { createRuntime } from "@koi/runtime";

const runtime = await createRuntime({ manifest, adapter });
for await (const event of runtime.run({ kind: "text", text: "Hello" })) { ... }
```

### Golden Query CI Coverage

Every L2 package wired into `@koi/runtime` must have:
- A `QueryConfig` entry in `scripts/record-cassettes.ts` exercising its primary tools/middleware
- A `fixtures/<name>.trajectory.json` recorded with a real LLM (ATIF v1.6)
- Assertions in `src/__tests__/golden-replay.test.ts` validating the trajectory

This ensures no L2 package is wired without proven end-to-end coverage.

---

## Integrated L2 Packages

| Package | Role | Golden query |
|---------|------|-------------|
| `@koi/agent-runtime` | Agent definition registry + built-in agent resolver | `spawn-agent` |
| `@koi/channel-cli` | CLI stdin/stdout channel adapter | standalone |
| `@koi/event-trace` | ATIF trajectory recording middleware — tool metadata allowlisted (#1499), system step `__koi` transport for lossless round-trip | all queries |
| `@koi/fs-local` | Local filesystem backend (read/write/edit/list) | `local-fs-read` |
| `@koi/fs-nexus` | Nexus-backed filesystem backend | `nexus-fs-read` (optional) |
| `@koi/hook-prompt` | Prompt injection hook for pre/post model call | standalone |
| `@koi/hooks` | Sole hook dispatcher (command/HTTP/prompt/agent) — single dispatcher + observer tap pattern (#1513). `createHookMiddleware` is the sole authority for all hook events; `@koi/runtime`'s `createHookObserver` subscribes via `onExecuted` tap for ATIF recording. Per-call abort propagation, fail-closed pre-hook blocking, cancel-redaction with `failClosed` filtering | `tool-use`, `hook-blocked`, `hook-once` |
| `@koi/mcp` | MCP transport + tool/resource resolver | `mcp-tool-use` |
| `@koi/mcp-server` | MCP server — exposes agent tools + platform capabilities (mailbox, tasks, registry) to external MCP clients. 7 platform tools built as real Koi Tools via `buildTool()`. Security: callerId enforcement, event-only mailbox, owned task mutations, visibility-filtered registry, prototype pollution protection, error sanitization | `mcp-server-send` |
| `@koi/memory` | Memory recall, scoring, and formatting — static headings, JSON metadata inside `<memory-data>` trust boundary, scan resilience (`starved`, `candidateLimitHit`), opt-in `maxCandidates` I/O bound | `memory-recall` |
| `@koi/memory-fs` | File-based memory storage backend — per-dir mutex + `.memory.lock` for write serialization, worktree-local by default (`shared: true` opt-in with policy pinning), atomic temp-rename updates, `indexError` on mutation returns, serialized MEMORY.md rebuilds | standalone |
| `@koi/memory-tools` | Memory read/write/list tools — sandboxed with `memoryDir` filesystem caps, atomic `storeWithDedup`, idempotent delete | `memory-store` |
| `@koi/middleware-exfiltration-guard` | Secret exfiltration prevention — default-on for adapters with terminals. Scans tool I/O (input + output), model output (streaming + non-streaming including `richContent`), buffers all content-bearing stream chunks. `RuntimeConfig.exfiltrationGuard` to configure/disable | `exfiltration-guard-block` |
| `@koi/middleware-goal` | Goal drift + completion (keyword heuristic by default; custom `isDrifting`/`detectCompletions` callbacks per #1512). Stream path uses eager-flush on terminal `done` to survive `consumeModelStream` iterator cleanup (#1530) | `tool-use` |
| `@koi/middleware-permissions` | Tool/model permission gating middleware — approval trajectory capture via `approvalStepHandle` dispatch relay (#1498) | `permission-deny`, `denial-escalation` |
| `@koi/middleware-report` | RunReport generation middleware | `tool-use` |
| `@koi/middleware-semantic-retry` | Semantic retry on model failures | standalone |
| `@koi/session` | Session persistence (SQLite/WAL) + JSONL transcript middleware + `resumeFromTranscript()` for crash recovery. Phase 2e-2: `SessionStatus`, `ContentReplacement`, `CompactResult` boundary extension, instance-local queue isolation | standalone — wired via `RuntimeConfig.session.transcriptDir` |
| `@koi/model-openai-compat` | OpenAI-compatible model adapter (OpenRouter etc.) | all LLM queries |
| `@koi/permissions` | Permission backend (bypass/default/nexus modes) | `permission-deny` |
| `@koi/query-engine` | Model stream consumer + turn runner; `validateToolArgs` recognizes `items`/`properties`/`required` plus constraint keywords (`minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `enum`, `const`, `additionalProperties`, `propertyNames`). `runTurn` deduplicates identical tool calls within a single model response (#1580) — canonicalized key comparison, real result replication to skipped callIds, `dedup_skipped` custom event. `appendAssistantTurn` combines text + tool calls into a single message with `metadata.toolCalls` | all queries |
| `@koi/spawn-tools` | Agent spawn tool + coordinator utilities (TaskCascade, recoverOrphanedTasks) | `spawn-tools` |
| `@koi/task-tools` | Task board tools (create/get/update/list/stop/output/delegate) + ComponentProvider + offset-based output reads | `task-tools` |
| `@koi/tasks` | Task board stores + runtime task system (output streaming, task kinds, registry, runner, LocalShellTask lifecycle). `ManagedTaskBoardConfig` gains `onEngineEvent` + `agentId` for automatic plan/progress engine event bridging (#1555) | `task-board` |
| `@koi/bash-security` | Bash command classifier pipeline — allowlist gate, injection/path/command denylist (L0u) | standalone |
| `@koi/tools-bash` | Bash execution tool: cwd-contained, env-isolated, process-group kill, exfiltration denylist. Now includes `createBashBackgroundTool()` for fire-and-forget subprocess execution via `ManagedTaskBoard`, shared `exec.ts` spawn/drain layer, `trackCwd` sentinel for directory tracking, and OS sandbox DI (`sandboxAdapter` + `sandboxProfile`) | `bash-exec`, `bash-background`, `bash-track-cwd` |
| `@koi/tools-builtin` | Built-in tools: Glob, Grep, ToolSearch, Read, FsRead. Interaction tools: TodoWrite, EnterPlanMode, ExitPlanMode, AskUserQuestion. Credential path guard (`createCredentialPathGuard`) blocks fs tool access to `~/.ssh`, `~/.aws`, etc. — default-on via `RuntimeConfig.credentialPathGuard` | `glob-use`, `todo-write`, `plan-mode`, `ask-user`, `interaction-full` |
| `@koi/sandbox-os` | OS-level sandbox executor (macOS Seatbelt / Linux bwrap). Sandbox adapter now injected into `createBashTool()` at L3 (DI pattern replaces standalone `run_sandboxed` tool). Seatbelt deny rules fixed: explicit `file-read-data`/`file-read-metadata` instead of invalid `file-read*` wildcard | `sandbox-exec` |
| `@koi/tools-web` | Web fetch and search tools with SSRF protection | `web-fetch` |
| `@koi/skill-scanner` | AST-based security scanner for SKILL.md code blocks. Detects dangerous APIs (eval, child_process, process.binding, vm), bracket-notation bypasses (`obj["method"]()`), template-literal keys (`` obj[`method`]() ``), obfuscation, prompt injection, exfiltration, and SSRF patterns. Used by `@koi/skills-runtime` as a fail-closed gate (#1572) | standalone |
| `@koi/skills-runtime` | Multi-source skill loader (`mcp < bundled < user < project` precedence) with fail-closed AST security gate (`@koi/skill-scanner`). Progressive loading: `discover()` returns `SkillMetadata` (frontmatter only, no body); `load()` promotes to `SkillDefinition` with body + scan. In-memory registry: `query(filter?)` filters by tags/source/capability (AND semantics for multi-tag). `invalidate(name?)` for cache control. Inflight deduplication for concurrent access. `registerExternal(skills)` injects non-filesystem skills (e.g., MCP-derived) with separate cache lifecycle. Execution modes: `execution: inline` (default, context injection) or `execution: fork` (sub-agent spawn via `mapSkillToSpawnRequest()`). `createSkillProvider()` loads all skills at attach time and inserts each as a `SkillComponent` under `skillToken(name)` in the agent ECS. `createSkillInjectorMiddleware()` (resolve phase, priority 300) reads skill components and prepends their content into `request.systemPrompt`, sorted alphabetically for deterministic output. Accepts `Agent \| (() => Agent)` for lazy resolution | `skill-load` |
| `@koi/skill-tool` | SkillTool meta-tool — model invokes `Skill(name, args?)` for on-demand skill loading. Budget-aware advertising (3-phase: full → truncated → names-only). Inline mode returns substituted body; fork mode delegates to `SpawnFn` with recursion guard. Structural `SkillResolver` interface avoids cross-L2 imports. Fail-closed spawn validation: empty allowlists, reserved-only tools, missing spawnFn all return typed errors (#1594) | `skill-tool-use` |
| `@koi/harness` | CLI harness: single-prompt + interactive REPL wiring, TUI adapter bridge, fail-closed stream guards. Renders `plan_update` and `task_progress` events in verbose mode (#1555) | standalone |

> **L0u packages also wired:** `@koi/tools-core` (`buildTool()` factory), `@koi/validation`, `@koi/task-board` are L0u (utility) packages depended on by `@koi/runtime` but not subject to the L2 doc/golden-query gates — their docs live under `docs/L0u/`.

### Spawn Inheritance Coverage (#1425)

The spawn path has three golden trajectories proving narrowing at the `ModelRequest.tools` boundary:

| Trajectory | What it proves |
|-----------|----------------|
| `spawn-inheritance` | Runtime `toolDenylist=["Glob"]` — Glob absent from child model call |
| `spawn-allowlist` | Runtime `toolAllowlist=["Grep"]` — child sees only Grep |
| `spawn-manifest-ceiling` | `manifest.spawn.tools.policy=allowlist` — engine enforces ceiling without any per-call list |

### Fork Mode + Coordinator Allowlist Coverage (#1241)

Two standalone golden queries (no LLM required) prove the coordinator tool surface:

| Query | What it proves |
|-------|----------------|
| `COORDINATOR_TOOL_ALLOWLIST` shape | `agent_spawn` present; `Glob`/`Grep`/`ToolSearch` absent; allowlist matches manifest spawn config (single source of truth) |
| Coordinator manifest spawn policy | `spawn.tools.policy === "allowlist"`; manifest list equals `COORDINATOR_TOOL_ALLOWLIST` |

The `spawn-fork` and `spawn-coordinator` trajectory fixtures record fork mode spawning and coordinator-ceiling enforcement end-to-end.

---

## Adding a New L2 Package

Follow the Doc → Tests → Code workflow:

1. **Doc first**: create or update `docs/L2/<name>.md`
2. **Update this file**: add a row to the table above
3. **Wire**: add dep to `packages/meta/runtime/package.json`
4. **Golden query**: add `QueryConfig` to `scripts/record-cassettes.ts`
5. **Record**: `OPENROUTER_API_KEY=... bun scripts/record-cassettes.ts`
6. **Assert**: add `describe("Golden: @koi/<name>", ...)` to `golden-replay.test.ts`
7. **CI gates**: `check:orphans`, `check:golden-queries`, `check:doc-wiring` must all pass

---

## CI Gates

| Gate | What it checks |
|------|---------------|
| `check:orphans` | Every L2 dep of `@koi/runtime` appears in `check:layers` graph |
| `check:golden-queries` | Every L2 dep has golden query assertions |
| `check:doc-gate` | Every L2 package has a `docs/L2/<name>.md` |
| `check:doc-wiring` | Modified L2 packages and changed L3 wiring have updated docs |

> **Maintenance note (PR #1506):** Lint-only fixes applied to integrated packages (@koi/event-trace, @koi/model-openai-compat, @koi/mcp, @koi/middleware-permissions). No wiring changes; L2 package set is unchanged.

> **Wiring (PR #1511):** `@koi/sandbox-os` added. Golden query `sandbox-exec` exercises the path-locked `run_sandboxed` tool under macOS Seatbelt / Linux bwrap. The golden query is trajectory-only (no cassette replay) — the sandbox executes live `ls` during recording; CI validates the fixture fields.

> **Auth wiring (PR #1438):** `@koi/fs-nexus` gained inline OAuth support for connectors requiring browser auth (gdrive, gmail, etc.). New runtime helpers: `resolveFileSystemAsync()` returns `{ backend, operations, transport }` — callers must pass `filesystemOperations` to `createRuntime()` to preserve write/edit grants and use `transport.submitAuthCode()` to wire the remote paste-redirect flow. `RuntimeConfig.filesystem` now also accepts a pre-created `FileSystemBackend`. New golden trajectory `gdrive-oauth-e2e` captures the full auth flow: mount → auth_required → localhost callback → token exchange. Requires nexus-fs `>= 0.4.6`.

> **Wiring (PR #1519):** `@koi/bash-security` (L0u) and `@koi/tools-bash` (L2) added. `createBashTool()` provides a cwd-contained, env-isolated bash execution tool with a classifier pipeline (allowlist → injection → path → command → exfiltration), process-group kill on abort/timeout, and a spawn-error handler. Full filesystem confinement requires injecting an OS sandbox via `wrapCommand` at the L3 layer. Golden query `bash-exec` records a trajectory of the Bash tool being called and returning stdout.

> **Retry tracing (PR #1502):** `RuntimeConfig.retrySignalReader` threads a `RetrySignalReader` (L0) into per-stream event-trace middleware, so retry annotations (`retryOfTurn`, `retryAttempt`, `retryReason`) appear in production ATIF trajectories. Callers create a `RetrySignalBroker` externally and pass the writer to semantic-retry, reader to runtime. `agentName` is now also threaded (previously hardcoded as `"runtime"`). `@koi/middleware-semantic-retry` gains hook-blocked tool response detection (`blockedByHook` metadata) — treated as a no-op on retry state (event-trace handles classification independently). `@koi/context-manager` surfaces `preservationFailed`/`preservationError` on `BudgetEnforcementResult` when `onBeforeDrop` callbacks fail (fail-open).

> **Wiring (PR #1518):** `@koi/agent-runtime` wired via `config.agentDirs` shortcut. `RuntimeConfig` now accepts `agentDirs?: AgentResolverDirs` — `createRuntime()` calls `createAgentResolver(agentDirs)` internally when no explicit `resolver` is provided. Load warnings and conflicts emitted via `console.warn` and exposed on `RuntimeHandle.agentWarnings`/`agentConflicts`. Golden queries are 2 standalone assertions (no LLM) in `describe("Golden: @koi/agent-runtime")`; end-to-end spawn coverage is provided by the existing `spawn-agent` trajectory.

> **Monotonic timestamps (PR #1569, issue #1558):** `RuntimeConfig.clock` now accepts a base clock function; `createRuntime()` wraps it in a per-stream `createMonotonicClock()` from `@koi/event-trace` so concurrent sessions never interfere. Clock injection threaded to all trajectory emitters: event-trace, trace-wrapper, hook-observer, mcp-lifecycle, and harness step helpers. The ATIF store enforces monotonicity at append time as a safety net for L1 emitters. Added `validate-timestamps.ts` script for fixture hygiene. All 28 golden fixtures re-recorded with strictly increasing timestamps. Resolves #1558 and #1559.

> **Prompt cache stability (PR #1554, issue #1554):** `@koi/model-openai-compat` now sorts tools alphabetically before sending to the model API for KV cache prefix stability. Capability banner is cached per answer attempt and reused on stop-gate retries (replaces `skipCapabilityInjection`). `promptPrefixFingerprint` (SHA-256 of system prompt + sorted tool payload) added to `ModelResponse.metadata` for cache drift diagnostics. `@koi/context-manager`'s `micro-compact.ts` documents cache-boundary constraints.

> **Wiring (PR #1560):** `@koi/skills-runtime` (L2) and `@koi/skill-scanner` (L0u) added. `createSkillProvider()` is a `ComponentProvider` that calls `runtime.loadAll()` at agent attach time, inserting each loaded skill as a `SkillComponent` under `skillToken(name)`. Golden query `skill-load` proves the full wiring path (MCP connect → skill load → model call). Security hardening applied: include boundary tightened to skill's own directory, Windows-safe path checks via `path.relative()`, `node:`-prefix normalization for dangerous-module detection, static `ImportDeclaration` detection, and CommonMark tilde/indented-fence support. Follow-up gaps filed as #1571 (fence length enforcement) and #1572 (bracket-notation bypass). PR #1587 closes #1572: bracket-notation (`obj["method"]()`) and template-literal (`` obj[`method`]() ``) member calls now resolved as static strings via `getComputedStringProperty()` + `flattenMemberChain()` in `walker.ts`. `@koi/skill-scanner` wired as direct `@koi/runtime` dependency with 2 standalone golden queries.

> **Skill injection (PR #1590):** `createSkillInjectorMiddleware()` added to `@koi/skills-runtime`. Reads `SkillComponent` entries from the agent ECS at each model call and prepends their content into `request.systemPrompt`. Skills sorted alphabetically for deterministic prompt text and prompt-cache stability. Accepts `Agent | (() => Agent)` for lazy resolution (middleware created before `createKoi` assembles the entity). Golden replay test captures `ModelRequest` in the adapter terminal and asserts `systemPrompt` contains skill content. `koi tui` wired: loads skills from `~/.claude/skills/` at startup via `createSkillsRuntime().loadAll()` and prepends to the system prompt.

> **Interaction tools wiring:** `createInteractionProvider` exported from `@koi/runtime` wraps all four interaction tools (TodoWrite, EnterPlanMode, ExitPlanMode, AskUserQuestion) into an ECS `ComponentProvider`. State (todo items, plan mode flag, plan content) is ephemeral — stored in closure locals per `attach()` call, lost on process restart. `onEnterPlanMode` / `onExitPlanMode` hook callbacks let the harness enforce the read-only permission gate and restore pre-plan permissions + `allowedPrompts` after approval. `AskUserQuestion` is omitted entirely when `elicit` is not provided. Swarm-path wiring (`isTeammate`, `writeToMailbox`) belongs to `@koi/swarm` (#1416) — `createInteractionProvider` defaults to the non-swarm path. Golden queries: `todo-write`, `plan-mode`, `ask-user`, `interaction-full`.

> **Security defaults (PR #1503):** `@koi/middleware-exfiltration-guard` now default-on for adapters with terminals. `createRuntime()` auto-installs the guard with `action: "block"`. New `RuntimeConfig.exfiltrationGuard` (`false` to disable, `Partial<ExfiltrationGuardConfig>` to customize). Explicit config on terminal-less adapters throws (fail-closed). The middleware gained `wrapModelCall` (non-streaming scan of `content` + `richContent`), tool output scanning (always-on, dual JSON+String representation), and stream chunk buffering (`text_delta` + `thinking_delta` + `tool_call_start/delta/end`). `ExfiltrationEvent.location` extended with `"tool-output"`. `@koi/tools-builtin`'s `createCredentialPathGuard()` now threaded through both `createFileSystemTools()` (dispatch) and `createFileSystemProvider()` (ECS provider via bound factory closures). New `RuntimeConfig.credentialPathGuard` (`false` to disable). `wrapModelStream` overflow state machine fixed: redact mode uses `textOnlyBuffer` (no hidden content leakage), block mode fails closed, warn mode replays held chunks preserving tool_call structure.

> **Nexus trajectory persistence (PR #1592, issue #1469 Phase 1):** `@koi/fs-nexus` now exports `createHttpTransport` for transport reuse by non-filesystem consumers. `@koi/runtime` gains `createNexusAtifDelegate` — a Nexus-backed `AtifDocumentDelegate` so ATIF trajectory documents persist to a Nexus server and survive process restarts. New `RuntimeConfig.trajectoryNexus` option (mutually exclusive with `trajectoryDir`). Nexus transport lifecycle threaded into `runtime.dispose()`. Shared path-encoding utils extracted from `fs-delegate.ts`. Design: only `NOT_FOUND` maps to undefined (auth/permission errors propagate), `glob()` over `list()` to avoid truncation, basePath validated at construction, single-writer-per-docId mutex (OCC deferred to Phase 2).
