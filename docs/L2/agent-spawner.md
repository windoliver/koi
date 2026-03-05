# @koi/agent-spawner — External Agent Delegation

Spawn external coding agents (Claude Code, Codex, Aider, Gemini CLI, OpenCode) inside sandboxed containers with ACP or stdio communication. Provides isolation, protocol negotiation, and concurrency control for safe multi-agent delegation.

---

## Why It Exists

1. **Isolation.** Delegated coding agents run inside a `SandboxInstance` (cloud container, microVM), not the host process. Agents cannot escape the working directory or access host resources.

2. **Protocol negotiation.** External agents speak two wire protocols — ACP (JSON-RPC 2.0) and stdio (`--print` mode). This package abstracts both behind a single `spawn()` call.

3. **Concurrency control.** A counting semaphore caps simultaneous delegations (default: 2) to prevent resource exhaustion when multiple sub-tasks run in parallel.

4. **Lazy sandbox lifecycle.** The sandbox container is created on first `spawn()` and reused across calls. An idle TTL (default: 60s) auto-destroys it when unused, amortizing startup cost without leaking resources.

---

## What This Enables

### Safe Agent-to-Agent Delegation

A Koi agent can delegate coding sub-tasks to any supported external agent without trusting it with host access:

```
Parent agent receives complex task
  → spawner.spawn(claude-code, "Refactor the auth module")
  → Sandbox created (lazy, reused across calls)
  → Claude Code runs inside sandbox with --print flag
  → stdout captured, trimmed, returned as Result<string, KoiError>
  → Parent integrates the result into its workflow
```

### Multi-Agent Coding Workflows

With concurrency control, a parent can fan out to multiple agents in parallel:

```
Parent agent plans 3 independent refactoring tasks
  → spawn(claude-code, task-1)  ─┐
  → spawn(codex, task-2)        ─┤  semaphore(2) — max 2 concurrent
  → spawn(aider, task-3)        ─┘  third waits in FIFO queue
  → All results collected, merged by parent
```

### Protocol-Agnostic Communication

Callers don't need to know which wire protocol an agent uses:

| Protocol | Wire format | CLI flags | Output parsing |
|----------|-------------|-----------|----------------|
| **stdio** (default) | stdout text | `--print <prompt>` | Trim whitespace |
| **ACP** | JSON-RPC 2.0 over stdin/stdout | `--acp` | Extract `session/update` notifications |

---

## Architecture

### Layer

`@koi/agent-spawner` is an **L2 feature package**. It imports only from `@koi/core` (L0) and L0u utilities (`@koi/acp-protocol`, `@koi/sandbox-cloud-base`).

### Module Map

```
src/
├── spawner.ts               createAgentSpawner() factory — sandbox lifecycle, protocol dispatch, semaphore
├── delegation-protocol.ts   Pure functions: CLI arg builders, stdout/JSON-RPC parsers
├── semaphore.ts             Async counting semaphore (FIFO queue)
├── companion-skill.ts       ECS skill provider — injects agent-spawner knowledge into LLM context
├── types.ts                 Public types: AgentSpawnerConfig, AgentSpawner, SpawnOptions
└── index.ts                 Public re-exports
```

### Key Components

| Component | Type | Purpose |
|-----------|------|---------|
| `createAgentSpawner` | Factory | Creates an `AgentSpawner` bound to a sandbox backend |
| `AgentSpawner.spawn` | Method | Runs an external agent inside a sandbox, returns `Result<string, KoiError>` |
| `createSemaphore` | Factory | Async counting semaphore for concurrency control |
| `createAgentSpawnerSkillProvider` | `ComponentProvider` | ECS integration — attaches companion skill to agent entity |

---

## Public API

### createAgentSpawner

```typescript
import { createAgentSpawner } from "@koi/agent-spawner";

const spawner = createAgentSpawner({
  adapter: mySandboxAdapter,       // SandboxAdapter (E2B, Daytona, etc.)
  cwd: "/workspace",               // working dir inside sandbox
  maxConcurrentDelegations: 2,     // semaphore cap (default: 2)
  maxOutputBytes: 10_485_760,      // 10 MB output limit
  idleTtlMs: 60_000,              // auto-destroy idle sandbox (default: 60s)
  env: { ANTHROPIC_API_KEY: "..." },
});

const result = await spawner.spawn(
  { command: "claude", protocol: "stdio", model: "sonnet" },
  "Refactor the auth module to use branded types",
);

if (result.ok) {
  console.log(result.value); // agent's text output
} else {
  console.error(result.error); // KoiError with code + retryable flag
}

await spawner.dispose(); // cleanup sandbox
```

### Delegation Protocol Helpers

Exported for advanced usage and testing:

```typescript
import {
  buildStdioArgs,
  buildAcpArgs,
  buildAcpStdin,
  parseStdioOutput,
  extractAcpOutput,
  DEFAULT_TIMEOUT_MS,
} from "@koi/agent-spawner";

buildStdioArgs("claude", "Fix the bug", "sonnet");
// → ["claude", "--print", "Fix the bug", "--model", "sonnet"]

buildAcpArgs("claude", "sonnet");
// → ["claude", "--acp", "--model", "sonnet"]
```

---

## Error Handling

Errors are classified as `DelegationFailureKind`:

| Kind | KoiErrorCode | Retryable | Trigger |
|------|-------------|-----------|---------|
| `TIMEOUT` | `"TIMEOUT"` | Yes | Execution timed out with no output |
| `SPAWN_FAILED` | `"EXTERNAL"` | Yes | Non-zero exit code or exception |
| `PARSE_FAILED` | `"EXTERNAL"` | No | Empty or whitespace-only output |

Partial output on timeout is returned as success — useful partial results are not discarded.

---

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `adapter` | (required) | `SandboxAdapter` backend (E2B, Daytona, cloud, etc.) |
| `cwd` | `"/workspace"` | Working directory inside the sandbox |
| `env` | `{}` | Environment variables injected into sandbox |
| `maxConcurrentDelegations` | `2` | Maximum simultaneous spawns |
| `maxOutputBytes` | `10_485_760` | Output size cap (10 MB) |
| `idleTtlMs` | `60_000` | Idle TTL before auto-destroying sandbox |

---

## Testing

- **25 tests** across 3 test files (unit + integration with mock sandbox adapter)
- Key test files:
  - `spawner.test.ts` — sandbox lifecycle, protocol dispatch, semaphore enforcement, dispose
  - `delegation-protocol.test.ts` — arg builders, output parsers (table-driven)
  - `companion-skill.test.ts` — ECS skill provider integration

---

## References

- `@koi/core` — L0 types: `ExternalAgentDescriptor`, `SandboxAdapter`, `SandboxInstance`, `Result`, `KoiError`
- `@koi/acp-protocol` — L0u: JSON-RPC message construction and line parsing
- `@koi/sandbox-cloud-base` — L0u: cloud sandbox adapter base types
- `@koi/delegation` — complementary package for permission delegation between agents
