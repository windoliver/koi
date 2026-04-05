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
| `@koi/hooks` | Hook dispatch middleware (command/HTTP/prompt/agent) | `tool-use`, `hook-blocked`, `hook-once` |
| `@koi/mcp` | MCP transport + tool/resource resolver | `mcp-tool-use` |
| `@koi/memory` | Memory recall, scoring, and formatting | `memory-store` |
| `@koi/memory-fs` | File-based memory storage backend | standalone |
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
| `@koi/tools-builtin` | Built-in tools: Glob, Grep, ToolSearch, Read, FsRead | `glob-use` |
| `@koi/tools-web` | Web fetch and search tools with SSRF protection | `web-fetch` |

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
