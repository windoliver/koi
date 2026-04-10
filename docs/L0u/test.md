# @koi/test — Test doubles and assertions for Koi agents (L0u)

Deterministic test doubles (mock model adapter, fake engine, mock channel, mock tool, handler spies), context factories, event collectors, and runner-agnostic assertions. Works with `bun:test` out of the box.

---

## Why It Exists

Users building custom agents on Koi previously had no first-party way to write deterministic tests. Every consumer reinvented mock adapters and fixture loading. `@koi/test` is the single canonical home for these utilities and is importable from both L1 (engine internals) and L2 (feature packages).

The package is deliberately scoped to *test doubles and assertions*. Cassette/replay support lives in `@koi/replay` (separate issue). Contract test suites are out of scope for now.

---

## What It Provides

| Export | Purpose |
|--------|---------|
| `createMockAdapter(config)` | ModelAdapter that replays pre-scripted `complete`/`stream` calls |
| `createFakeEngine(config)` | EngineAdapter with pre-scripted turn bodies, auto-wrapped control flow |
| `createMockChannel(config?)` | ChannelAdapter that captures sent messages and simulates inbound |
| `createMockTool(config)` | ToolDescriptor + handler with call recording |
| `createSpyModelHandler(response?)` | Lightweight `ModelHandler` spy — records every request |
| `createSpyModelStreamHandler(chunks)` | Lightweight `ModelStreamHandler` spy |
| `createSpyToolHandler(response?)` | Lightweight `ToolHandler` spy |
| `createMockSessionContext(overrides?)` | `SessionContext` factory with sensible defaults |
| `createMockTurnContext(overrides?)` | `TurnContext` factory — supports nested session overrides |
| `createMockInboundMessage(overrides?)` | `InboundMessage` factory with `text` shortcut |
| `collectEvents(stream)` | Drain an `AsyncIterable<EngineEvent>` into an array |
| `collectText(events)` | Concatenate text_delta events |
| `collectToolNames(events)` | Extract tool call names in order |
| `collectOutput(events)` | Return the `EngineOutput` from the `done` event |
| `collectUsage(events)` | Return input/output token counts from the `done` event |
| `filterByKind(events, kind)` | Filter by discriminant with type narrowing |
| `assertToolSequence(events, expected, opts?)` | Assert tool call order (exact / contains / startsWith) |
| `assertNoToolErrors(events)` | Assert no tool_call_end returned an error shape |
| `assertCostUnder(events, maxUsd)` | Assert `done.output.metrics.costUsd` is below a threshold |
| `assertTextContains(events, substring)` | Assert text output contains a substring |
| `assertTextMatches(events, pattern)` | Assert text output matches a regex |
| `assertTurnCount(events, expected)` | Assert the number of `turn_start` events |
| `assertOk(result)` | Narrow `Result<T, KoiError>` to the Ok variant |
| `assertErr(result)` | Narrow `Result<T, KoiError>` to the Err variant |
| `assertErrCode(result, code)` | Narrow to Err with a specific error code |
| `textResponse(text, opts?)` | Helper — build a minimal `ModelResponse` |
| `streamTextChunks(text)` | Helper — build a text_delta + done `ModelChunk` sequence |

---

## Architecture

```
L0  @koi/core ──────────────────────────────────────────────────────┐
    ModelAdapter, ModelChunk, ModelRequest, ModelResponse,           │
    EngineAdapter, EngineEvent, EngineOutput, EngineMetrics,         │
    ChannelAdapter, SessionContext, TurnContext, InboundMessage,     │
    ToolDescriptor, ToolRequest, ToolResponse, ToolHandler,          │
    KoiMiddleware handler types, Result, KoiError, KoiErrorCode      │
                                                                      ▼
L0u @koi/test <──────────────────────────────────────────────────────┘
    imports from L0 only
    × zero external dependencies
    ~ package.json: { "dependencies": { "@koi/core": "workspace:*" } }
```

---

## Design Choices

### 1. Discriminated `MockCall` spec

`createMockAdapter` accepts a `MockCall[]`, where each call is explicitly tagged with a mode:

```ts
type MockCall =
  | { readonly mode: "complete"; readonly response: ModelResponse }
  | { readonly mode: "stream"; readonly chunks: readonly ModelChunk[] };
```

`complete()` and `stream()` each consume the next scripted call and throw on mode mismatch — there is no silent coercion from chunks to a reconstructed `ModelResponse`. This makes failures loud and easy to diagnose.

### 2. Lazy stream advancement

`stream()` returns an async iterable that **advances the call index on the first pull**, not at construction. A stream that is created but never iterated does not burn a scripted response. This matches the behavior of real streaming adapters and prevents tests from silently masking bugs.

### 3. `onExhausted: "throw"` by default

When scripted calls are exhausted, the default policy is to throw — this surfaces runaway agent loops immediately. Pass `onExhausted: "repeat-last"` for explicitly long-running tests.

### 4. Compile-time ban on control events in turn bodies

`createFakeEngine` auto-emits `turn_start`, `turn_end`, and `done` around each scripted turn. The `TurnBodyEvent` type uses `Exclude<>` to compile-time reject those three kinds inside a scripted turn body. A runtime guard backs up the type check.

### 5. Flat runner-agnostic assertions

Assertion helpers (`assertToolSequence`, `assertNoToolErrors`, etc.) throw plain `Error` on failure with expected/actual in the message. They do not depend on `bun:test`, Vitest, or Jest — any runner that catches thrown errors will treat them as failures.

### 6. Factory functions, no classes

Every export is a factory function returning a plain object. No `new`, no `this`, no stateful classes.

---

## Example — Testing a 3-tool agent

This example uses `createFakeEngine` + assertions to verify that an agent invokes three tools in the expected order and produces output containing a keyword.

```ts
import { describe, test } from "bun:test";
import { toolCallId } from "@koi/core";
import type { TurnBodyEvent } from "@koi/test";
import {
  createFakeEngine,
  collectEvents,
  assertToolSequence,
  assertTextContains,
  assertTurnCount,
  assertNoToolErrors,
} from "@koi/test";

describe("my-agent", () => {
  test("invokes glob → read → edit and reports success", async () => {
    const turnBody: TurnBodyEvent[] = [
      { kind: "tool_call_start", toolName: "glob", callId: toolCallId("c1") },
      { kind: "tool_call_end", callId: toolCallId("c1"), result: { paths: ["a.ts"] } },
      { kind: "tool_call_start", toolName: "read", callId: toolCallId("c2") },
      { kind: "tool_call_end", callId: toolCallId("c2"), result: { content: "old" } },
      { kind: "tool_call_start", toolName: "edit", callId: toolCallId("c3") },
      { kind: "tool_call_end", callId: toolCallId("c3"), result: { ok: true } },
      { kind: "text_delta", delta: "Refactor complete." },
    ];

    const { adapter } = createFakeEngine({ turns: [turnBody] });

    const events = await collectEvents(
      adapter.stream({ kind: "text", text: "Refactor a.ts" }),
    );

    assertTurnCount(events, 1);
    assertToolSequence(events, ["glob", "read", "edit"]);
    assertNoToolErrors(events);
    assertTextContains(events, "Refactor complete");
  });
});
```

---

## Example — Testing middleware with a mock adapter

When the focus is model-level behavior (middleware, retries, rate limits), reach for `createMockAdapter` instead of the engine-level `createFakeEngine`:

```ts
import { test } from "bun:test";
import {
  createMockAdapter,
  textResponse,
  streamTextChunks,
} from "@koi/test";

test("retry middleware replays after error", async () => {
  const { adapter, callCount } = createMockAdapter({
    calls: [
      { mode: "complete", response: textResponse("first try") },
      { mode: "complete", response: textResponse("second try") },
    ],
  });

  // Plug `adapter` into the middleware chain under test ...
  // Assert that callCount() === 2 after the retry path runs.
});
```

---

## Layer Rules

- `@koi/test` is **L0u**: it depends only on `@koi/core` and can be imported from L1 (`@koi/engine`) as well as L2 feature packages.
- It does **not** contain runtime/business logic, feature code, or framework-specific concepts.
- It does **not** depend on any test runner. Assertions use plain `Error`.
- The classification is canonical in `scripts/layers.ts` under `L0U_PACKAGES`.
