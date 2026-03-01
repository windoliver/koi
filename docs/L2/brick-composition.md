# Brick Composition Algebra

`"composite"` is the 6th `BrickKind`. It represents an ordered pipeline of
bricks (A->B->C) where each step's output feeds into the next step's input.
Typed I/O ports ensure structural schema compatibility at composition time,
and a content-addressed pipeline ID preserves step order.

---

## Why it exists

Individual bricks (tools, skills, agents) are atomic capabilities. Real
workflows often require chaining capabilities: fetch data, then parse it,
then validate it. Before composition algebra, agents had to glue these steps
together manually in every session. `compose_forge` makes pipelines
first-class, reusable, and validated.

```
  Tool A             Tool B             Tool C
  (fetch)            (parse)            (validate)
  ┌──────┐          ┌──────┐          ┌──────┐
  │input ●──object──●input ●──object──●input ●
  │      │          │      │          │      │
  │output●──object──●output●──object──●output●
  └──────┘          └──────┘          └──────┘

  CompositeArtifact {
    kind: "composite",
    steps: [A, B, C],
    exposedInput: A.inputPort,
    exposedOutput: C.outputPort,
    outputKind: "tool"    // last step's kind
  }
```

---

## Layer placement

| Layer | What lives there | Package |
|-------|-----------------|---------|
| L0 | `BrickPort`, `PipelineStep`, `CompositeArtifact`, `MAX_PIPELINE_STEPS` | `@koi/core` |
| L0u | `computePipelineBrickId()` | `@koi/hash` |
| L0u | `checkSchemaCompatibility()`, `validatePipeline()` | `@koi/validation` |
| L2 | `compose_forge` tool (handler, port extraction) | `@koi/forge` |

No layer violations: L0 has zero imports, L0u imports only from L0/peer L0u,
L2 imports only from L0 and L0u.

---

## Core types (L0)

### BrickPort

A typed I/O port descriptor using JSON Schema:

```typescript
interface BrickPort {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
}
```

### PipelineStep

Links a brick to its I/O ports in the pipeline:

```typescript
interface PipelineStep {
  readonly brickId: BrickId;
  readonly inputPort: BrickPort;
  readonly outputPort: BrickPort;
}
```

### CompositeArtifact

The 6th variant of the `BrickArtifact` discriminated union:

```typescript
interface CompositeArtifact extends BrickArtifactBase {
  readonly kind: "composite";
  readonly steps: readonly PipelineStep[];
  readonly exposedInput: BrickPort;    // first step's input
  readonly exposedOutput: BrickPort;   // last step's output
  readonly outputKind: BrickKind;      // for ECS component resolution
}
```

### MAX_PIPELINE_STEPS

Hard limit of 20 steps per pipeline to bound validation cost and prevent
accidental runaway composition.

---

## Schema compatibility

`checkSchemaCompatibility(producer, consumer)` performs structural comparison
of JSON Schema objects (~50 LOC, zero dependencies):

- **Type match**: `producer.type` must equal `consumer.type` (when both set)
- **Required subset**: consumer's `required` fields must exist in producer's `properties`
- **Recursive properties**: nested types compared up to depth 10 (configurable)
- **Open world**: extra properties in the producer are allowed

Returns `{ compatible: boolean, errors: readonly string[] }`.

---

## Pipeline validation

`validatePipeline(steps)` checks:

1. At least 2 steps
2. At most `MAX_PIPELINE_STEPS` (20) steps
3. For each consecutive pair `(steps[i], steps[i+1])`, the output port schema
   of step `i` is compatible with the input port schema of step `i+1`
4. Reports **all** errors (not just the first)

---

## Pipeline identity

`computePipelineBrickId(stepIds, outputKind, files?)` produces a
content-addressed `sha256:` ID that is:

- **Order-preserving**: A->B differs from B->A (unlike `computeCompositeBrickId`
  which sorts children)
- **Deterministic**: same steps in same order always produce the same ID
- **Kind-aware**: different `outputKind` values produce different IDs

---

## Port extraction

When composing, each brick kind maps to default I/O ports:

| Kind | Input port schema | Output port schema |
|------|------------------|--------------------|
| `tool` | `brick.inputSchema` | `{ type: "object" }` |
| `skill` | `{ type: "string" }` | `{ type: "string" }` |
| `agent` | `{ type: "object" }` | `{ type: "object" }` |
| `middleware` | `{ type: "object" }` | `{ type: "object" }` |
| `channel` | `{ type: "object" }` | `{ type: "object" }` |
| `composite` | `brick.exposedInput` | `brick.exposedOutput` |

---

## ECS resolution

Composite bricks use `outputKind` (the last step's kind) to determine:

- **Trust tier**: `MIN_TRUST_BY_KIND[outputKind]` (composite itself is `"sandbox"`)
- **Component type**: delegated to the last step's resolution

`mapBrickToComponent` returns `undefined` for composites — the caller resolves
via the output step.

---

## compose_forge tool

The `compose_forge` tool builds pipelines:

```
Input:  { name, description, brickIds: [id1, id2, ...], tags?, files? }
Output: ForgeResult { id, kind: "composite", ... }
```

### Pipeline

1. Parse and validate input (name, description, brickIds)
2. Validate `2 <= brickIds.length <= MAX_PIPELINE_STEPS`
3. Load all bricks in parallel (`Promise.all`)
4. Extract I/O ports from each brick
5. Validate pipeline schema compatibility
6. Compute `outputKind` from last brick
7. Compute content-addressed pipeline ID
8. Dedup check (return early if ID exists)
9. Build `CompositeArtifact` with provenance
10. Save to `ForgeStore`
11. Return `ForgeResult`

### Dedup

If a composite with the same pipeline ID already exists in the store,
`compose_forge` returns immediately with `forgesConsumed: 0`. No re-save.

---

## Topology: linear only (v2)

This implementation supports **linear pipelines** (A->B->C) only. Full DAG
topology (fan-out, fan-in, conditional branching) is deferred to a future
version. The `PipelineStep` type is designed to be forward-compatible with
DAG extensions (e.g., adding optional `dependsOn: readonly BrickId[]`).

### Execution model

Sequential execution only. Steps run one at a time in order. Parallel
step execution within a pipeline is a future optimization that requires
DAG topology support.

### Tradeoff

Linear pipelines are simpler to validate, debug, and reason about. They
cover the most common composition pattern (data transformation chains).
DAG support adds complexity (cycle detection, fan-out/fan-in semantics,
partial failure handling) that is not needed until agents demonstrate
demand for it.

---

## Example

```typescript
import { createComposeForge } from "@koi/forge";

// Assume deps.store has two tool bricks: "fetch-url" and "parse-json"
const composeTool = createComposeForge(deps);

const result = await composeTool.execute({
  name: "fetch-and-parse",
  description: "Fetches a URL then parses the response as JSON",
  brickIds: [fetchToolId, parseToolId],
  tags: ["http", "json"],
});

if (result.ok) {
  // result.value.id = "sha256:..." (order-preserving pipeline hash)
  // result.value.kind = "composite"
  // Stored as CompositeArtifact with typed ports and provenance
}
```
