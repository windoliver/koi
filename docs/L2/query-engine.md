# @koi/query-engine

Stream consumer that maps `AsyncIterable<ModelChunk>` to `AsyncGenerator<EngineEvent>`, accumulating streamed tool-call argument deltas into parsed payloads.

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

## Not in scope

- Turn lifecycle (handled by #1233 turn state machine).
- Tool execution — this package only reassembles the request payload.
- Agent lifecycle events (`spawn_requested`, `agent_spawned`, `agent_status_changed`) — those originate from engine internals, not the model stream.
