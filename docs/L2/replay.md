# @koi/replay — Deterministic Cassette Replay

Records model stream output to versioned cassette files and replays them in tests with no live LLM or network. Foundation for golden-trace regression testing across the L2 surface.

---

## Why It Exists

Koi already recorded cassettes for runtime golden queries in `@koi/runtime` scripts. Those cassettes were one-off script artifacts — not a first-class, importable package. Promoting replay to L0u unlocks:

- Per-package cassette use (any L2 package can import `@koi/replay` without pulling `@koi/runtime`)
- User-side testing: downstream agent authors can use `createReplayContext` in their own test suites
- CI replay across the full L2 surface without API keys or network

---

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│  @koi/replay  (L0u)                                        │
│                                                           │
│  types.ts                ← Cassette + schemaVersion       │
│  load-cassette.ts        ← load + validate + cache        │
│  create-replay-adapter.ts ← EngineAdapter from chunks     │
│  create-replay-context.ts ← composition factory           │
│  create-cassette-recorder.ts ← wrap live adapter to record│
│  cassette-registry.ts    ← typed name → path index        │
│  index.ts                ← public API                     │
└───────────────────────────────────────────────────────────┘
Dependencies: @koi/core, @koi/query-engine
```

Layer: **L0u** — importable from L1, L2, and L3. Zero business logic.

---

## Cassette Format

```jsonc
{
  "schemaVersion": "cassette-v1",   // required — guards v1 parser from v2 cassettes
  "name": "simple-text",            // human-readable label
  "model": "google/gemini-2.0-flash-001",
  "recordedAt": 1775692710024,      // Unix ms — informational only
  "chunks": [                       // ModelChunk[] in emission order
    { "kind": "text_delta", "delta": "4" },
    { "kind": "usage", "inputTokens": 13, "outputTokens": 2 },
    { "kind": "done", "response": { "content": "4\n", "model": "..." } }
  ]
}
```

**Volatile fields stripped at record time** — `response.responseId` and `response.metadata` (which contains `promptPrefixFingerprint`) differ on every recording run. Stripping them prevents false diffs in diff mode.

---

## Public API

### `loadCassette(path): Promise<Cassette>`

Loads and validates a cassette from disk. Results are cached — repeated calls for the same path return the same object reference. Call `clearCassetteCache()` between test files if needed.

```typescript
import { loadCassette } from "@koi/replay";

const cassette = await loadCassette("fixtures/simple-text.cassette.json");
// cassette.schemaVersion === "cassette-v1"
// cassette.chunks: readonly ModelChunk[]
```

Fails fast with a clear error for:
- Missing file
- Missing or unknown `schemaVersion`
- Malformed chunks (validated via `isModelChunk` from `@koi/core`)

### `createReplayAdapter(chunks, timeoutMs?): EngineAdapter`

Creates an `EngineAdapter` that replays a `ModelChunk[]` sequence. Zero API calls. Default timeout: 5 seconds.

**Stateless across calls** — each `stream()` invocation replays from chunk 0.

```typescript
import { createReplayAdapter, loadCassette } from "@koi/replay";

const cassette = await loadCassette("fixtures/tool-use.cassette.json");
const adapter = createReplayAdapter(cassette.chunks);
// Use adapter exactly like a live EngineAdapter
```

### `createReplayContext(path, timeoutMs?): Promise<ReplayContext>`

Preferred entry point for tests. Loads cassette + creates adapter in one call. Returns `{ adapter, cassette }` — explicit, composable.

```typescript
import { createReplayContext } from "@koi/replay";

const { adapter, cassette } = await createReplayContext("fixtures/tool-use.cassette.json");
expect(cassette.model).toBe("google/gemini-2.0-flash-001");

const koi = createKoi({ adapter, providers: [...] });
```

### `createCassetteRecorder(wrapped): CassetteRecorderHandle`

Wraps a live `EngineAdapter` to record its output. Use in recording scripts.

```typescript
import { createCassetteRecorder } from "@koi/replay";

const { adapter, flush } = createCassetteRecorder(liveAdapter);
await runTurn({ adapter, ... }); // live run recorded transparently

const cassette = flush("my-query", "google/gemini-2.0-flash-001");
await Bun.write("fixtures/my-query.cassette.json", JSON.stringify(cassette, null, 2));
```

`flush()` automatically strips volatile fields (`responseId`, `metadata`) before returning.

### `createRegistry(baseDir, entries): CassetteRegistry`

Creates a typed `name → path` map for a fixture directory. Import from registry instead of constructing paths by string — renames become compile errors, not silent test failures.

```typescript
import { createRegistry } from "@koi/replay";

const CASSETTES = createRegistry(`${import.meta.dirname}/../fixtures`, {
  "simple-text": "simple-text.cassette.json",
  "tool-use":    "tool-use.cassette.json",
});

const cassette = await loadCassette(CASSETTES["simple-text"]);
```

---

## Cassette Versioning

`schemaVersion: "cassette-v1"` is required. `loadCassette` rejects:
- Cassettes with no `schemaVersion` field (pre-migration format)
- Cassettes with an unknown version string

When the format gains new top-level fields (e.g., HTTP recordings in v2), bump to `"cassette-v2"`. The v1 parser will reject v2 cassettes with a clear error rather than silently loading a partial cassette.

---

## Migration

To migrate pre-v1 cassettes (missing `schemaVersion`, volatile fields present):

```bash
bun run scripts/migrate-cassettes.ts [fixtures-dir]
# Default: packages/meta/runtime/fixtures
```

The script is idempotent and self-verifying — it validates each output before writing.

---

## HTTP Recording (v2 — not yet implemented)

Phase 1 records model stream output only (`ModelChunk[]`). A future `cassette-v2` will extend the format to record `fetch` calls from tools (request URL, headers, response body). This allows full hermetic replay of agent runs that call external APIs.

Tracked as a follow-up to issue #1629.

---

## Testing Patterns

### Basic replay test

```typescript
import { createReplayContext } from "@koi/replay";
import { describe, expect, test } from "bun:test";

describe("my feature", () => {
  test("handles tool call", async () => {
    const { adapter, cassette } = await createReplayContext(
      `${import.meta.dirname}/fixtures/tool-use.cassette.json`
    );
    // cassette is available for pre-assertions
    expect(cassette.chunks.some((c) => c.kind === "tool_call_start")).toBe(true);

    const koi = createKoi({ adapter, providers: [myToolProvider] });
    // ... run and assert
  });
});
```

### Round-trip test

```typescript
import { CASSETTE_SCHEMA_VERSION, loadCassette } from "@koi/replay";
import type { Cassette } from "@koi/replay";

// Write a synthetic cassette, load it back, replay it
const cassette: Cassette = {
  schemaVersion: CASSETTE_SCHEMA_VERSION,
  name: "round-trip",
  model: "test-model",
  recordedAt: Date.now(),
  chunks: [
    { kind: "text_delta", delta: "hello" },
    { kind: "done", response: { content: "hello", model: "test-model" } },
  ],
};
await Bun.write(tmpPath, JSON.stringify(cassette, null, 2));
const loaded = await loadCassette(tmpPath);
// loaded is validated and cached
```

---

## Re-recording Cassettes

```bash
OPENROUTER_API_KEY=sk-... bun run packages/meta/runtime/scripts/record-cassettes.ts
```

Re-record when:
- A new L2 package adds tools or middleware
- Tool behavior changes (args, output format)
- Model adapter response format changes

After recording, run `scripts/migrate-cassettes.ts` to ensure all cassettes are in `cassette-v1` format with volatile fields stripped.
