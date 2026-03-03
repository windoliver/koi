# Koi Runtime (`createKoi`)

Factory function that assembles an agent entity and returns a streaming runtime.

**Layer**: L1 (`@koi/engine`)
**File**: `packages/engine/src/koi.ts`
**See also**: [koi-async-generator.md](./koi-async-generator.md) for internal generator architecture

---

## Overview

`createKoi()` is the primary entry point for running a Koi agent. It takes a
manifest, an engine adapter, and optional configuration, then produces a
`KoiRuntime` whose `run()` method returns an `AsyncIterable<EngineEvent>`.

```
createKoi(options) → KoiRuntime
  ├─ agent: AgentEntity       (assembled from manifest + providers)
  ├─ conflicts: AssemblyConflict[]
  ├─ run(input) → AsyncIterable<EngineEvent>
  └─ dispose() → Promise<void>
```

## Assembly Pipeline

```
 manifest + providers
       │
       ▼
 ┌─────────────────┐
 │ AgentEntity.     │  1. Assemble entity from manifest + component providers
 │ assemble()       │     (governance provider is always included)
 └────────┬────────┘
          ▼
 ┌─────────────────┐
 │ composeExtensions│  2. Compose kernel extensions (governance, guards,
 │ ()               │     brick-requires, user extensions)
 └────────┬────────┘
          ▼
 ┌─────────────────┐
 │ validateAssembly │  3. Run assembly validators — fail if any error-severity
 │ ()               │     diagnostic is produced
 └────────┬────────┘
          ▼
 ┌─────────────────┐
 │ sortByPriority() │  4. Compose middleware chain: guard middleware (low
 │                   │     priority numbers) + user middleware, sorted ascending
 └────────┬────────┘
          ▼
       KoiRuntime
```

## Runtime Lifecycle

When `run()` is called, an async generator (`streamEvents()`) drives the
state machine:

```
 created ──start──▶ running ──complete──▶ terminated
                        │                     ▲
                        │                     │
                        └──error──────────────┘
```

### Session Initialization

1. Transition agent to `running`
2. Fire `onSessionStart` hooks on all middleware
3. If adapter exposes `terminals` (cooperating mode):
   - Create terminal handlers (model, tool, stream)
   - Compose middleware chains around terminals
   - Build `callHandlers` with dynamic tools getter
   - Wire forge runtime (descriptors + watch subscription)
4. Start the adapter's event stream

### Event Loop

The generator yields events in a linear flow:

```
async function* streamEvents() {
  try {
    // session initialization
    while (!done) {
      // deferred forge refresh
      yield turn_start
      for await (event of adapter) {
        yield event
        if (done) break
      }
    }
  } catch (error) {
    // error recovery → done event
  } finally {
    // single cleanup site
  }
}
```

### Cleanup

All cleanup converges in the generator's `finally` block — a single site
replaces the 6 separate cleanup sites in the original manual iterator:

| Exit path | Trigger | Cleanup runs? |
|-----------|---------|---------------|
| Normal completion | `done` event from adapter | Yes |
| Consumer break | `for await` loop exits early | Yes |
| Consumer `.return()` | Explicit iterator return | Yes |
| Abort signal | `AbortSignal` fires | Yes |
| Unhandled error | Throw propagates out | Yes |

### Error Classification

```
error instanceof KoiRuntimeError?
  ├─ yes → convert to done event (stopReason: "error" or "max_turns")
  │        fire onSessionEnd hooks (warn on hook failure)
  │        yield done event
  │
  └─ no  → transition agent to error state
           fire onSessionEnd hooks (warn on hook failure)
           re-throw the original error
```

## Forge Integration

When `options.forge` is provided, forged capabilities are resolved live:

| Capability | Resolution | Refresh |
|------------|-----------|---------|
| Tools | At call time (forge-first, entity fallback) | Immediate |
| Tool descriptors | Entity + forged, deduped via `createDedupedToolsAccessor()` | Turn boundary (deferred) |
| Middleware | Re-composed from forge.middleware() | Turn boundary (deferred) |

The deferred refresh pattern ensures consumers can inject tools/middleware
between turns. A `watch` subscription enables push notifications for
mid-session tool visibility changes.

## Cooperating vs Non-Cooperating Adapters

| Mode | `adapter.terminals` | `callHandlers` | Middleware chains |
|------|---------------------|-----------------|-------------------|
| Cooperating | Present | Injected into input | Composed around terminals |
| Non-cooperating | Absent | Not provided | Not composed (adapter handles internally) |

Cooperating adapters delegate model/tool calls back to L1 through
`callHandlers`, allowing middleware to intercept every call. Non-cooperating
adapters handle everything internally — L1 only observes the event stream.

## Configuration

```typescript
const runtime = await createKoi({
  // Required
  manifest: AgentManifest,
  adapter: EngineAdapter,

  // Optional — middleware and providers
  middleware: KoiMiddleware[],
  providers: ComponentProvider[],
  extensions: KernelExtension[],

  // Optional — guards
  limits: Partial<IterationLimits>,
  loopDetection: Partial<LoopDetectionConfig> | false,
  spawn: Partial<SpawnPolicy>,
  governance: Partial<GovernanceConfig>,

  // Optional — forge
  forge: ForgeRuntime,

  // Optional — session context
  approvalHandler: ApprovalHandler,
  sendStatus: (status: ChannelStatus) => Promise<void>,
  userId: string,
  channelId: string,
  parentPid: ProcessId,
});
```
