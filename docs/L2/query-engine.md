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
- `validateToolArgs(args, descriptor)` — lightweight JSON Schema validation (allowlist-based, fail-closed on unsupported keywords). Recognized property keywords: `type`, `description`, `title`, `default`, `items`, `properties`, `required`, plus constraint keywords (`minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minItems`, `maxItems`). Constraint keywords are recognized but not deeply validated — Zod handles runtime validation. The structural keywords (`items`, `properties`, `required`) are allowlisted so tools that declare array or object parameters pass validation; their nested contents are not deeply validated — only top-level property types are checked.

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

## Transcript format

`appendAssistantTurn` combines text content and tool-call intents into a **single** assistant
message with `metadata.toolCalls` carrying the full OpenAI-compatible `tool_calls` array.
This ensures `fixTranscriptOrdering` in the request-mapper correctly pairs tool results with
their originating tool calls. Splitting them into separate messages would cause the mapper to
clear `pendingCallIds` between the text and tool-call messages, dropping tool results as orphaned.

## Within-Turn Tool Call Dedup

`runTurn` deduplicates identical tool calls within a single model response (#1580).
When a model emits multiple tool calls with the same `toolName` and canonicalized
arguments (recursively sorted keys), only the first is executed. Subsequent duplicates
receive a replicated copy of the first call's real output in the transcript, keeping
callId pairing consistent for session-repair.

- **Scope**: within-turn only. Cross-turn duplicates are not deduped (preserves retry semantics).
- **Canonicalization**: `stableStringify` recursively sorts object keys at every nesting level.
- **Observability**: emits `{ kind: "custom", type: "dedup_skipped", data: { skipped } }` event.
- **Transcript**: all tool call intents (including skipped) appear in the assistant message;
  skipped calls get the real tool output replicated under their callId.

## Doom Loop Detection

`runTurn` detects when the model calls the same tool with identical arguments across
consecutive turns (#1593). Uses per-key streak counters (`Map<string, number>`) with
configurable threshold (default 3) and per-key intervention budgets (default 2).

### Behavior

- **All-repeated turns**: When every deduped call exceeds the streak threshold,
  the runner injects a `system:doom-loop` message and re-prompts via `stop_blocked`.
  Tool call intents and synthetic blocked results are recorded in the transcript.
- **Mixed turns**: When only some calls are repeated, the repeated calls are filtered
  out and receive synthetic results; new calls execute normally.
- **Budget reset**: Intervention budgets reset when no keys exceed the threshold
  (model moved on) or on text-only turns.

### Config

- `doomLoopThreshold` — consecutive turns before intervention (default 3, 0/1 disables)
- `maxDoomLoopInterventions` — per-key cap before letting calls through (default 2)

### Public API

- `partitionDoomLoopKeys(streaks, currentKeys, threshold)` — partition keys into repeated/non-repeated
- `updateStreaks(streaks, currentKeys)` — update streak counters (returns new Map)
- `parseDoomLoopKey(key)` — split `toolName\0canonicalArgs` key
- `DEFAULT_DOOM_LOOP_THRESHOLD`, `DEFAULT_MAX_DOOM_LOOP_INTERVENTIONS`

### Observability

- `{ kind: "custom", type: "doom_loop_detected", data: { toolNames, consecutiveTurns, turnIndex } }` — full intervention
- `{ kind: "custom", type: "doom_loop_filtered", data: { blockedTools, turnIndex } }` — mixed-turn filtering

## Not in scope

- Agent lifecycle events (`spawn_requested`, `agent_spawned`, `agent_status_changed`) — those originate from engine internals, not the model stream.
