# model-compat-overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `supportsToolStreaming` + `thinkingDisplay` per-model capability flags to `@koi/model-openai-compat`, with a regex-based per-model override table sitting between URL detection and caller overrides.

**Architecture:** Three-layer resolution `detectCompat(url) → applyModelCompatRules(model) → callerOverrides` keeps existing behavior intact while allowing model-level quirk patches. The stream parser gains a buffered tool-call mode (emit everything after final chunk) wired by the new `supportsToolStreaming` flag. `thinkingDisplay` maps to provider wire fields in the request builder.

**Tech Stack:** Bun 1.3.x, TypeScript 6 strict, `bun:test`, no new deps.

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Modify | `packages/mm/model-openai-compat/src/types.ts` | Add 2 new fields to `ProviderCompat`/`ResolvedCompat`, update `_DEFAULT_COMPAT`, `detectCompat`, `resolveCompat(url, model, overrides?)` |
| Create | `packages/mm/model-openai-compat/src/model-compat.ts` | `ModelCompatRule` type + `MODEL_COMPAT_RULES` (empty) + `applyModelCompatRules` |
| Create | `packages/mm/model-openai-compat/src/model-compat.test.ts` | Tests for `applyModelCompatRules` + `resolveCompat` three-layer precedence |
| Modify | `packages/mm/model-openai-compat/src/request-mapper.ts` | Map `thinkingDisplay` → provider wire fields in `buildRequestBody` |
| Modify | `packages/mm/model-openai-compat/src/request-mapper.test.ts` | Tests for `thinkingDisplay` → body fields |
| Modify | `packages/mm/model-openai-compat/src/stream-parser.ts` | Add `options.supportsToolStreaming`, `accumulateToolCallDelta`, `flushBufferedToolCalls`, `bufferToolCalls` context flag |
| Modify | `packages/mm/model-openai-compat/src/stream-parser.test.ts` | Tests for buffered mode |
| Modify | `docs/L2/model-openai-compat.md` | Document resolution order, new fields, buffered-mode behavior |

---

## Task 1: Update docs

**Files:**
- Modify: `docs/L2/model-openai-compat.md`

- [ ] **Step 1: Add resolution-order section and new-fields table**

Replace the content of `docs/L2/model-openai-compat.md` with the updated version below. (Keep all existing sections; insert the new ones after the `### Reasoning / Extended Thinking` subsection.)

```markdown
### Compat Resolution Order

Provider compat is resolved in three layers, each narrowing the previous:

```
_DEFAULT_COMPAT
  ← merge  detectCompat(baseUrl)                (URL heuristics, e.g. OpenRouter / Groq)
  ← merge  MODEL_COMPAT_RULES first-match(model) (per-model quirks, regex-keyed)
  ← merge  config.compat                        (caller override, highest priority)
```

Each layer uses `??` merge — a field absent in the override falls through to the layer below.

### Per-Model Capability Flags

Two flags extend `ResolvedCompat` with model-specific defaults:

| Flag | Type | Default | Purpose |
|------|------|---------|---------|
| `supportsToolStreaming` | `boolean` | `true` | When `false`, tool-call deltas are buffered and emitted in one burst after the final stream chunk instead of progressively. Use for provider×model combos that emit malformed or partial `tool_calls` mid-stream. |
| `thinkingDisplay` | `"full" \| "summarized" \| "hidden"` | `"full"` | Controls how reasoning output is requested. `"full"` = current behavior; `"summarized"` = request thinking summaries (Anthropic via OpenRouter); `"hidden"` = exclude reasoning entirely. Only applied when `supportsReasoning` is true. |

### Per-Model Override Table

`model-compat.ts` exports `MODEL_COMPAT_RULES: readonly ModelCompatRule[]`. Each rule has a `match: RegExp` and `overrides: Partial<ResolvedCompat>`. First match wins. Ships empty — add rules as real-world failures surface, with a regression cassette per entry.

Example (not shipped — illustrative):

```typescript
{ match: /copilot.*haiku/i, overrides: { supportsToolStreaming: false } },
```

### Tool Call Buffering (`supportsToolStreaming: false`)

When `supportsToolStreaming` is `false`, `createStreamParser` buffers tool-call deltas silently during the stream and emits the complete sequence — `tool_call_start` → `tool_call_delta` (full args in one chunk) → `tool_call_end` — only after `finish()` is called. The downstream `EngineEvent` contract is identical; only the timing changes.
```

- [ ] **Step 2: Commit doc update**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/model-compat-overrides
git add docs/L2/model-openai-compat.md
git commit -m "docs(model-openai-compat): add resolution order, supportsToolStreaming, thinkingDisplay"
```

---

## Task 2: Write failing tests for `applyModelCompatRules` + `resolveCompat`

**Files:**
- Create: `packages/mm/model-openai-compat/src/model-compat.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/mm/model-openai-compat/src/model-compat.test.ts
import { describe, expect, test } from "bun:test";
import type { ModelCompatRule } from "./model-compat.js";
import { applyModelCompatRules } from "./model-compat.js";
import { resolveCompat } from "./types.js";

const OR_BASE = "https://openrouter.ai/api/v1";
const GROQ_BASE = "https://api.groq.com/openai/v1";
const UNKNOWN_BASE = "https://unknown-provider.example.com/v1";

describe("applyModelCompatRules", () => {
  test("returns base unchanged when no rules match", () => {
    const rules: readonly ModelCompatRule[] = [
      { match: /copilot/i, overrides: { supportsToolStreaming: false } },
    ];
    const base = resolveCompat(OR_BASE, "anthropic/claude-sonnet-4");
    const result = applyModelCompatRules("anthropic/claude-sonnet-4", base, rules);
    expect(result).toBe(base);
  });

  test("applies first matching rule, ignores subsequent matches", () => {
    const rules: readonly ModelCompatRule[] = [
      { match: /copilot/i, overrides: { supportsToolStreaming: false } },
      { match: /copilot/i, overrides: { supportsToolStreaming: true } },
    ];
    const base = resolveCompat(OR_BASE, "copilot/gpt-4");
    const result = applyModelCompatRules("copilot/gpt-4", base, rules);
    expect(result.supportsToolStreaming).toBe(false);
  });

  test("only overrides specified fields; others fall through", () => {
    const rules: readonly ModelCompatRule[] = [
      { match: /weird-model/i, overrides: { supportsToolStreaming: false } },
    ];
    const base = resolveCompat(OR_BASE, "weird-model");
    const result = applyModelCompatRules("weird-model", base, rules);
    expect(result.supportsToolStreaming).toBe(false);
    expect(result.supportsPromptCaching).toBe(base.supportsPromptCaching); // OpenRouter flag preserved
    expect(result.thinkingDisplay).toBe("full");
  });
});

describe("resolveCompat — three-layer precedence", () => {
  test("new fields default to safe values for unknown provider", () => {
    const result = resolveCompat(UNKNOWN_BASE, "any/model");
    expect(result.supportsToolStreaming).toBe(true);
    expect(result.thinkingDisplay).toBe("full");
  });

  test("new fields default to safe values for OpenRouter", () => {
    const result = resolveCompat(OR_BASE, "anthropic/claude-sonnet-4");
    expect(result.supportsToolStreaming).toBe(true);
    expect(result.thinkingDisplay).toBe("full");
  });

  test("caller override wins over provider default — supportsToolStreaming", () => {
    const result = resolveCompat(OR_BASE, "any/model", { supportsToolStreaming: false });
    expect(result.supportsToolStreaming).toBe(false);
    expect(result.supportsPromptCaching).toBe(true); // OpenRouter still applied
  });

  test("caller override wins over provider default — thinkingDisplay", () => {
    const result = resolveCompat(OR_BASE, "any/model", { thinkingDisplay: "hidden" });
    expect(result.thinkingDisplay).toBe("hidden");
  });

  test("caller override wins over both layers — both fields", () => {
    const result = resolveCompat(OR_BASE, "any/model", {
      supportsToolStreaming: false,
      thinkingDisplay: "summarized",
    });
    expect(result.supportsToolStreaming).toBe(false);
    expect(result.thinkingDisplay).toBe("summarized");
    expect(result.supportsPromptCaching).toBe(true); // unrelated field unchanged
  });

  test("unknown model passes through with zero model overrides applied", () => {
    const withoutModel = resolveCompat(GROQ_BASE, "unknown/model-xyz");
    const alsoWithoutModel = resolveCompat(GROQ_BASE, "another/unknown-xyz");
    // Same URL → same result regardless of model (no rules match)
    expect(withoutModel.supportsUsageInStreaming).toBe(alsoWithoutModel.supportsUsageInStreaming);
    expect(withoutModel.supportsToolStreaming).toBe(true);
  });

  test("resolveCompat model param is ignored when MODEL_COMPAT_RULES is empty", () => {
    // The shipped empty rules table means model param has no effect yet
    const a = resolveCompat(OR_BASE, "model-a");
    const b = resolveCompat(OR_BASE, "model-b");
    // All fields except model-dependent ones should be equal
    expect(a.supportsToolStreaming).toBe(b.supportsToolStreaming);
    expect(a.thinkingDisplay).toBe(b.thinkingDisplay);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail (module not found)**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/model-compat-overrides
bun test packages/mm/model-openai-compat/src/model-compat.test.ts 2>&1 | head -20
```

Expected: error about missing `./model-compat.js` module.

---

## Task 3: Implement `model-compat.ts` + extend `types.ts`

**Files:**
- Create: `packages/mm/model-openai-compat/src/model-compat.ts`
- Modify: `packages/mm/model-openai-compat/src/types.ts`

- [ ] **Step 1: Create `model-compat.ts`**

```typescript
// packages/mm/model-openai-compat/src/model-compat.ts
import type { ResolvedCompat } from "./types.js";

export interface ModelCompatRule {
  readonly match: RegExp;
  readonly overrides: Partial<ResolvedCompat>;
}

export const MODEL_COMPAT_RULES: readonly ModelCompatRule[] = [] as const;

export function applyModelCompatRules(
  model: string,
  base: ResolvedCompat,
  rules: readonly ModelCompatRule[] = MODEL_COMPAT_RULES,
): ResolvedCompat {
  for (const rule of rules) {
    if (rule.match.test(model)) {
      return { ...base, ...rule.overrides };
    }
  }
  return base;
}
```

- [ ] **Step 2: Add two new fields to `ProviderCompat` in `types.ts`**

In `types.ts`, after the `defaultReasoningEffort` field in `ProviderCompat`, add:

```typescript
  /**
   * When false, tool-call deltas are buffered and emitted in one burst after
   * the final stream chunk. Use for provider×model combos that emit malformed
   * or partial tool_calls arrays mid-stream.
   * Default: true.
   */
  readonly supportsToolStreaming?: boolean | undefined;
  /**
   * How to request reasoning output when supportsReasoning is true.
   *   "full"       — full reasoning blocks inline (provider default)
   *   "summarized" — request thinking summaries (Anthropic via OpenRouter)
   *   "hidden"     — exclude reasoning entirely
   * Default: "full".
   */
  readonly thinkingDisplay?: "full" | "summarized" | "hidden" | undefined;
```

- [ ] **Step 3: Add two new fields to `ResolvedCompat` in `types.ts`**

After `defaultReasoningEffort` in `ResolvedCompat`:

```typescript
  readonly supportsToolStreaming: boolean;
  readonly thinkingDisplay: "full" | "summarized" | "hidden";
```

- [ ] **Step 4: Update `_DEFAULT_COMPAT`**

```typescript
const _DEFAULT_COMPAT: ResolvedCompat = {
  supportsUsageInStreaming: true,
  maxTokensField: "max_completion_tokens",
  supportsStore: true,
  supportsDeveloperRole: true,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  supportsStrictMode: true,
  supportsPromptCaching: false,
  supportsReasoning: false,
  defaultReasoningEffort: "medium",
  supportsToolStreaming: true,
  thinkingDisplay: "full",
};
```

- [ ] **Step 5: Update `detectCompat` return value**

Add the two new fields (safe defaults) to the return object of `detectCompat`:

```typescript
    supportsToolStreaming: true,
    thinkingDisplay: "full",
```

- [ ] **Step 6: Update `resolveCompat` signature and merge logic**

Replace the existing `resolveCompat` function with:

```typescript
import { applyModelCompatRules } from "./model-compat.js";

/** Merge explicit overrides with auto-detected + per-model compat. */
export function resolveCompat(baseUrl: string, model: string, overrides?: ProviderCompat): ResolvedCompat {
  const detected = detectCompat(baseUrl);
  const withModelOverrides = applyModelCompatRules(model, detected);
  if (overrides === undefined) return withModelOverrides;
  return {
    supportsUsageInStreaming:
      overrides.supportsUsageInStreaming ?? withModelOverrides.supportsUsageInStreaming,
    maxTokensField: overrides.maxTokensField ?? withModelOverrides.maxTokensField,
    supportsStore: overrides.supportsStore ?? withModelOverrides.supportsStore,
    supportsDeveloperRole: overrides.supportsDeveloperRole ?? withModelOverrides.supportsDeveloperRole,
    requiresToolResultName:
      overrides.requiresToolResultName ?? withModelOverrides.requiresToolResultName,
    requiresAssistantAfterToolResult:
      overrides.requiresAssistantAfterToolResult ?? withModelOverrides.requiresAssistantAfterToolResult,
    requiresThinkingAsText: overrides.requiresThinkingAsText ?? withModelOverrides.requiresThinkingAsText,
    supportsStrictMode: overrides.supportsStrictMode ?? withModelOverrides.supportsStrictMode,
    supportsPromptCaching: overrides.supportsPromptCaching ?? withModelOverrides.supportsPromptCaching,
    supportsReasoning: overrides.supportsReasoning ?? withModelOverrides.supportsReasoning,
    defaultReasoningEffort:
      overrides.defaultReasoningEffort ?? withModelOverrides.defaultReasoningEffort,
    supportsToolStreaming:
      overrides.supportsToolStreaming ?? withModelOverrides.supportsToolStreaming,
    thinkingDisplay: overrides.thinkingDisplay ?? withModelOverrides.thinkingDisplay,
  };
}
```

- [ ] **Step 7: Update `resolveConfig` to thread model into `resolveCompat`**

In `resolveConfig`, change:

```typescript
    compat: resolveCompat(baseUrl, config.compat),
```

to:

```typescript
    compat: resolveCompat(baseUrl, config.model, config.compat),
```

- [ ] **Step 8: Run tests — should pass**

```bash
bun test packages/mm/model-openai-compat/src/model-compat.test.ts 2>&1
```

Expected: all tests pass.

- [ ] **Step 9: Run full package tests — no regressions**

```bash
bun run test --filter=@koi/model-openai-compat 2>&1 | tail -10
```

Expected: 176+ pass, 0 fail.

- [ ] **Step 10: Commit**

```bash
git add packages/mm/model-openai-compat/src/types.ts \
        packages/mm/model-openai-compat/src/model-compat.ts \
        packages/mm/model-openai-compat/src/model-compat.test.ts
git commit -m "feat(model-openai-compat): add supportsToolStreaming + thinkingDisplay fields and model-compat rule table"
```

---

## Task 4: Write failing tests for `thinkingDisplay` → request body

**Files:**
- Modify: `packages/mm/model-openai-compat/src/request-mapper.test.ts`

- [ ] **Step 1: Append failing tests to `request-mapper.test.ts`**

Find the last `describe` block in `request-mapper.test.ts` and add a new `describe` block after it:

```typescript
describe("buildRequestBody — thinkingDisplay", () => {
  const baseConfig = {
    apiKey: "test-key",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-sonnet-4",
  } as const;

  const baseRequest: ModelRequest = {
    messages: [],
    systemPrompt: undefined,
    model: undefined,
    maxTokens: undefined,
    temperature: undefined,
  };

  test('thinkingDisplay "full" emits reasoning.effort (current behavior)', () => {
    const config = resolveConfig({
      ...baseConfig,
      compat: { supportsReasoning: true, thinkingDisplay: "full" },
    });
    const body = buildRequestBody(baseRequest, config);
    expect(body.reasoning).toEqual({ effort: "medium" });
    expect(body.thinking).toBeUndefined();
  });

  test('thinkingDisplay "hidden" emits reasoning: { exclude: true }', () => {
    const config = resolveConfig({
      ...baseConfig,
      compat: { supportsReasoning: true, thinkingDisplay: "hidden" },
    });
    const body = buildRequestBody(baseRequest, config);
    expect(body.reasoning).toEqual({ exclude: true });
    expect(body.thinking).toBeUndefined();
  });

  test('thinkingDisplay "summarized" on anthropic model emits thinking: { type: "summarized" } + reasoning.effort', () => {
    const config = resolveConfig({
      ...baseConfig,
      model: "anthropic/claude-sonnet-4",
      compat: { supportsReasoning: true, thinkingDisplay: "summarized" },
    });
    const body = buildRequestBody(baseRequest, config);
    expect(body.reasoning).toEqual({ effort: "medium" });
    expect(body.thinking).toEqual({ type: "summarized" });
  });

  test('thinkingDisplay "summarized" on non-anthropic model omits thinking field', () => {
    const config = resolveConfig({
      ...baseConfig,
      model: "openai/gpt-4o",
      compat: { supportsReasoning: true, thinkingDisplay: "summarized" },
    });
    const body = buildRequestBody(baseRequest, config);
    expect(body.reasoning).toEqual({ effort: "medium" });
    expect(body.thinking).toBeUndefined();
  });

  test("thinkingDisplay is ignored when supportsReasoning is false", () => {
    const config = resolveConfig({
      ...baseConfig,
      compat: { supportsReasoning: false, thinkingDisplay: "hidden" },
    });
    const body = buildRequestBody(baseRequest, config);
    expect(body.reasoning).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });
});
```

Note: `resolveConfig` and `buildRequestBody` must be imported at the top of `request-mapper.test.ts` (check existing imports — `resolveConfig` may need to be added).

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test packages/mm/model-openai-compat/src/request-mapper.test.ts 2>&1 | grep -E "fail|FAIL|thinkingDisplay" | head -20
```

Expected: the new `thinkingDisplay` tests fail (undefined body fields).

---

## Task 5: Implement `thinkingDisplay` in `request-mapper.ts`

**Files:**
- Modify: `packages/mm/model-openai-compat/src/request-mapper.ts`

- [ ] **Step 1: Replace the `supportsReasoning` block in `buildRequestBody`**

Find this block (around line 431):

```typescript
  // Reasoning / extended thinking — OpenRouter returns reasoning tokens as
  // `reasoning_content` in the SSE stream when this field is present.
  // Models without reasoning capability ignore it silently.
  if (config.compat.supportsReasoning) {
    body.reasoning = { effort: config.compat.defaultReasoningEffort };
  }
```

Replace with:

```typescript
  if (config.compat.supportsReasoning) {
    const td = config.compat.thinkingDisplay;
    if (td === "hidden") {
      body.reasoning = { exclude: true };
    } else if (td === "summarized") {
      if (effectiveModel.startsWith("anthropic/")) {
        body.thinking = { type: "summarized" };
      }
      body.reasoning = { effort: config.compat.defaultReasoningEffort };
    } else {
      // "full" — provider default
      body.reasoning = { effort: config.compat.defaultReasoningEffort };
    }
  }
```

- [ ] **Step 2: Run tests to confirm they pass**

```bash
bun test packages/mm/model-openai-compat/src/request-mapper.test.ts 2>&1 | tail -10
```

Expected: all tests pass (including new `thinkingDisplay` tests).

- [ ] **Step 3: Run full package tests**

```bash
bun run test --filter=@koi/model-openai-compat 2>&1 | tail -10
```

Expected: all pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add packages/mm/model-openai-compat/src/request-mapper.ts \
        packages/mm/model-openai-compat/src/request-mapper.test.ts
git commit -m "feat(model-openai-compat): map thinkingDisplay to provider wire fields in buildRequestBody"
```

---

## Task 6: Write failing tests for `supportsToolStreaming: false`

**Files:**
- Modify: `packages/mm/model-openai-compat/src/stream-parser.test.ts`

- [ ] **Step 1: Append failing tests to `stream-parser.test.ts`**

Add this `describe` block at the end of `stream-parser.test.ts`:

```typescript
describe("createStreamParser — supportsToolStreaming: false (buffered mode)", () => {
  function makeAcc(): AccumulatedResponse {
    return createEmptyAccumulator();
  }

  function makeToolDeltaChunk(
    idx: number,
    id: string | undefined,
    name: string | undefined,
    args: string,
    finishReason: string | null = null,
  ): ChatCompletionChunk {
    return {
      id: "chunk-1",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: idx,
                id,
                function: { name, arguments: args },
              },
            ],
          },
          finish_reason: finishReason,
        },
      ],
    };
  }

  test("no tool chunks emitted during feed; full sequence emitted at finish", () => {
    const parser = createStreamParser(makeAcc(), { supportsToolStreaming: false });

    // Mid-stream: name arrives in first chunk
    const c1 = makeToolDeltaChunk(0, "call_abc", "my_tool", "");
    // Mid-stream: args arrive in second chunk
    const c2 = makeToolDeltaChunk(0, undefined, undefined, '{"x":1}');
    // Final chunk with finish_reason
    const c3 = makeToolDeltaChunk(0, undefined, undefined, "", "tool_calls");

    const duringFeed = [
      ...parser.feed(c1),
      ...parser.feed(c2),
      ...parser.feed(c3),
    ];

    // No tool-related chunks should be emitted during the stream
    const toolChunksDuringFeed = duringFeed.filter(
      (c) => c.kind === "tool_call_start" || c.kind === "tool_call_delta" || c.kind === "tool_call_end",
    );
    expect(toolChunksDuringFeed).toHaveLength(0);

    // finish() emits complete sequence
    const atFinish = parser.finish();
    const starts = atFinish.filter((c) => c.kind === "tool_call_start");
    const deltas = atFinish.filter((c) => c.kind === "tool_call_delta");
    const ends = atFinish.filter((c) => c.kind === "tool_call_end");

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ kind: "tool_call_delta", delta: '{"x":1}' });
  });

  test("finish() delta contains full accumulated args from all mid-stream chunks", () => {
    const parser = createStreamParser(makeAcc(), { supportsToolStreaming: false });

    parser.feed(makeToolDeltaChunk(0, "call_1", "tool_a", ""));
    parser.feed(makeToolDeltaChunk(0, undefined, undefined, '{"a":'));
    parser.feed(makeToolDeltaChunk(0, undefined, undefined, '"hello"'));
    parser.feed(makeToolDeltaChunk(0, undefined, undefined, "}", "tool_calls"));

    const chunks = parser.finish();
    const delta = chunks.find((c) => c.kind === "tool_call_delta");
    expect(delta).toMatchObject({ kind: "tool_call_delta", delta: '{"a":"hello"}' });
  });

  test("accumulator has parsed tool call after finish", () => {
    const parser = createStreamParser(makeAcc(), { supportsToolStreaming: false });

    parser.feed(makeToolDeltaChunk(0, "call_2", "add", ""));
    parser.feed(makeToolDeltaChunk(0, undefined, undefined, '{"a":1,"b":2}', "tool_calls"));
    parser.finish();

    const acc = parser.getAccumulator();
    expect(acc.richContent).toHaveLength(1);
    expect(acc.richContent[0]).toMatchObject({
      kind: "tool_call",
      name: "add",
      arguments: { a: 1, b: 2 },
    });
  });

  test("default (supportsToolStreaming: true) still emits deltas progressively", () => {
    const parser = createStreamParser(makeAcc()); // no options = default true

    const feedChunks: ModelChunk[] = [];
    feedChunks.push(...parser.feed(makeToolDeltaChunk(0, "call_3", "my_fn", "")));
    feedChunks.push(...parser.feed(makeToolDeltaChunk(0, undefined, undefined, '{"z":9}', "tool_calls")));

    const starts = feedChunks.filter((c) => c.kind === "tool_call_start");
    const deltas = feedChunks.filter((c) => c.kind === "tool_call_delta");
    expect(starts).toHaveLength(1);
    expect(deltas).toHaveLength(1); // emitted progressively during feed
  });

  test("empty args buffer — finish emits start+end, no delta", () => {
    const parser = createStreamParser(makeAcc(), { supportsToolStreaming: false });

    parser.feed(makeToolDeltaChunk(0, "call_4", "noop", ""));
    parser.feed(makeToolDeltaChunk(0, undefined, undefined, "", "tool_calls"));

    const chunks = parser.finish();
    const starts = chunks.filter((c) => c.kind === "tool_call_start");
    const deltas = chunks.filter((c) => c.kind === "tool_call_delta");
    const ends = chunks.filter((c) => c.kind === "tool_call_end");

    expect(starts).toHaveLength(1);
    expect(deltas).toHaveLength(0); // empty args → no delta
    expect(ends).toHaveLength(1);
  });
});
```

Note: ensure `AccumulatedResponse`, `createEmptyAccumulator`, `ChatCompletionChunk`, and `ModelChunk` are imported at the top of `stream-parser.test.ts`.

- [ ] **Step 2: Run tests to confirm new ones fail**

```bash
bun test packages/mm/model-openai-compat/src/stream-parser.test.ts 2>&1 | grep -E "supportsToolStreaming|fail|FAIL" | head -20
```

Expected: new tests fail (options param not yet accepted).

---

## Task 7: Implement `supportsToolStreaming: false` in `stream-parser.ts`

**Files:**
- Modify: `packages/mm/model-openai-compat/src/stream-parser.ts`

- [ ] **Step 1: Add `bufferToolCalls` to `ParserContext`**

Find the `interface ParserContext` and add the field:

```typescript
interface ParserContext {
  state: ParserState;
  acc: MutableAccumulator;
  activeToolCalls: Map<
    number,
    { id: string; name: string; argBuffer: string; startEmitted: boolean }
  >;
  readonly bufferToolCalls: boolean;
}
```

- [ ] **Step 2: Add `accumulateToolCallDelta` helper**

Add this function after `closeActiveToolCalls` (around line 342):

```typescript
function accumulateToolCallDelta(
  tc: ChatCompletionChunkToolCall,
  activeToolCalls: Map<
    number,
    { id: string; name: string; argBuffer: string; startEmitted: boolean }
  >,
): void {
  const idx = tc.index;
  let active = activeToolCalls.get(idx);
  if (active === undefined || (tc.id !== undefined && active.id !== tc.id)) {
    const callId = tc.id ?? `call_${idx}`;
    const name = tc.function?.name ?? "";
    active = { id: callId, name, argBuffer: "", startEmitted: false };
    activeToolCalls.set(idx, active);
  }
  if (tc.function?.name !== undefined && active.name.length === 0) {
    active.name = tc.function.name;
  }
  if (tc.function?.arguments !== undefined) {
    active.argBuffer += tc.function.arguments;
  }
}
```

- [ ] **Step 3: Add `flushBufferedToolCalls` helper**

Add this function after `accumulateToolCallDelta`:

```typescript
function flushBufferedToolCalls(
  activeToolCalls: Map<
    number,
    { id: string; name: string; argBuffer: string; startEmitted: boolean }
  >,
  acc: MutableAccumulator,
): readonly ModelChunk[] {
  const chunks: ModelChunk[] = [];
  for (const [, active] of activeToolCalls) {
    if (active.name === "") {
      chunks.push(
        { kind: "tool_call_start", toolName: "", callId: toolCallId(active.id) },
        {
          kind: "error",
          message: `Tool call "${active.id}" has no function name — cannot dispatch`,
          code: "VALIDATION",
        },
      );
      continue;
    }
    const result = parseToolArguments(active.argBuffer);
    if (result.ok) {
      acc.richContent.push({
        kind: "tool_call",
        id: toolCallId(active.id),
        name: active.name,
        arguments: result.args,
      });
      chunks.push({ kind: "tool_call_start", toolName: active.name, callId: toolCallId(active.id) });
      if (active.argBuffer.length > 0) {
        chunks.push({
          kind: "tool_call_delta",
          callId: toolCallId(active.id),
          delta: active.argBuffer,
        });
      }
      chunks.push({ kind: "tool_call_end", callId: toolCallId(active.id) });
    } else {
      chunks.push(
        { kind: "tool_call_start", toolName: active.name, callId: toolCallId(active.id) },
        {
          kind: "error",
          message: `Invalid tool call arguments for "${active.name}": ${result.raw}`,
          code: "VALIDATION",
        },
      );
    }
  }
  activeToolCalls.clear();
  return chunks;
}
```

- [ ] **Step 4: Update `feedChunk` to branch on `bufferToolCalls`**

Find the `delta.tool_calls` handler in `feedChunk` (around line 406):

```typescript
  if (delta.tool_calls !== undefined) {
    // Flush any in-progress text/thinking segment before processing tool calls
    if (ctx.state.kind === "text" || ctx.state.kind === "thinking") {
      flushCurrentSegment(ctx);
      ctx.state = { kind: "idle" };
    }
    for (const tc of delta.tool_calls) {
      output.push(...processToolCallDelta(tc, ctx.activeToolCalls, ctx.acc));
    }
    const lastEntry = [...ctx.activeToolCalls.values()].at(-1);
    if (lastEntry !== undefined) {
      ctx.state = { kind: "tool_call", callId: lastEntry.id, argBuffer: lastEntry.argBuffer };
    }
  }
```

Replace with:

```typescript
  if (delta.tool_calls !== undefined) {
    if (ctx.state.kind === "text" || ctx.state.kind === "thinking") {
      flushCurrentSegment(ctx);
      ctx.state = { kind: "idle" };
    }
    if (ctx.bufferToolCalls) {
      for (const tc of delta.tool_calls) {
        accumulateToolCallDelta(tc, ctx.activeToolCalls);
      }
    } else {
      for (const tc of delta.tool_calls) {
        output.push(...processToolCallDelta(tc, ctx.activeToolCalls, ctx.acc));
      }
      const lastEntry = [...ctx.activeToolCalls.values()].at(-1);
      if (lastEntry !== undefined) {
        ctx.state = { kind: "tool_call", callId: lastEntry.id, argBuffer: lastEntry.argBuffer };
      }
    }
  }
```

- [ ] **Step 5: Update `finishParsing` to branch on `bufferToolCalls`**

Replace:

```typescript
function finishParsing(ctx: ParserContext): readonly ModelChunk[] {
  flushCurrentSegment(ctx);
  const output = [...closeActiveToolCalls(ctx.activeToolCalls, ctx.acc)];
  ctx.state = { kind: "idle" };
  return output;
}
```

With:

```typescript
function finishParsing(ctx: ParserContext): readonly ModelChunk[] {
  flushCurrentSegment(ctx);
  const output = ctx.bufferToolCalls
    ? [...flushBufferedToolCalls(ctx.activeToolCalls, ctx.acc)]
    : [...closeActiveToolCalls(ctx.activeToolCalls, ctx.acc)];
  ctx.state = { kind: "idle" };
  return output;
}
```

- [ ] **Step 6: Update `createStreamParser` signature and context init**

Replace:

```typescript
export function createStreamParser(initialAccumulator: AccumulatedResponse): {
  feed: (chunk: ChatCompletionChunk) => readonly ModelChunk[];
  finish: () => readonly ModelChunk[];
  getAccumulator: () => AccumulatedResponse;
} {
  const ctx: ParserContext = {
    state: { kind: "idle" },
    acc: {
      ...initialAccumulator,
      richContent: [...initialAccumulator.richContent],
      currentTextSegment: "",
      currentThinkingSegment: "",
      receivedFinishReason: false,
      receivedUsage: false,
    },
    activeToolCalls: new Map(),
  };
```

With:

```typescript
export function createStreamParser(
  initialAccumulator: AccumulatedResponse,
  options?: { readonly supportsToolStreaming?: boolean },
): {
  feed: (chunk: ChatCompletionChunk) => readonly ModelChunk[];
  finish: () => readonly ModelChunk[];
  getAccumulator: () => AccumulatedResponse;
} {
  const ctx: ParserContext = {
    state: { kind: "idle" },
    acc: {
      ...initialAccumulator,
      richContent: [...initialAccumulator.richContent],
      currentTextSegment: "",
      currentThinkingSegment: "",
      receivedFinishReason: false,
      receivedUsage: false,
    },
    activeToolCalls: new Map(),
    bufferToolCalls: !(options?.supportsToolStreaming ?? true),
  };
```

- [ ] **Step 7: Run new tests**

```bash
bun test packages/mm/model-openai-compat/src/stream-parser.test.ts 2>&1 | tail -15
```

Expected: all tests pass including the new `supportsToolStreaming` describe block.

- [ ] **Step 8: Run full package tests**

```bash
bun run test --filter=@koi/model-openai-compat 2>&1 | tail -10
```

Expected: all pass, 0 fail.

- [ ] **Step 9: Commit**

```bash
git add packages/mm/model-openai-compat/src/stream-parser.ts \
        packages/mm/model-openai-compat/src/stream-parser.test.ts
git commit -m "feat(model-openai-compat): buffer tool-call deltas when supportsToolStreaming is false"
```

---

## Task 8: Run full CI gates

- [ ] **Step 1: Typecheck**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/model-compat-overrides
bun run typecheck 2>&1 | tail -15
```

Expected: 0 errors.

- [ ] **Step 2: Lint**

```bash
bun run lint 2>&1 | tail -10
```

Expected: 0 errors.

- [ ] **Step 3: Layer check**

```bash
bun run check:layers 2>&1 | tail -10
```

Expected: passes.

- [ ] **Step 4: Full test suite**

```bash
bun run test 2>&1 | tail -15
```

Expected: all pass.

- [ ] **Step 5: Final commit if any lint fixes needed**

```bash
git add -p
git commit -m "chore(model-openai-compat): lint and typecheck fixes"
```

---

## Self-Review

### Spec coverage

| Spec requirement | Task |
|-----------------|------|
| `supportsToolStreaming` field in `ResolvedCompat` | Task 3 |
| `thinkingDisplay` field in `ResolvedCompat` | Task 3 |
| `model-compat.ts` with `ModelCompatRule` + empty rules table | Task 3 |
| `resolveCompat(url, model, overrides)` — three-layer resolution | Task 3 |
| `supportsToolStreaming=false` → buffer tool deltas, emit at finish | Task 7 |
| `thinkingDisplay` → provider wire fields in `buildRequestBody` | Task 5 |
| Unit tests — three-layer precedence | Task 2 |
| Unit tests — unknown model falls back | Task 2 |
| Parser tests — buffered mode | Task 6 |
| Request-mapper tests — `thinkingDisplay` → body | Task 4 |
| Docs — resolution order + new fields | Task 1 |

Non-goals confirmed not present: no golden cassette (new L2 package rule doesn't apply — existing L2 package modified), no model registry, no per-request overrides.

### Type consistency

- `ModelCompatRule.overrides: Partial<ResolvedCompat>` — used in Tasks 2, 3 ✓
- `applyModelCompatRules(model, base, rules?)` — called in `resolveCompat` Task 3 ✓
- `createStreamParser(acc, options?)` — options optional, backward compat ✓
- `bufferToolCalls` used in `feedChunk` and `finishParsing` ✓
- `thinkingDisplay` accessed as `config.compat.thinkingDisplay` ✓
