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
| `@koi/memory` | Memory recall, scoring, and formatting — static headings, JSON metadata inside `<memory-data>` trust boundary, scan resilience (`starved`, `candidateLimitHit`), opt-in `maxCandidates` I/O bound | `memory-recall` |
| `@koi/memory-fs` | File-based memory storage backend — per-dir mutex + `.memory.lock` for write serialization, worktree-local by default (`shared: true` opt-in with policy pinning), atomic temp-rename updates, `indexError` on mutation returns, serialized MEMORY.md rebuilds | standalone |
| `@koi/memory-tools` | Memory read/write/list tools — sandboxed with `memoryDir` filesystem caps, atomic `storeWithDedup`, idempotent delete | `memory-store` |
| `@koi/middleware-exfiltration-guard` | Secret exfiltration prevention — default-on for adapters with terminals. Scans tool I/O (input + output), model output (streaming + non-streaming including `richContent`), buffers all content-bearing stream chunks. `RuntimeConfig.exfiltrationGuard` to configure/disable | `exfiltration-guard-block` |
| `@koi/middleware-goal` | Goal drift + completion (keyword heuristic by default; custom `isDrifting`/`detectCompletions` callbacks per #1512). Stream path uses eager-flush on terminal `done` to survive `consumeModelStream` iterator cleanup (#1530) | `tool-use` |
| `@koi/middleware-permissions` | Tool/model permission gating middleware — approval trajectory capture via `approvalStepHandle` dispatch relay (#1498) | `permission-deny`, `denial-escalation` |
| `@koi/middleware-report` | RunReport generation middleware | `tool-use` |
| `@koi/middleware-semantic-retry` | Semantic retry on model failures | standalone |
| `@koi/session` | Session persistence (SQLite) + JSONL transcript middleware for crash recovery | standalone — wired via `RuntimeConfig.session.transcriptDir` |
| `@koi/model-openai-compat` | OpenAI-compatible model adapter (OpenRouter etc.) | all LLM queries |
| `@koi/permissions` | Permission backend (bypass/default/nexus modes) | `permission-deny` |
| `@koi/query-engine` | Model stream consumer + turn runner | all queries |
| `@koi/spawn-tools` | Agent spawn tool + coordinator utilities (TaskCascade, recoverOrphanedTasks) | `spawn-tools` |
| `@koi/task-tools` | Task board tools (create/get/update/list/stop/output/delegate) | `task-tools` |
| `@koi/tasks` | In-memory task board store | `task-board` |
| `@koi/bash-security` | Bash command classifier pipeline — allowlist gate, injection/path/command denylist (L0u) | standalone |
| `@koi/tools-bash` | Bash execution tool: cwd-contained, env-isolated, process-group kill, exfiltration denylist | `bash-exec` |
| `@koi/tools-builtin` | Built-in tools: Glob, Grep, ToolSearch, Read, FsRead. Credential path guard (`createCredentialPathGuard`) blocks fs tool access to `~/.ssh`, `~/.aws`, etc. — default-on via `RuntimeConfig.credentialPathGuard` | `glob-use` |
| `@koi/sandbox-os` | OS-level sandbox executor (macOS Seatbelt / Linux bwrap) with path-locked `run_sandboxed` tool | `sandbox-exec` |
| `@koi/tools-web` | Web fetch and search tools with SSRF protection | `web-fetch` |
| `@koi/harness` | CLI harness: single-prompt + interactive REPL wiring, TUI adapter bridge, fail-closed stream guards | standalone |

> **L0u packages also wired:** `@koi/tools-core` (`buildTool()` factory), `@koi/validation`, `@koi/task-board` are L0u (utility) packages depended on by `@koi/runtime` but not subject to the L2 doc/golden-query gates — their docs live under `docs/L0u/`.

### Spawn Inheritance Coverage (#1425)

The spawn path has three golden trajectories proving narrowing at the `ModelRequest.tools` boundary:

| Trajectory | What it proves |
|-----------|----------------|
| `spawn-inheritance` | Runtime `toolDenylist=["Glob"]` — Glob absent from child model call |
| `spawn-allowlist` | Runtime `toolAllowlist=["Grep"]` — child sees only Grep |
| `spawn-manifest-ceiling` | `manifest.spawn.tools.policy=allowlist` — engine enforces ceiling without any per-call list |

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

> **Security defaults (PR #1503):** `@koi/middleware-exfiltration-guard` now default-on for adapters with terminals. `createRuntime()` auto-installs the guard with `action: "block"`. New `RuntimeConfig.exfiltrationGuard` (`false` to disable, `Partial<ExfiltrationGuardConfig>` to customize). Explicit config on terminal-less adapters throws (fail-closed). The middleware gained `wrapModelCall` (non-streaming scan of `content` + `richContent`), tool output scanning (always-on, dual JSON+String representation), and stream chunk buffering (`text_delta` + `thinking_delta` + `tool_call_start/delta/end`). `ExfiltrationEvent.location` extended with `"tool-output"`. `@koi/tools-builtin`'s `createCredentialPathGuard()` now threaded through both `createFileSystemTools()` (dispatch) and `createFileSystemProvider()` (ECS provider via bound factory closures). New `RuntimeConfig.credentialPathGuard` (`false` to disable). `wrapModelStream` overflow state machine fixed: redact mode uses `textOnlyBuffer` (no hidden content leakage), block mode fails closed, warn mode replays held chunks preserving tool_call structure.
