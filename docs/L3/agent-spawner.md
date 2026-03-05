# @koi/agent-spawner — Sandboxed External Agent Delegation

Spawn external coding agents (Claude Code, Aider, Codex, OpenCode) inside isolated sandbox containers with ACP (JSON-RPC) or stdio communication. Per-spawn instance isolation, concurrency control, and manifest-driven routing from in-process to sandboxed execution.

---

## What This Feature Enables

### Run Untrusted or Third-Party Coding Agents Safely

Before this package, delegating work to external coding agents meant running them in the same process with full host access. Now agents declared with `sandbox` config in their manifest are automatically routed to isolated sandbox containers:

```yaml
# agent.koi.yaml — sandboxed external agent
name: code-reviewer
version: "1.0.0"
model:
  name: claude-sonnet-4-5-20250514
sandbox:
  adapter: e2b
  filesystem:
    allowRead: ["/workspace"]
    allowWrite: ["/workspace", "/tmp"]
  network:
    allow: false
  resources:
    timeoutMs: 120000
metadata:
  command: claude
  protocol: acp
capabilities:
  - code-generation
  - code-review
```

### Automatic Routing: Sandbox vs In-Process

The `createRoutingSpawnFn()` factory inspects `manifest.sandbox` at spawn time:

- **Sandbox present + command available** → agent-spawner runs the agent inside an isolated container (E2B, Daytona, OS-level sandbox)
- **No sandbox config** → falls through to default in-process SpawnFn (lightweight workers sharing the host)

```typescript
import { createAgentSpawner, createRoutingSpawnFn } from "@koi/agent-spawner";
import { createIpcStack } from "@koi/ipc-stack";

const agentSpawner = createAgentSpawner({
  adapter: myCloudAdapter, // E2B, Daytona, or OS adapter
});

const routingSpawn = createRoutingSpawnFn({
  defaultSpawn: myInProcessSpawn,
  agentSpawner,
});

// IPC stack uses routing spawn — manifest drives the decision
const ipc = createIpcStack({
  spawn: routingSpawn,
  delegation: { kind: "task-spawn" },
});
```

### Per-Spawn Isolation

Each `spawn()` call creates a fresh `SandboxInstance` that is destroyed after the task completes. No shared state between agent invocations — a compromised agent cannot affect subsequent spawns.

### Interactive ACP Protocol

When the sandbox adapter supports `spawn()` (bidirectional stdin/stdout), ACP agents use interactive streaming with NDJSON backpressure caps instead of batch exec. This enables real-time communication with agents that speak JSON-RPC.

---

## Architecture

```
Layer: L3 (meta-package)
Dependencies: @koi/core (L0), @koi/acp-protocol (L0u), @koi/sandbox-cloud-base (L0u)
```

### Internal Module Map

```
src/
├── routing-spawn.ts       Routing SpawnFn — manifest.sandbox dispatch
├── spawner.ts             Core spawner — per-spawn instances, ACP/stdio paths
├── delegation-protocol.ts ACP & stdio command/arg builders + output parsers
├── companion-skill.ts     Skill component teaching agents about delegation
├── semaphore.ts           Counting semaphore for concurrency control
├── types.ts               AgentSpawner, AgentSpawnerConfig, SpawnOptions
└── index.ts               Public API surface
```

### Spawn Flow

```
SpawnRequest (with manifest)
  │
  ├─ manifest.sandbox defined + metadata.command present
  │   │
  │   ▼
  │  createRoutingSpawnFn → agentSpawner.spawn()
  │   │
  │   ├─ semaphore.acquire()
  │   ├─ adapter.create(profile) → fresh SandboxInstance
  │   ├─ protocol routing:
  │   │   ├─ ACP + inst.spawn → spawnAcpInteractive (streaming)
  │   │   ├─ ACP + exec only → spawnAcp (batch)
  │   │   └─ stdio → spawnStdio (batch)
  │   ├─ inst.destroy() (always, via finally)
  │   └─ semaphore.release()
  │
  └─ no sandbox config
      │
      ▼
     defaultSpawn() → in-process child agent
```

---

## API Reference

### Factories

| Function | Returns | Description |
|----------|---------|-------------|
| `createAgentSpawner(config)` | `AgentSpawner` | Core spawner with per-spawn instance lifecycle |
| `createRoutingSpawnFn(config)` | `SpawnFn` | Wraps default + sandboxed spawn with manifest-based routing |

### Helpers (exported for testing)

| Function | Returns | Description |
|----------|---------|-------------|
| `mapManifestToDescriptor(manifest, name)` | `ExternalAgentDescriptor \| undefined` | Extracts CLI agent descriptor from manifest metadata |
| `mapSandboxConfigToProfile(config)` | `SandboxProfile` | Converts ManifestSandboxConfig → SandboxProfile (tier=sandbox, network=deny by default) |

### Types

| Type | Description |
|------|-------------|
| `AgentSpawnerConfig` | Adapter, cwd, env, max concurrency, max output bytes |
| `SpawnOptions` | Per-invocation model override, timeout, sandbox profile |
| `RoutingSpawnConfig` | Default SpawnFn + AgentSpawner for routing |
| `AgentSpawner` | `spawn()` + `dispose()` interface |

### Protocol Utilities (exported for advanced usage)

| Function | Description |
|----------|-------------|
| `buildStdioArgs(command, prompt, model)` | Build CLI args for stdio-mode agents |
| `buildAcpArgs(command, model)` | Build CLI args for ACP-mode agents |
| `buildAcpStdin(prompt)` | Build ACP JSON-RPC request body |
| `extractAcpOutput(stdout)` | Parse ACP JSON-RPC responses |
| `parseStdioOutput(result)` | Parse stdio exec result |

---

## Configuration

### AgentSpawnerConfig

```typescript
const spawner = createAgentSpawner({
  adapter: mySandboxAdapter,           // Required: SandboxAdapter (E2B, Daytona, OS)
  cwd: "/workspace",                   // Working dir inside sandbox
  env: { API_KEY: "..." },             // Injected env vars
  maxConcurrentDelegations: 2,         // Semaphore limit (default: 2)
  maxOutputBytes: 10 * 1024 * 1024,    // Output truncation cap (default: 10 MB)
});
```

### Manifest Metadata Keys

The routing spawn extracts these fields from `manifest.metadata`:

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `command` | `string` | Yes (for sandbox routing) | Executable command (e.g., "claude", "aider") |
| `transport` | `"cli" \| "mcp" \| "a2a"` | No (default: "cli") | Transport protocol |
| `protocol` | `"acp" \| "stdio"` | No (default: stdio) | Wire protocol for sandbox communication |

---

## Performance

- **Concurrency**: Semaphore-controlled — `maxConcurrentDelegations` (default 2) prevents resource exhaustion
- **Output capping**: Both exec-based paths (`maxOutputBytes`) and interactive path (byte counter + kill) enforce output limits
- **Instance lifecycle**: Per-spawn create/destroy avoids stale container accumulation
- **Streaming backpressure**: Interactive ACP uses `createLineReader` with 1 MB/line and 10 MB total caps

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Per-spawn instances | Fresh sandbox per `spawn()` | Isolation — compromised agent can't affect subsequent spawns |
| Routing at L3 | `createRoutingSpawnFn` wraps SpawnFn | Keeps L2 task-spawn agnostic; routing decision is composition concern |
| Manifest metadata for command | `metadata.command`, `metadata.protocol` | Avoids polluting AgentManifest with external-agent-specific fields |
| Network deny by default | `mapSandboxConfigToProfile` defaults `{ allow: false }` | Principle of least privilege for sandboxed agents |
| Interactive ACP preference | Uses `spawn()` when available, falls back to `exec()` | Streaming enables real-time ACP communication; batch is the fallback |

---

## Testing

```bash
# Run routing-spawn tests (21 tests, 100% coverage)
bun test packages/meta/agent-spawner/src/routing-spawn.test.ts

# Run spawner tests (requires full workspace link resolution)
bun test packages/meta/agent-spawner/src/spawner.test.ts
```

Coverage breakdown:
- `routing-spawn.ts`: 100% functions, 100% lines
- `spawner.ts`: Tested via mock adapters — per-spawn lifecycle, ACP/stdio dispatch, semaphore, dispose

---

## Related

- [docs/L3/sandbox-stack.md](./sandbox-stack.md) — Unified sandbox execution bundle
- [docs/L0u/sandbox-cloud-base.md](../L0u/sandbox-cloud-base.md) — Cloud instance utilities, line reader, shell escape
- `@koi/core` `SandboxProcessHandle` — L0 contract for interactive process spawning
- `@koi/core` `ManifestSandboxConfig` — L0 type for declarative sandbox configuration
- Issue #832 — refactor: replace TrustTier with capability-based sandbox policy model
