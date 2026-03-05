# @koi/middleware-rlm — Recursive Language Model Middleware

Virtualizes unbounded input outside the context window and gives the model tools to programmatically examine, chunk, and recursively sub-query it. Works with any engine adapter (engine-pi, engine-loop, etc.) as a transparent middleware layer.

---

## Why It Exists

LLM context windows are finite. When an agent receives a 50 MB JSON file, a 200-page document, or a full codebase, it cannot load the content into context and reason over it directly. Without a solution, the agent either truncates (losing information) or fails.

`@koi/middleware-rlm` solves this by:

1. **Injecting `rlm_process` tool** — the model sees a tool it can call when input is too large
2. **Intercepting tool calls** — when the model calls `rlm_process`, the middleware runs a REPL loop internally
3. **Virtualizing input** — the full text lives outside context; the sub-agent accesses it through tools (`examine`, `chunk`, `input_info`)
4. **Recursive delegation** — for deeply nested inputs, the sub-agent can spawn child RLM agents via `rlm_query`
5. **Using the composed middleware chain** — sub-LLM calls go through model-router, retry, etc.

---

## Architecture

```
Agent (engine-pi / engine-loop / any)
  │
  ▼  model call
┌─────────────────────────────────┐
│ wrapModelCall (RLM middleware)  │
│  1. Capture `next` handler      │  ← stored in closure for REPL loop
│  2. Inject rlm_process tool     │
│  3. Call next(enriched request) │
└─────────────────────────────────┘
  │
  ▼  model returns tool_call: rlm_process
┌─────────────────────────────────┐
│ wrapToolCall (RLM middleware)   │
│  if toolId === "rlm_process":   │
│    run REPL loop using captured │
│    model handler for llm_query  │
│  else:                          │
│    next(request)  ← passthrough │
└─────────────────────────────────┘
```

`@koi/middleware-rlm` is an **L2 feature package** — depends only on L0 (`@koi/core`) and L0u (`@koi/resolve`). Zero external dependencies.

### Internal Tools (given to the REPL sub-agent)

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

## Usage

### As Middleware (recommended)

```typescript
import { createRlmMiddleware } from "@koi/middleware-rlm";

const rlm = createRlmMiddleware({
  maxIterations: 30,
  contextWindowTokens: 128_000,
});

// Add to any agent's middleware chain
const middleware = [rlm, modelRouter, retry];
```

### As MiddlewareBundle (with ECS registration)

```typescript
import { createRlmBundle } from "@koi/middleware-rlm";

const { middleware, providers } = createRlmBundle({
  contextWindowTokens: 128_000,
});

// Register middleware + tool provider
agent.use(middleware);
for (const p of providers) agent.attach(p);
```

### In a Manifest

```yaml
middleware:
  - name: rlm
    options:
      maxIterations: 30
      chunkSize: 4000
```

The calling agent sees `rlm_process` in its tool list and invokes it when it encounters input too large to fit in context:

```
rlm_process({ input: "...50MB of JSON...", question: "List all users with admin role" })
→ "Found 12 admin users: alice, bob, ..."
```

---

## Configuration

### `RlmMiddlewareConfig`

| Field | Default | Description |
|-------|---------|-------------|
| `priority` | 300 | Middleware priority (before model-router) |
| `rootModel` | — | Model ID for root-level REPL calls |
| `subCallModel` | — | Model ID for sub-calls (llm_query, compaction) |
| `maxIterations` | 30 | Max REPL loop iterations before forced stop |
| `maxInputBytes` | 100 MB | Max input size in bytes |
| `chunkSize` | 4,000 | Characters per chunk |
| `previewLength` | 200 | Characters shown in metadata preview |
| `compactionThreshold` | 0.8 | Fraction of context window that triggers compaction |
| `contextWindowTokens` | 100,000 | Total context window for budget tracking |
| `maxConcurrency` | 5 | Max parallel calls in `llm_query_batched` |
| `spawnRlmChild` | — | Callback to spawn child RLM agent |
| `onEvent` | — | Event callback for observability |
| `scriptRunner` | — | Script runner for code-execution mode (see below) |

---

## Code-Execution Mode

When `scriptRunner` is provided in the config, the REPL loop switches from **tool-dispatch** (model calls predefined tools) to **code-execution** (model writes JavaScript code blocks). This is strictly more powerful — the model can use loops, regex, string slicing, and arbitrary logic.

### How it works

1. The model receives a system prompt describing available functions (`readInput`, `inputInfo`, `llm_query`, `SUBMIT`, etc.)
2. The model responds with reasoning + a ` ```javascript ` code block
3. The middleware extracts the code, prepends function wrappers, and executes it in a WASM sandbox
4. Console output is fed back to the model as history
5. The loop repeats until `SUBMIT()` is called or `maxIterations` is reached

### Available functions in code-execution mode

| Function | Description |
|----------|-------------|
| `readInput(offset, length)` | Read a slice of the virtualized input |
| `inputInfo()` | Get input metadata (format, size, chunks, preview) |
| `llm_query(prompt)` | Single sub-LLM query |
| `llm_query_batched(prompts)` | Parallel sub-LLM queries |
| `SUBMIT(answer)` | Submit final answer |

### Enabling code-execution mode

Code-execution mode requires a script runner, which depends on `@koi/code-executor` (a peer L2 package). Since middleware-rlm is L2 and cannot import peer L2, the runner is injected via config. Use `@koi/rlm-stack` (L3) for automatic wiring:

```typescript
import { createRlmStack } from "@koi/rlm-stack";

const { middleware, providers } = createRlmStack({
  contextWindowTokens: 128_000,
});
```

---

## Key Design Insight

The middleware captures the `next` handler from `wrapModelCall` — this is the downstream middleware chain (model-router → terminal). When the REPL loop makes `llm_query` sub-calls, they go through retry/fallback but do NOT re-enter the RLM middleware (no infinite recursion). The outer audit middleware sees aggregate metrics.
