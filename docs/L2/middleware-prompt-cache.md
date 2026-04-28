# @koi/middleware-prompt-cache — Cache-Friendly Message Reordering

`@koi/middleware-prompt-cache` is an L2 middleware that reorders model-request messages so stable content (system prompts) forms a consistent prefix, then attaches `CacheHints` for engine adapters to apply provider-specific cache markers (e.g. Anthropic `cache_control: ephemeral`, OpenAI automatic prefix caching).

This middleware is purely an optimization — it never changes which messages are sent, only their order, and only when reordering is semantically safe.

---

## Why It Exists

Anthropic and OpenAI both offer prompt caching that reuses a cached prefix across calls when the leading bytes are identical. If a turn-by-turn message array shuffles dynamic content (user input, tool results) in front of stable content (system prompt), the cache miss rate stays at ~100%.

```
Without prompt-cache:
  Call 1: [system, user_a]                       ─► cache miss (full bill)
  Call 2: [system, user_a, assistant_a, user_b]  ─► cache miss (no shared prefix)

With prompt-cache:
  Call 1: [system] [user_a]                                  ─► miss (write prefix)
  Call 2: [system] [user_a, assistant_a, user_b]             ─► HIT on [system]
```

For agents with large system prompts + tool catalogs, this can drop input cost by 70–90% on long sessions.

---

## Architecture

### Layer Position

```
L0  @koi/core                        ─ KoiMiddleware, ModelRequest, InboundMessage
L0u @koi/execution-context           ─ CacheHints, PROMPT_CACHE_HINTS side-channel
L0u @koi/token-estimator             ─ HEURISTIC_ESTIMATOR.estimateMessages
L2  @koi/middleware-prompt-cache     ─ this package (no L1, no peer L2)
```

### Internal Module Map

```
index.ts          ← public re-exports (createPromptCacheMiddleware, readCacheHints, types)
│
├── reorder.ts    ← pure: split static/dynamic, preserve input order, lastStableIndex
└── prompt-cache.ts ← createPromptCacheMiddleware() factory + extractProvider() (inlined)
```

`extractProvider()` is inlined (~10 LOC) rather than imported from `@koi/middleware-otel` (peer L2 — would violate layer rules).

### Middleware Priority

```
 50 ─ reflex             (intercept)
 50 ─ turn-ack           (resolve)
150 ─ prompt-cache       (resolve, this package)
200 ─ turn-prelude       (resolve)
```

Priority 150 in `resolve` phase: runs after channel intercepts but before middleware that mutates the message array (turn-prelude at 200, retry, etc.). This is critical — reordering must see the smallest, most stable message set so the cache prefix is maximal.

---

## How It Works

### Reorder Algorithm

```
Input: [user_a, system, assistant_a, system_2, user_b, tool_result]
                ↑                    ↑
                stable               stable

Partition (stable sort, preserves input order within each group):
  static  = [system, system_2]
  dynamic = [user_a, assistant_a, user_b, tool_result]

Output: [system, system_2, user_a, assistant_a, user_b, tool_result]
                          ↑
                          lastStableIndex = 1
```

**Correctness invariant:** A message is "static" iff `senderId.startsWith("system")`. Assistant, tool, and user messages are NEVER reordered relative to each other — moving them would corrupt the conversation turn semantics. The model would see assistant utterances before the user prompt that elicited them.

### Cache Hint Emission

After reordering, hints are attached to `request.metadata[CACHE_HINTS_KEY]` so they survive object-spread cloning by downstream middleware:

```typescript
{
  provider: "anthropic" | "openai" | "unknown",
  lastStableIndex: number,        // last index of static prefix; -1 if none
  staticPrefixTokens: number,     // estimated tokens in the prefix
}
```

Engine adapters read these via `readCacheHints(request.metadata)` and apply provider-specific markers when streaming the request to the LLM.

### Skip Conditions

The middleware passes the request through unchanged when:
1. `enabled: false` in config
2. Provider is **known but not in the configured allow-list** (e.g. `gemini-` when only `["anthropic"]` is configured)
3. Static prefix has 0 messages
4. Static prefix tokens < `staticPrefixMinTokens`

When the provider is **unknown** (no recognized prefix in the model id, or no model id at all), hints are still attached — adapters that understand them benefit; adapters that don't, ignore the metadata.

---

## API Reference

### `createPromptCacheMiddleware(config?)`

```typescript
import { createPromptCacheMiddleware } from "@koi/middleware-prompt-cache";

const promptCache = createPromptCacheMiddleware({
  providers: ["anthropic", "openai"],
  staticPrefixMinTokens: 1024,
});
```

Returns `KoiMiddleware` with:
- `name`: `"prompt-cache"`
- `priority`: `150`
- `phase`: `"resolve"`
- `wrapModelCall`, `wrapModelStream`, `describeCapabilities`

### `PromptCacheConfig`

```typescript
interface PromptCacheConfig {
  /** Master switch. Default: true. */
  readonly enabled?: boolean;
  /** Provider allow-list. Default: ["anthropic", "openai"]. */
  readonly providers?: readonly string[];
  /**
   * Minimum static-prefix tokens before hints are emitted. Below this, the
   * cache write cost outweighs the hit savings. Default: 1024.
   *
   * Provider thresholds (FYI):
   * - Anthropic: 1024 (Sonnet), 2048 (Haiku), 4096 (Opus)
   * - OpenAI: 1024 (automatic caching threshold)
   */
  readonly staticPrefixMinTokens?: number;
}
```

### `readCacheHints(metadata)`

```typescript
import { readCacheHints } from "@koi/middleware-prompt-cache";

// In an engine adapter:
const hints = readCacheHints(request.metadata);
if (hints !== undefined) {
  // apply provider-specific cache markers
}
```

### `CACHE_HINTS_KEY`

The `request.metadata` key under which hints are stored. Re-exported from `@koi/execution-context` for convenience.

---

## Layer Compliance

```
@koi/middleware-prompt-cache imports:
  ✅ @koi/core               (L0)   — KoiMiddleware, ModelRequest, InboundMessage
  ✅ @koi/execution-context  (L0u)  — CacheHints, CACHE_HINTS_KEY
  ✅ @koi/token-estimator    (L0u)  — HEURISTIC_ESTIMATOR.estimateMessages
  ❌ @koi/engine             (L1)   — NOT imported
  ❌ peer L2                  —       NOT imported (extractProvider is inlined)
```

Marked `koi.optional: true`. Adapters that do not understand `CacheHints` simply ignore the metadata key.
