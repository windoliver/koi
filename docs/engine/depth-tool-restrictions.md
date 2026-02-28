# Depth-Based Tool Restrictions

Progressive capability narrowing for spawned agents.

**Layer**: L1 runtime (`@koi/engine`)
**Issue**: #172

---

## Overview

Agents spawned at deeper depths can have their tool access restricted.
A `DepthToolRule` denies a specific tool at `agentDepth >= minDepth`.
Once denied, the tool stays denied at all deeper depths — capabilities
only narrow with depth (object-capability endowment rule).

```
Depth 0 (root):  exec ✅  fs:write ✅  browser ✅   ← full trust
Depth 1:         exec 🚫  fs:write ✅  browser ✅   ← no code execution
Depth 2:         exec 🚫  fs:write 🚫  browser 🚫   ← read-only sandbox
```

## Key design decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Model | Denylist (`{ toolId, minDepth }`) | Simpler than allowlist; additive rules compose naturally |
| Where type lives | L1 (`@koi/engine/types.ts`) | Config for the spawn guard, not an L0 contract |
| Enforcement point | `createSpawnGuard.wrapToolCall` | Applies to ALL tool calls, before spawn-tool checks |
| Computation | Pre-computed `Set<string>` at construction | O(1) per tool call; no per-call allocation |
| Error type | `PERMISSION` (not retryable) | Structural denial — won't self-resolve |

---

## Architecture

### How it fits in the middleware chain

```
createKoi(options)
  │
  ├─ options.spawn.toolRestrictions: DepthToolRule[]
  │
  ▼
createDefaultGuardExtension({ spawn: ... })
  │
  ▼
createSpawnGuard({ policy, agentDepth })
  │
  ├─ computeDeniedTools(rules, agentDepth) → Set<string>  (once, at construction)
  │
  ▼
wrapToolCall(ctx, request, next)
  │
  ├─ Step 0: if deniedTools.has(request.toolId) → throw PERMISSION
  ├─ Step 1: if !spawnToolIds.has(toolId) → return next(request)  (hot path)
  ├─ Step 2: depth check (spawn tools only)
  ├─ Step 3: governance check
  ├─ Step 4: fan-out check
  └─ Step 5: execute
```

The restriction check runs **before** the spawn-tool early return, so it
applies to every tool call, not just spawn tools.

### Data flow in the process tree

```
┌──────────────────────────────────────┐
│  SpawnPolicy.toolRestrictions:       │
│    { toolId: "exec",    minDepth: 1 }│
│    { toolId: "fs:write", minDepth: 2 }│
│    { toolId: "browser",  minDepth: 2 }│
└──────────────────────────────────────┘
                    │
     createKoi passes policy to spawn guard
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
   Depth 0       Depth 1      Depth 2
   denied: {}    denied:      denied:
                 {exec}       {exec, fs:write, browser}
```

Each agent gets its own spawn guard instance with the denied set
pre-computed for its depth. The policy is threaded through
`spawnChildAgent()` → `createKoi({ spawn: ... })`.

---

## API

### `DepthToolRule` (interface)

```typescript
interface DepthToolRule {
  /** The tool ID to restrict. */
  readonly toolId: string;
  /** Minimum agent depth at which this tool is denied (inclusive). */
  readonly minDepth: number;
}
```

### `SpawnPolicy.toolRestrictions` (field)

```typescript
interface SpawnPolicy {
  // ... existing fields ...

  /**
   * Depth-based tool restrictions. Each rule denies a specific tool at
   * agents with depth >= minDepth. Rules are additive (union of denials).
   * Applies to ALL tool calls, not just spawn tools.
   * Defaults to undefined (no restrictions).
   */
  readonly toolRestrictions?: readonly DepthToolRule[];
}
```

### Usage with `createKoi`

```typescript
import { createKoi } from "@koi/engine";

const runtime = await createKoi({
  manifest: { name: "Orchestrator", version: "1.0.0" },
  adapter,
  spawn: {
    maxDepth: 3,
    maxFanOut: 5,
    maxTotalProcesses: 20,
    toolRestrictions: [
      { toolId: "exec",     minDepth: 1 }, // no code execution below root
      { toolId: "fs:write", minDepth: 2 }, // no file writes below depth 1
      { toolId: "browser",  minDepth: 2 }, // no browsing below depth 1
    ],
  },
});
```

### Error shape

When a restricted tool is called, the spawn guard throws:

```typescript
KoiRuntimeError {
  code: "PERMISSION",
  message: 'Tool "exec" is not allowed at depth 1',
  context: { toolId: "exec", agentDepth: 1 },
}
```

The Pi adapter surfaces this error to the LLM as a tool result,
giving the model a chance to adapt its approach.

---

## Relationship to forge governance

The `@koi/forge` package (`governance.ts`) has its own depth-based
allowlist for the 7 primordial forge tools. That system is separate:

| Aspect | Forge governance | Tool restrictions (this feature) |
|--------|-----------------|----------------------------------|
| Model | Allowlist per depth tier | Denylist with `minDepth` threshold |
| Scope | 7 forge tools only | Any tool ID |
| Layer | L2 (`@koi/forge`) | L1 (`@koi/engine`) |
| Enforcement | `ForgeConfig.maxForgeDepth` | `SpawnPolicy.toolRestrictions` |

Both systems are complementary. Forge governance controls what agents
can *create*; tool restrictions control what agents can *use*.

---

## What this does NOT do (by design)

- **No L0 changes** — `DepthToolRule` is L1 config, not a core contract
- **No forge migration** — forge keeps its allowlist pattern
- **No `GovernanceController` integration** — a `tool_restriction` governance
  variable is future work
- **No validation of `minDepth`** — negative values work correctly (always
  denied), empty arrays produce no overhead
- **No `describeCapabilities` enhancement** — the guard returns `undefined`
  today; advertising denied tools to the LLM is future work
