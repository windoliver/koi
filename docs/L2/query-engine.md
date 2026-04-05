# @koi/query-engine

Stream consumer and turn state machine for the model→tool→model loop.

## Layer

L2 — depends only on `@koi/core` (L0).

## Responsibility

1. **Stream consumption** — iterate over raw `ModelChunk` chunks from the model provider.
2. **Event mapping** — convert each chunk to the corresponding `EngineEvent` variant.
3. **Tool-call accumulation** — collect `tool_call_delta` fragments per `ToolCallId`, join them, and JSON-parse into a `JsonObject` on `tool_call_end`.
4. **Usage tracking** — absorb `usage` chunks internally (not yielded as events); folded into the final `done` event metrics.

## Public API

### `consumeModelStream(chunks): AsyncGenerator<EngineEvent>`

Async generator. Yields `EngineEvent`s in the same order chunks arrive.

### Types

- `AccumulatedToolCall` — completed tool call with `toolName`, `callId`, `rawArgs` (string), and `parsedArgs` (`JsonObject`).
- `StreamConsumerResult` — summary emitted with the `done` event: accumulated tool calls, usage totals.

## Error behavior

- Malformed JSON in tool-call args yields a deterministic error event (does not throw).
- The error includes the `callId` and raw string for diagnostics.

## Turn State Machine

Pure state machine driving the model→tool→model loop (#1233).

### States (TurnPhase)

`idle` → `model` → `tool_execution` → `continue` → `model` (loop) or `complete` (done)

### Public API

- `createTurnState(turnIndex?)` — factory for initial idle state.
- `transitionTurn(state, input)` — pure transition function, throws on invalid transitions.
- `runTurn(config)` — async generator that drives the turn loop via `ComposedCallHandlers`, yielding `EngineEvent`s.
- `validateToolArgs(args, descriptor)` — lightweight JSON Schema validation (allowlist-based, fail-closed on unsupported keywords).

### Types

- `TurnPhase` — `"idle" | "model" | "tool_execution" | "continue" | "complete"`
- `TurnInput` — discriminated union: `start`, `model_done`, `tools_done`, `abort`, `error`, `max_turns`
- `TurnState` — `{ phase, turnIndex, modelCalls, stopReason }`
- `TurnRunnerConfig` — `{ callHandlers, messages, signal?, maxTurns? }`

## Nameless tool call handling

When a streaming tool call closes without a function name (e.g., the provider dropped the
name token), `consumeModelStream` uses `""` (empty string) as the `toolName` fallback
rather than `"unknown"`. The turn runner filters out calls with `toolName === ""` or
`toolName === "unknown"` via the same fail-closed validation path. This produces a more
precise ATIF step (`function_name: ""`) than the legacy `"unknown"` string, which can be
confused with a tool literally named "unknown".

## Not in scope

- Agent lifecycle events (`spawn_requested`, `agent_spawned`, `agent_status_changed`) — those originate from engine internals, not the model stream.
