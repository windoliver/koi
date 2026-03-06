# Delivery Policy

Controls how spawned child agent results flow back to the parent agent.
Three modes — streaming (inline), deferred (inbox), on-demand (report store).

**Layer**: L0 types (`@koi/core`) + L1 logic (`@koi/engine`)
**Issue**: #848 (Gap 2)

---

## Why It Exists

By default every child agent's events stream inline to the parent, blocking its
context window. When a parent spawns five research agents, their events interleave
and flood the parent's turn — forcing the parent to process all of them before
continuing its own work.

```
                Before                              After
                ──────                              ─────
5 child agents: all events inline to parent         configurable per-child
Parent context: flooded with child events           only receives what it asks for
Fan-out:        impractical at scale                quiet fan-out via deferred/on_demand
Async tasks:    not possible                        on_demand enables fire-and-forget
```

---

## Three Modes

### `streaming` (default)

Events flow inline — the current behavior with zero overhead. The parent iterates
the child's `runtime.run()` directly. No wrapper, no buffering.

```yaml
# manifest.yaml
delivery:
  kind: streaming
```

### `deferred`

The child stream is consumed in the background. When the child finishes, its final
text output is pushed as an `InboxItem` to the parent's inbox. The parent reads it
on its next turn via the inbox subsystem.

```yaml
delivery:
  kind: deferred
  inboxMode: collect   # or "followup" or "steer" — defaults to "collect"
```

**Behavior:**
- Child events are consumed and discarded (only the `done` event's output is kept)
- Final output text is extracted and pushed to `parentInbox.push()`
- If the inbox is full, a warning is logged but no error is thrown
- Memory: O(1) — only the final output is buffered

### `on_demand`

The child stream is consumed in the background. When the child finishes, a
`RunReport` is written to the `ReportStore`. The parent can pull the report
whenever it's ready.

```yaml
delivery:
  kind: on_demand
```

**Behavior:**
- Child events are consumed and discarded (only the `done` event's output is kept)
- A `RunReport` is built with summary, duration, cost metrics, and written via `store.put()`
- The `put()` call is awaited — store failures surface as errors
- Memory: O(1) — only the final output is buffered

---

## Configuration

Delivery policy can be set at two levels (resolved in priority order):

1. **Spawn option** — `SpawnRequest.delivery` or `SpawnChildOptions.delivery`
2. **Manifest** — `AgentManifest.delivery`
3. **Default** — `streaming` (zero overhead)

```typescript
// Spawn-time override (highest priority)
await spawn({
  agentName: "researcher",
  description: "analyze the data",
  delivery: { kind: "deferred", inboxMode: "followup" },
});

// Or set in manifest (used when spawn doesn't specify)
// manifest.yaml
delivery:
  kind: on_demand
```

---

## API Surface

### L0 Types (`@koi/core`)

```typescript
type DeliveryPolicy =
  | { readonly kind: "streaming" }
  | { readonly kind: "deferred"; readonly inboxMode?: InboxMode | undefined }
  | { readonly kind: "on_demand" };

const DEFAULT_DELIVERY_POLICY: DeliveryPolicy; // { kind: "streaming" }
function isDeliveryPolicy(value: unknown): value is DeliveryPolicy;
```

### L1 Functions (`@koi/engine`)

```typescript
// Resolve: spawn option > manifest > streaming default
function resolveDeliveryPolicy(
  spawnDelivery: DeliveryPolicy | undefined,
  manifestDelivery: DeliveryPolicy | undefined,
): DeliveryPolicy;

// Apply: wraps SpawnChildResult with delivery-aware consumption
function applyDeliveryPolicy(config: ApplyDeliveryPolicyConfig): DeliveryHandle;

interface DeliveryHandle {
  readonly spawnResult: SpawnChildResult;
  readonly runChild?: (input: EngineInput) => Promise<void>; // undefined for streaming
}
```

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Stream error | Rethrown with `cause` chain |
| No `done` event | `KoiRuntimeError("INTERNAL", ...)` |
| Inbox full (deferred) | `console.warn`, no throw |
| `ReportStore.put()` failure | Rethrown with `cause` chain |

---

## What This Enables

- **Quiet fan-out**: Spawn 5+ agents without flooding the parent's context
- **Async task dispatch**: Fire-and-forget with `on_demand`, pull results later
- **Inbox-driven workflows**: `deferred` integrates with the existing inbox subsystem
- **Zero-overhead default**: `streaming` mode adds no wrapper — same as before
- **Manifest-driven**: Set delivery policy declaratively in YAML
- **Per-spawn override**: Different delivery modes for different children in the same turn
