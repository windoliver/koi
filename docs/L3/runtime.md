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
| `@koi/event-trace` | ATIF trajectory recording middleware | all queries |
| `@koi/fs-local` | Local filesystem backend (read/write/edit/list) | `local-fs-read` |
| `@koi/fs-nexus` | Nexus-backed filesystem backend | `nexus-fs-read` (optional) |
| `@koi/hook-prompt` | Prompt injection hook for pre/post model call | standalone |
| `@koi/hooks` | Hook dispatch middleware (command/HTTP/prompt/agent) — per-call abort propagation via extended `HookRegistry.execute(sessionId, event, abortSignal?)` + `hasMatching` introspection (#1490) | `tool-use`, `hook-blocked`, `hook-once` |
| `@koi/mcp` | MCP transport + tool/resource resolver | `mcp-tool-use` |
| `@koi/memory` | Memory recall, scoring, and formatting | `memory-store` |
| `@koi/memory-fs` | File-based memory storage backend — per-dir mutex + `.memory.lock` for write serialization, worktree-local by default (`shared: true` opt-in with policy pinning), atomic temp-rename updates, `indexError` on mutation returns, serialized MEMORY.md rebuilds | standalone |
| `@koi/memory-tools` | Memory read/write/list tools | `memory-store` |
| `@koi/middleware-exfiltration-guard` | Credential exfiltration detection middleware | standalone |
| `@koi/middleware-goal` | Goal drift detection and attention management (keyword heuristic; redesign tracked in #1512) | `tool-use` |
| `@koi/middleware-permissions` | Tool/model permission gating middleware | `permission-deny`, `denial-escalation` |
| `@koi/middleware-report` | RunReport generation middleware | `tool-use` |
| `@koi/middleware-semantic-retry` | Semantic retry on model failures | standalone |
| `@koi/model-openai-compat` | OpenAI-compatible model adapter (OpenRouter etc.) | all LLM queries |
| `@koi/permissions` | Permission backend (bypass/default/nexus modes) | `permission-deny` |
| `@koi/query-engine` | Model stream consumer + turn runner | all queries |
| `@koi/spawn-tools` | Agent spawn tool + coordinator utilities (TaskCascade, recoverOrphanedTasks) | `spawn-tools` |
| `@koi/task-tools` | Task board tools (create/get/update/list/stop/output/delegate) | `task-tools` |
| `@koi/tasks` | In-memory task board store | `task-board` |
| `@koi/bash-security` | Bash command classifier pipeline — allowlist gate, injection/path/command denylist (L0u) | standalone |
| `@koi/tools-bash` | Bash execution tool: cwd-contained, env-isolated, process-group kill, exfiltration denylist | `bash-exec` |
| `@koi/tools-builtin` | Built-in tools: Glob, Grep, ToolSearch, Read, FsRead | `glob-use` |
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

> **Wiring (PR #1518):** `@koi/agent-runtime` wired via `config.agentDirs` shortcut. `RuntimeConfig` now accepts `agentDirs?: AgentResolverDirs` — `createRuntime()` calls `createAgentResolver(agentDirs)` internally when no explicit `resolver` is provided. Load warnings and conflicts emitted via `console.warn` and exposed on `RuntimeHandle.agentWarnings`/`agentConflicts`. Golden queries are 2 standalone assertions (no LLM) in `describe("Golden: @koi/agent-runtime")`; end-to-end spawn coverage is provided by the existing `spawn-agent` trajectory.
