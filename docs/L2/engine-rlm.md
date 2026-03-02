# @koi/engine-rlm — Recursive Language Model Engine Adapter

Virtualizes unbounded input outside the context window and gives the model tools to programmatically examine, chunk, and recursively sub-query it. Inspired by DSPy's RLM research on processing inputs that exceed a single model's context capacity.

---

## Why It Exists

LLM context windows are finite. When an agent receives a 50 MB JSON file, a 200-page document, or a full codebase, it cannot load the content into context and reason over it directly. Without a solution, the agent either truncates (losing information) or fails.

`@koi/engine-rlm` solves this by:

1. **Virtualizing input** — the full text lives outside context; the model accesses it through tools (`examine`, `chunk`, `input_info`)
2. **Autonomous exploration** — the model decides what to read, in what order, using a REPL loop
3. **Recursive delegation** — for deeply nested or multi-section inputs, the model can spawn child RLM agents via `rlm_query`
4. **Batched sub-queries** — `llm_query_batched` enables parallel sub-calls with concurrency control

---

## Two Integration Modes

### 1. As an Engine (standalone agent loop)

Use `createRlmAdapter()` when RLM **is** the agent — it processes one large input per session.

```typescript
import { createRlmAdapter } from "@koi/engine-rlm";

const adapter = createRlmAdapter({
  modelCall: myModelHandler,
  maxIterations: 30,
  contextWindowTokens: 128_000,
});

for await (const event of adapter.stream({ kind: "text", text: hugeInput })) {
  // Handle events: turn_start, tool_call_start/end, text_delta, done
}
```

### 2. As a Tool (invokable by any agent)

Use `createRlmTool()` when a parent agent (Pi, loop, etc.) needs to **occasionally** process large inputs alongside other tools. This is the more common integration pattern.

```typescript
import { createRlmTool } from "@koi/engine-rlm";

const rlmTool = createRlmTool({
  modelCall: myModelHandler,
  contextWindowTokens: 128_000,
});

// Add to any agent's toolbox
const tools = [rlmTool, searchTool, fileTool];
```

The calling agent sees `rlm_process` in its tool list and invokes it when it encounters input too large to fit in context:

```
rlm_process({ input: "...50MB of JSON...", question: "List all users with admin role" })
→ "Found 12 admin users: alice, bob, ..."
```

**Key design insight** (from DSPy RLM): the tool description primes the calling agent with explicit guidance on _when_ and _how_ to use it — metadata upfront, format support, and examples of good vs. bad questions.

---

## Architecture

`@koi/engine-rlm` is an **L2 feature package** — depends only on L0 (`@koi/core`) and L0u (`@koi/resolve`). Zero external dependencies.

```
┌─────────────────────────────────────────────────────────┐
│  @koi/engine-rlm  (L2)                                 │
│                                                         │
│  adapter.ts       ← createRlmAdapter (engine factory)  │
│  tool.ts          ← createRlmTool (tool wrapper)       │
│  tools.ts         ← 7 internal RLM tools               │
│  input-store.ts   ← virtualized input storage           │
│  token-tracker.ts ← context window budget tracking      │
│  compaction.ts    ← message history compaction           │
│  semaphore.ts     ← concurrency control for batched ops │
│  types.ts         ← RlmConfig, InputMetadata, etc.      │
│  descriptor.ts    ← BrickDescriptor for manifest        │
└──────────────┬──────────────────────────────────────────┘
               │ imports
               ▼
        @koi/core (L0)  +  @koi/resolve (L0u)
```

### Internal Tools (given to the sub-agent)

| Tool | Purpose |
|------|---------|
| `input_info` | Returns metadata: format, size, chunks, structure hints, preview |
| `examine` | Reads a byte range from the virtualized input (max 50K chars) |
| `chunk` | Lists chunk descriptors (metadata only, not content) |
| `llm_query` | Makes a single sub-call to the model |
| `llm_query_batched` | Parallel sub-calls with semaphore-controlled concurrency |
| `rlm_query` | Spawns a child RLM agent for recursive processing |
| `FINAL` | Submits the final answer and exits the REPL loop |

---

## Configuration

### `RlmConfig` (for `createRlmAdapter`)

| Field | Default | Description |
|-------|---------|-------------|
| `modelCall` | required | Raw model call terminal (LLM function) |
| `modelStream` | — | Optional streaming model call |
| `rootModel` | — | Model ID for root-level calls |
| `subCallModel` | — | Model ID for sub-calls (llm_query, compaction) |
| `maxIterations` | 30 | Max REPL loop iterations before forced stop |
| `maxInputBytes` | 100 MB | Max input size in bytes |
| `chunkSize` | 4,000 | Characters per chunk |
| `contextWindowTokens` | 100,000 | Total context window for budget tracking |
| `maxConcurrency` | 5 | Max parallel calls in `llm_query_batched` |
| `spawnRlmChild` | — | Callback to spawn child RLM agent |

### `RlmToolConfig` (for `createRlmTool`)

Same as `RlmConfig` minus adapter-only fields (`modelStream`, `toolCall`, `previewLength`, `compactionThreshold`, `depth`). These are irrelevant when RLM runs as a tool.

---

## What This Feature Enables

- **Any agent can process arbitrarily large inputs** — a Pi agent handling customer support can analyze a 10 MB conversation log; a code review agent can scan an entire repository
- **No architecture changes needed** — add `createRlmTool()` to an existing toolbox, done
- **Composable with other tools** — the parent agent can combine RLM with search, file access, database queries, etc.
- **Token budget awareness** — the RLM sub-agent tracks its own token usage and compacts message history when approaching the context window limit
- **Recursive depth** — for deeply structured inputs, the model can delegate sections to child RLM agents

---

## Examples

### Analyzing a large JSON dataset

```typescript
const result = await rlmTool.execute({
  input: JSON.stringify(millionRecordDataset),
  question: "How many records have status 'failed' and what are the top 5 error messages?",
});
// → "Found 1,247 failed records. Top 5 errors: ..."
```

### Scanning a codebase for patterns

```typescript
const result = await rlmTool.execute({
  input: entireCodebaseAsString,
  question: "List all functions that make HTTP calls without error handling",
});
// → "Found 8 functions: fetchUser (src/api.ts:42), ..."
```

### Summarizing a long document

```typescript
const result = await rlmTool.execute({
  input: longMarkdownDocument,
  question: "Extract all action items with their owners and deadlines",
});
// → "Action items: 1. Alice: deploy v2 by March 15, ..."
```
