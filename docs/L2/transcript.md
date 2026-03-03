# Durable Session Transcript — Crash Recovery via Append-Only Message Log

Automatic conversation durability for Koi agents. Every turn is appended to a JSONL log. On crash, the full conversation history is replayed — no messages lost.

---

## Why It Exists

Koi's existing `SessionCheckpoint` stores opaque `EngineState.data` snapshots, but **no actual conversation history**. If the engine adapter doesn't implement `saveState()`/`loadState()`, messages are gone on crash. This is the common case — most adapters have neither.

Without transcript:

1. **Messages lost on crash** — agent restarts with empty context, loses all progress
2. **No conversation replay** — cannot resume where you left off after OOM, deploy, or power failure
3. **Checkpoint-only recovery** — only works if the engine adapter implements state serialization (rare)

With transcript:

1. **Every turn persisted** — user messages, assistant responses, tool calls, and results
2. **Engine-agnostic** — works with any adapter, no `saveState()` required
3. **Crash recovery in one line** — `onRecover` receives the full history, feeds it back to the engine
4. **Coexists with checkpoints** — transcript and checkpoint decorators stack independently

---

## Architecture

The transcript system spans three layers:

```
L0  @koi/core            SessionTranscript interface + TranscriptEntry types
L0u @koi/transcript      JSONL and in-memory backends (Phase 1)
L2  @koi/node            Engine decorator + NodeDeps wiring (Phase 2-3)
```

### Data Flow

```
User input
  │
  ▼
┌─────────────────────────────────────────────────┐
│  createTranscriptingEngine (decorator)          │
│                                                 │
│  1. Capture input → user entry → fireAppend()   │
│  2. Pass through to inner engine                │
│  3. Accumulate text_delta → assistant text       │
│  4. Capture tool_call_start → tool_call entry    │
│  5. Capture tool_call_end → tool_result entry    │
│  6. On turn_end/done → flush all → fireAppend() │
│                                                 │
│  fireAppend() is fire-and-forget: failures are  │
│  swallowed, never block the event stream.       │
└─────────────┬───────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────┐
│  SessionTranscript (L0 interface)               │
│                                                 │
│  .append(sessionId, entries)                    │
│  .load(sessionId) → entries + skipped           │
│  .compact(sessionId, summary, preserveN)        │
│  .remove(sessionId)                             │
└─────────────────────────────────────────────────┘
              │
              ▼
        JSONL file / in-memory store
```

### Decorator Stacking

When both transcript and checkpoint are enabled, they stack transparently:

```
EngineInput
  → createCheckpointingEngine (outer)
    → createTranscriptingEngine (inner)
      → actual engine adapter
        ← EngineEvent stream
      ← transcript append (fire-and-forget)
    ← checkpoint callback (fire-and-forget)
```

Both decorators yield events unmodified — consumers see the same stream regardless of which decorators are active.

---

## What This Enables

### 1. Automatic Conversation Durability

Pass a transcript store to `createNode()` and every dispatched agent's conversation is persisted automatically. No changes to engine adapters, middleware, or manifests.

### 2. Crash Recovery with Full History

On restart, `onRecover` receives `transcriptEntries` — the complete conversation history. The caller converts them back to engine input and resumes where the agent left off.

### 3. Complete Conversation Record

Not just user/assistant text — tool calls and results are captured too. The transcript is a faithful record of every interaction, useful for debugging, auditing, and replay.

### 4. Engine-Agnostic Recovery

Unlike checkpoint-based recovery (which requires `saveState()`/`loadState()` in each adapter), transcript recovery works with any engine. The conversation history is the recovery mechanism, not opaque engine state.

---

## Quick Start

### Basic Setup

```typescript
import { createNode } from "@koi/node";
import { createJsonlTranscript } from "@koi/transcript";

const transcript = createJsonlTranscript({ dir: "./sessions" });

const node = createNode(config, {
  sessionStore: myStore,
  transcript,
  onRecover: (session, checkpoint, transcriptEntries) => {
    // transcriptEntries contains the full conversation history
    // Convert to InboundMessage[] and feed back to the engine
    return { pid, engine: createMyEngine() };
  },
});
```

### Recovery with Replay

```typescript
onRecover: (session, checkpoint, transcriptEntries) => {
  if (!transcriptEntries || transcriptEntries.length === 0) {
    return null; // Nothing to recover
  }

  const engine = createMyEngine();

  // Replay transcript as initial messages
  const messages = transcriptEntries
    .filter((e) => e.role === "user" || e.role === "assistant")
    .map((e) => ({
      content: [{ kind: "text" as const, text: e.content }],
      senderId: e.role === "user" ? "user" : "assistant",
      timestamp: e.timestamp,
    }));

  // Engine receives full history on first input
  return { pid, engine, providers: [] };
}
```

### In-Memory Transcript (for Tests)

```typescript
import { createInMemoryTranscript } from "@koi/transcript";

const transcript = createInMemoryTranscript();
// Same interface, entries stored in memory — perfect for unit tests
```

---

## API Reference

### `createTranscriptingEngine(inner, config)`

Wraps an `EngineAdapter` to auto-append transcript entries.

| Parameter | Type | Description |
|-----------|------|-------------|
| `inner` | `EngineAdapter` | The engine to wrap |
| `config.sessionId` | `SessionId` | Session identifier for this agent |
| `config.transcript` | `SessionTranscript` | Backend store to append entries to |

**Returns:** `EngineAdapter` — decorated adapter with identical interface.

### `NodeDeps.transcript`

Optional dependency injected into `createNode()`.

```typescript
interface NodeDeps {
  readonly transcript?: SessionTranscript;
  readonly onRecover?: (
    session: SessionRecord,
    checkpoint: SessionCheckpoint | undefined,
    transcriptEntries?: readonly TranscriptEntry[],
  ) => RecoveryResult | null | Promise<RecoveryResult | null>;
}
```

### TranscriptEntry Roles

| Role | Captured From | Content |
|------|--------------|---------|
| `user` | `EngineInput.text` or `EngineInput.messages` | Plain text |
| `assistant` | Accumulated `text_delta` events | Plain text |
| `tool_call` | `tool_call_start` event | JSON: `{ toolName, callId, args }` |
| `tool_result` | `tool_call_end` event | JSON: `{ callId, result }` |
| `system` | (not auto-captured) | Caller-provided |
| `compaction` | `compact()` operation | Summary text |

---

## Design Decisions

### Why an Engine Decorator, Not Middleware?

Middleware only sees processed turns — it doesn't have access to raw `EngineInput` or the full `EngineEvent` stream. The engine decorator wraps `stream()` directly, seeing both the input and every event. This is the same pattern used by `createCheckpointingEngine`.

### Why Fire-and-Forget?

Transcript writes must never block the agent. If the disk is full or the store is slow, the conversation continues. This matches the checkpoint behavior — persistence is best-effort, never blocking.

### Why Coexist with Checkpoints?

Transcript and checkpoint serve different purposes:
- **Transcript** captures conversation history (what was said)
- **Checkpoint** captures engine state (internal model context, thread IDs, etc.)

Both are useful. Transcript enables recovery for any engine. Checkpoint enables stateful resume for engines that support it. They're independent and stack cleanly.

### Why `resume` Input Skips User Entry?

`EngineInput { kind: "resume" }` is an engine state restore — there's no user message to capture. The decorator only creates user entries for `text` and `messages` inputs.

---

## Layer Compliance

- [x] `SessionTranscript` interface lives in `@koi/core` (L0) — zero dependencies
- [x] JSONL/in-memory backends live in `@koi/transcript` (L0u) — depends only on `@koi/core` + `@koi/errors`
- [x] Engine decorator lives in `@koi/node` (L2) — imports only from `@koi/core`
- [x] No vendor types in any layer
- [x] All interface properties are `readonly`
- [x] `SessionTranscript` methods return `T | Promise<T>` for sync/async flexibility

---

## Performance Characteristics

| Operation | Cost | Blocking? |
|-----------|------|-----------|
| Append per turn | 1 JSONL write (~1-5 KB) | No (fire-and-forget) |
| Load on recovery | Sequential file read | Yes (startup only) |
| Compact | Read + rewrite file | Yes (explicit call) |
| Memory overhead | ~200 bytes per decorator instance | Negligible |

The decorator adds zero latency to the event stream. All I/O is fire-and-forget via `void promise.catch()`. The only blocking operation is `load()` during crash recovery at startup.

---

## Related

- **Issue**: [#736](https://github.com/windoliver/koi/issues/736) — Durable session transcript
- **L0 types**: `packages/core/src/transcript.ts`
- **Backends**: `packages/transcript/` (JSONL + in-memory)
- **Engine decorator**: `packages/node/src/transcripting-engine.ts`
- **Tests**: `packages/node/src/transcripting-engine.test.ts`
- **Checkpoint decorator**: `packages/node/src/checkpointing-engine.ts` (same pattern)
