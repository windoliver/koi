# Brick Composition Algebra — Pipeline Composition

Koi's `compose_forge` tool merges same-kind bricks into a single composite. **Brick Composition Algebra** adds formal pipeline composition rules: typed ports, wiring validation, schema conflict detection, and provenance tracking — so composed bricks know where they came from and can be safely decomposed later.

---

## Why It Exists

Without composition algebra, `compose_forge` was a flat content concatenation:

```
Without Composition Algebra          With Composition Algebra
───────────────────────────          ───────────────────────
Silent schema overwrites             Schema conflicts detected and rejected
No record of source bricks           Typed composition metadata on every artifact
No pipeline length limit             10-brick cap prevents runaway composition
Duplicate bricks silently merge      Duplicate detection rejects immediately
No decomposition possible            sourceBricks + wires enable future decomposition
```

The composed brick is still flattened at forge-time (one sandbox call), but it records its pipeline structure in typed metadata for traceability.

---

## Core Concept: Pipeline Composition

A pipeline composes bricks sequentially: the output of brick A feeds into brick B.

```
  ┌───────────┐     ┌───────────┐     ┌───────────┐
  │  fetch     │────►│  parse    │────►│  validate  │
  │  (tool)    │     │  (tool)   │     │  (tool)    │
  └───────────┘     └───────────┘     └───────────┘
       in                                    out
       ▲                                      │
       └──── exposed ports of composed brick ─┘
```

The composed brick exposes the first brick's input and the last brick's output.

### Composition Metadata

Every composed artifact carries a `composition` field on `BrickArtifactBase`:

```typescript
{
  operator: "pipeline",
  sourceBricks: [brickId("sha256:fetch..."), brickId("sha256:parse..."), brickId("sha256:validate...")],
  wires: [
    { from: { brickId: "sha256:fetch...", port: "out" }, to: { brickId: "sha256:parse...", port: "in" } },
    { from: { brickId: "sha256:parse...", port: "out" }, to: { brickId: "sha256:validate...", port: "in" } },
  ],
  exposedPorts: [
    { name: "in", direction: "in", schema: { ... } },
    { name: "out", direction: "out", schema: { ... } },
  ],
}
```

Bricks without composition have `composition: undefined` — backward compatible.

---

## What It Enables

### Today (v1)

- **Schema conflict detection** — merging two tools where property `count` is `string` in one and `number` in the other now returns an error instead of silently picking the last one
- **Pipeline length cap** — max 10 bricks prevents combinatorial explosion in automated composition
- **Duplicate rejection** — `[A, A]` is caught immediately
- **Provenance tracking** — every composed brick records its `sourceBricks` in order, answering "what went into this brick?"
- **Storage round-trip validation** — `validateBrickArtifact` validates `composition` metadata when loading from disk/DB

### Future (unlocked by the typed metadata)

- **Decomposition** — break a composed brick back into its pipeline stages
- **Associativity verification** — prove `(A>>>B)>>>C ≡ A>>>(B>>>C)` for algebraic optimization
- **Visual pipeline rendering** — dashboards can render the brick's composition graph from `wires` and `exposedPorts`
- **Port-aware composition** — when port schemas are provided, validate that each consecutive pair's output satisfies the next brick's input requirements
- **Parallel operator** — extend `BrickComposition` union with `{ operator: "parallel" }` for fan-out/fan-in patterns
- **Conditional operator** — `{ operator: "conditional" }` for branching pipelines

---

## Architecture

### Layer Placement

```
L0  @koi/core         Types: BrickComposition, BrickPort, CompositionWire, CompositionCheck
                       Constant: MAX_PIPELINE_LENGTH = 10
                       Field: BrickArtifactBase.composition?: BrickComposition

L0u @koi/validation   Functions: detectSchemaConflicts, validatePortCompatibility,
                       validatePipeline, createPipelineComposition, validateCompositionFields

L2  @koi/forge         compose_forge handler: pipeline cap, dedup, conflict detection,
                       composition metadata attachment
```

### Key Types (L0)

| Type | Purpose |
|------|---------|
| `BrickComposition` | Discriminated union on `operator` (currently only `"pipeline"`) |
| `PipelineComposition` | Pipeline-specific: `sourceBricks`, `wires`, `exposedPorts` |
| `BrickPort` | Typed I/O endpoint: `name`, `direction`, `schema` (JSON Schema) |
| `CompositionWire` | Connection between two brick ports |
| `CompositionCheck` | Validation result: `{ valid: true }` or `{ valid: false, errors }` |
| `CompositionError` | Error detail: `kind` + `message` + optional `context` |
| `MAX_PIPELINE_LENGTH` | Constant `10` — pipeline brick cap |

### Key Functions (L0u)

| Function | Purpose |
|----------|---------|
| `detectSchemaConflicts(schemas)` | Find property type mismatches across JSON Schemas |
| `validatePortCompatibility(output, input)` | Check output port satisfies input port requirements |
| `validatePipeline(brickIds, ports?)` | Full pipeline validation: cap, dupes, port compat |
| `createPipelineComposition(brickIds, ports?)` | Build `PipelineComposition` metadata |
| `validateCompositionFields(data, source)` | Storage round-trip validation for `composition` field |

---

## Usage Example

### Composing Two Tools

```typescript
// Agent calls compose_forge tool
const result = await composeForgeTool.execute({
  name: "fetch-and-parse",
  description: "Fetches a URL and parses the JSON response",
  brickIds: ["sha256:abc...", "sha256:def..."],
  tags: ["composite", "http"],
});

// Result artifact includes:
// - Merged implementation (both tool bodies)
// - Union of inputSchema properties (with conflict detection)
// - composition: { operator: "pipeline", sourceBricks: [...], ... }
```

### Validation in L0u

```typescript
import { validatePipeline, detectSchemaConflicts } from "@koi/validation";

// Validate before composing
const check = validatePipeline(brickIds);
if (!check.valid) {
  // check.errors: readonly CompositionError[]
  // Each has: kind ("too_many_bricks" | "duplicate_brick" | ...), message, context
}

// Detect schema conflicts
const schemas = bricks.map(b => b.inputSchema);
const conflicts = detectSchemaConflicts(schemas);
if (!conflicts.valid) {
  // conflicts.errors describes which properties have type mismatches
}
```

---

## Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Brick-level ports (not tool-level) | Composition is about bricks — the universal artifact |
| 2 | Structural schema checking | No heavy deps; property `type` field comparison is sub-ms |
| 3 | Pipeline only for v1 | Simplest useful operator; parallel/conditional come later |
| 4 | Flatten at forge-time | One sandbox call; metadata-only provenance avoids runtime overhead |
| 5 | 10-brick pipeline cap | Prevents combinatorial explosion; can be raised later |
| 6 | Reject on conflict (not merge) | Fail-safe: silent schema overwrites caused real bugs |
| 7 | Composition in hash automatically | `BrickArtifactBase.composition` feeds into content-addressed ID |
