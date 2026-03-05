# Forge Delegation Wiring — `createForgeDelegation()`

L3 composition root that connects `@koi/agent-discovery` (L2) and
`@koi/agent-spawner` (L3) to the two optional `ForgeDeps` callbacks,
enabling end-to-end sandboxed delegation.

## What This Enables

**One factory call makes `delegateTo` work end-to-end.** Without this wiring,
`ForgeDeps.discoverAgent` and `ForgeDeps.spawnCodingAgent` are empty slots —
any `forge_tool({ delegateTo: "claude-code" })` call fails immediately with
"requires discoverAgent and spawnCodingAgent callbacks."

With `createForgeDelegation()`:

1. Agent calls `forge_tool({ delegateTo: "claude-code", testCases: [...] })`
2. Discovery scans PATH for known CLI agents (Claude Code, Codex, Aider, etc.)
3. Spawner runs the agent inside a sandboxed container (Docker/E2B)
4. Agent returns implementation code
5. Forge verifies it through the full 6-stage pipeline (static → format → resolve → sandbox → self-test → trust)
6. If it passes, the brick is stored; if it fails, the brick is rejected

The orchestrating agent focuses on **what** tool it needs. The coding agent
writes **how**. Forge ensures it's **safe**.

## Quick Start

```typescript
import {
  createForgePipeline,
  createForgeDelegation,
  createDefaultForgeConfig,
} from "@koi/forge";

const delegation = createForgeDelegation({
  adapter: myDockerAdapter, // SandboxAdapter (Docker, E2B, etc.)
  cwd: "/workspace",
});

const deps: ForgeDeps = {
  store, executor, verifiers,
  config: createDefaultForgeConfig(),
  context: { agentId, depth: 0, sessionId, forgesThisSession: 0 },
  pipeline: createForgePipeline(),
  // Wire delegation:
  discoverAgent: delegation.discoverAgent,
  spawnCodingAgent: delegation.spawnCodingAgent,
};

// Now forge_tool({ delegateTo: "claude-code" }) works end-to-end
```

## Configuration

```typescript
interface ForgeDelegationConfig {
  /** Sandbox adapter for isolated containers. Required. */
  readonly adapter: SandboxAdapter;
  /** Working directory inside the sandbox. */
  readonly cwd?: string;
  /** Environment variables to inject. */
  readonly env?: Record<string, string>;
  /** Max concurrent delegations. Default: 2. */
  readonly maxConcurrentDelegations?: number;
  /** Max stdout bytes before truncation. Default: 10 MB. */
  readonly maxOutputBytes?: number;
  /** Discovery cache TTL. Default: 60,000 ms. */
  readonly cacheTtlMs?: number;
  /** Override discovery sources (defaults to PATH scanner). */
  readonly discoverySources?: DiscoverySource[];
}
```

## How It Works

### Discovery bridge

`discoverAgent(name)` calls `@koi/agent-discovery`'s `createDiscovery()` with
a PATH scanner source. It scans for known CLI agents (Claude Code, Codex,
Aider, OpenCode, Gemini CLI) and returns an `ExternalAgentDescriptor`.

- Results are cached (default 60s TTL) — repeated calls are near-instant
- Returns `NOT_FOUND` if the agent isn't on PATH
- Validates empty names before scanning

### Spawn bridge

`spawnCodingAgent(agent, prompt, options)` calls `@koi/agent-spawner`'s
`createAgentSpawner()` which runs the agent inside a sandbox container.

- Bridges `DelegateOptions` → `SpawnOptions` (passes `model` + `timeoutMs`)
- Drops `retries` — retry logic lives in `delegateImplementation()` (L2)
- Supports both ACP (JSON-RPC) and stdio protocols
- Concurrency limited by semaphore (default: 2 concurrent)

### Lifecycle

Call `delegation.dispose()` when done to release sandbox resources.
The spawner reuses a single sandbox instance across calls and auto-destroys
it after idle timeout (default 60s).

## Architecture

```
┌──────────────────────────────────────────────────┐
│  @koi/forge (L3) — createForgeDelegation()       │
│                                                  │
│  ┌────────────────┐    ┌─────────────────────┐   │
│  │ discoverAgent() │    │ spawnCodingAgent()   │   │
│  └───────┬────────┘    └──────────┬──────────┘   │
│          │                        │              │
│          ▼                        ▼              │
│  @koi/agent-discovery     @koi/agent-spawner     │
│  (L2 — PATH scan)        (L3 — sandbox exec)    │
└──────────────────────────────────────────────────┘
                    │
                    ▼
          ForgeDeps callbacks
                    │
                    ▼
        delegateImplementation()
        (L2 — @koi/forge-tools)
        discovery → prompt → retry → spawn
                    │
                    ▼
           Forge verification pipeline
           (static → sandbox → trust)
```

No layer violations — L3 importing L2 is allowed by architecture rules.

## Performance

- **Discovery caching**: PATH scan happens once per TTL (60s default), not per call
- **Sandbox reuse**: Single container instance reused across spawns with idle auto-destroy
- **Concurrency control**: Semaphore limits concurrent delegations (default 2) to prevent resource exhaustion
- **No hot-path overhead**: Discovery and spawning only run when `delegateTo` is set — regular forge calls are unaffected

## Analogous Pattern

This follows the same composition pattern as `createForgePipeline()`:

| Factory | Wires | Into |
|---------|-------|------|
| `createForgePipeline()` | forge-verifier + forge-integrity + forge-policy | `ForgeDeps.pipeline` |
| `createForgeDelegation()` | agent-discovery + agent-spawner | `ForgeDeps.discoverAgent` + `ForgeDeps.spawnCodingAgent` |

Both are L3-only because they import from multiple L2 peers.

## Files

| File | What |
|------|------|
| `src/create-forge-delegation.ts` | Factory + config + result types |
| `src/create-forge-delegation.test.ts` | 7 tests, 100% coverage |
| `src/index.ts` | Re-exports `createForgeDelegation`, `ForgeDelegation`, `ForgeDelegationConfig` |

## Related

- [Forge Delegation (L2)](../L2/forge-delegation.md) — The delegation orchestrator (`delegateImplementation()`)
- **#744** — Sandboxed coding agent spawning
- **#688** — Forge → delegation bridge
