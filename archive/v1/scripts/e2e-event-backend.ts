#!/usr/bin/env bun

/**
 * E2E test script for @koi/events-memory — validates the InMemoryEventBackend
 * works end-to-end with real LLM engine events flowing through it.
 *
 * Exercises:
 *   1. Append engine events to a stream during a real LLM call
 *   2. Subscribe to a stream and receive events in real-time
 *   3. Replay events from a checkpoint after the run completes
 *   4. Type filtering — subscribe to specific event types only
 *   5. Dead letter queue — failing subscription handler → retry → DLQ
 *   6. DLQ retry — re-deliver a dead-lettered event
 *   7. Stream metadata — streamLength, firstSequence
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... bun scripts/e2e-event-backend.ts
 */

import { createLoopAdapter } from "../packages/drivers/engine-loop/src/loop-adapter.js";
import { createAnthropicAdapter } from "../packages/drivers/model-router/src/adapters/anthropic.js";
import { createInMemoryEventBackend } from "../packages/fs/events-memory/src/memory-backend.js";
import type { EngineEvent, ModelRequest } from "../packages/kernel/core/src/engine.js";
import type { EventEnvelope, EventInput } from "../packages/kernel/core/src/event-backend.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping E2E tests.");
  process.exit(0);
}

console.log("[e2e] Starting event-backend E2E tests...");
console.log("[e2e] ANTHROPIC_API_KEY: set\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestResult {
  readonly name: string;
  readonly passed: boolean;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean): void {
  results.push({ name, passed: condition });
  const tag = condition ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag}  ${name}`);
}

async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const anthropicAdapter = createAnthropicAdapter({
  apiKey: API_KEY,
});

const modelCall = (request: ModelRequest) =>
  anthropicAdapter.complete({ ...request, model: "claude-3-haiku-20240307" });

// ---------------------------------------------------------------------------
// Test 1 — Append engine events during a real LLM call
// ---------------------------------------------------------------------------

console.log("[test 1] Append engine events during a real LLM call");

const test1Backend = createInMemoryEventBackend();
const STREAM_ID = "e2e:agent-run-1";

const test1Events = await withTimeout(
  async () => {
    const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });
    const collected: EngineEvent[] = [];

    for await (const event of adapter.stream({
      kind: "text",
      text: "Reply with exactly one word: hello",
    })) {
      collected.push(event);

      // Append each engine event to the EventBackend
      const input: EventInput = {
        type: `engine:${event.kind}`,
        data: event,
      };
      const result = await test1Backend.append(STREAM_ID, input);
      if (!result.ok) {
        console.error(`  [ERROR] append failed: ${result.error.message}`);
      }
    }

    return collected;
  },
  60_000,
  "Test 1",
);

const streamLen = await test1Backend.streamLength(STREAM_ID);
assert("engine events appended to stream", streamLen > 0);
assert("streamLength matches collected events", streamLen === test1Events.length);

// Verify first sequence starts at 1
const firstSeq = await test1Backend.firstSequence(STREAM_ID);
assert("firstSequence is 1", firstSeq === 1);

// Read back all events
const readResult = await test1Backend.read(STREAM_ID);
assert("read succeeds", readResult.ok);
if (readResult.ok) {
  assert("read returns all events", readResult.value.events.length === test1Events.length);
  assert("events have monotonic sequences", verifyMonotonicSequences(readResult.value.events));

  // Verify done event is present
  const doneEvent = readResult.value.events.find((e) => e.type === "engine:done");
  assert("done event present in stream", doneEvent !== undefined);
}

test1Backend.close();

// ---------------------------------------------------------------------------
// Test 2 — Real-time subscription delivery
// ---------------------------------------------------------------------------

console.log("\n[test 2] Real-time subscription delivery");

const test2Backend = createInMemoryEventBackend();
const SUB_STREAM = "e2e:agent-run-2";
const delivered: EventEnvelope[] = [];

// Subscribe BEFORE appending
const handle = await test2Backend.subscribe({
  streamId: SUB_STREAM,
  subscriptionName: "e2e-realtime-sub",
  fromPosition: 0,
  handler: (event) => {
    delivered.push(event);
  },
});

// Run a real LLM call and append events
await withTimeout(
  async () => {
    const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

    for await (const event of adapter.stream({
      kind: "text",
      text: "What is 2+2? Reply with just the number.",
    })) {
      await test2Backend.append(SUB_STREAM, {
        type: `engine:${event.kind}`,
        data: event,
      });
    }
  },
  60_000,
  "Test 2",
);

// Allow async delivery to settle
await new Promise((resolve) => setTimeout(resolve, 200));

const subStreamLen = await test2Backend.streamLength(SUB_STREAM);
assert("subscription received events", delivered.length > 0);
assert("subscription received all events", delivered.length === subStreamLen);

// Position should match the last delivered event sequence
const pos = handle.position();
assert("subscription position tracks last event", pos === subStreamLen);

handle.unsubscribe();
test2Backend.close();

// ---------------------------------------------------------------------------
// Test 3 — Replay from checkpoint
// ---------------------------------------------------------------------------

console.log("\n[test 3] Replay from checkpoint");

const test3Backend = createInMemoryEventBackend();
const REPLAY_STREAM = "e2e:agent-run-3";

// Append some events from a real LLM run
await withTimeout(
  async () => {
    const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

    for await (const event of adapter.stream({
      kind: "text",
      text: "Say the word 'banana' and nothing else.",
    })) {
      await test3Backend.append(REPLAY_STREAM, {
        type: `engine:${event.kind}`,
        data: event,
      });
    }
  },
  60_000,
  "Test 3 append",
);

const totalEvents = await test3Backend.streamLength(REPLAY_STREAM);
assert("replay stream has events", totalEvents > 0);

// Simulate replay from checkpoint — subscribe starting from position 2
const replayed: EventEnvelope[] = [];
const replayHandle = await test3Backend.subscribe({
  streamId: REPLAY_STREAM,
  subscriptionName: "e2e-replay-sub",
  fromPosition: 2, // Skip first 2 events
  handler: (event) => {
    replayed.push(event);
  },
});

// Allow replay delivery to settle
await new Promise((resolve) => setTimeout(resolve, 200));

assert("replay starts from checkpoint", replayed.length === totalEvents - 2);
if (replayed.length > 0) {
  assert("first replayed event has sequence 3", (replayed[0]?.sequence ?? 0) === 3);
}

replayHandle.unsubscribe();
test3Backend.close();

// ---------------------------------------------------------------------------
// Test 4 — Type filtering
// ---------------------------------------------------------------------------

console.log("\n[test 4] Type filtering");

const test4Backend = createInMemoryEventBackend();
const FILTER_STREAM = "e2e:agent-run-4";
const textDeltas: EventEnvelope[] = [];

// Subscribe to only text_delta events
const filterHandle = await test4Backend.subscribe({
  streamId: FILTER_STREAM,
  subscriptionName: "e2e-type-filter-sub",
  fromPosition: 0,
  types: ["engine:text_delta"],
  handler: (event) => {
    textDeltas.push(event);
  },
});

// Run a real LLM call
await withTimeout(
  async () => {
    const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

    for await (const event of adapter.stream({
      kind: "text",
      text: "Reply with: OK",
    })) {
      await test4Backend.append(FILTER_STREAM, {
        type: `engine:${event.kind}`,
        data: event,
      });
    }
  },
  60_000,
  "Test 4",
);

await new Promise((resolve) => setTimeout(resolve, 200));

const filterStreamLen = await test4Backend.streamLength(FILTER_STREAM);
assert("type filter delivers fewer events than total", textDeltas.length < filterStreamLen);
assert(
  "all delivered events are text_delta",
  textDeltas.every((e) => e.type === "engine:text_delta"),
);
assert("at least one text_delta received", textDeltas.length > 0);

// Also test read with type filter
const readFiltered = await test4Backend.read(FILTER_STREAM, { types: ["engine:text_delta"] });
assert("read with type filter works", readFiltered.ok);
if (readFiltered.ok) {
  assert(
    "read filter matches subscription filter count",
    readFiltered.value.events.length === textDeltas.length,
  );
}

filterHandle.unsubscribe();
test4Backend.close();

// ---------------------------------------------------------------------------
// Test 5 — Dead letter queue with failing handler
// ---------------------------------------------------------------------------

console.log("\n[test 5] Dead letter queue with failing handler");

const test5Backend = createInMemoryEventBackend();
const DLQ_STREAM = "e2e:agent-run-5";
const dlqEntries: string[] = [];

// Subscribe with a handler that always fails
const dlqHandle = await test5Backend.subscribe({
  streamId: DLQ_STREAM,
  subscriptionName: "e2e-dlq-sub",
  fromPosition: 0,
  maxRetries: 2,
  handler: () => {
    throw new Error("simulated failure");
  },
  onDeadLetter: (entry) => {
    dlqEntries.push(entry.id);
  },
});

// Append a single event
await test5Backend.append(DLQ_STREAM, {
  type: "engine:text_delta",
  data: { kind: "text_delta", delta: "test" },
});

// Allow retry + DLQ delivery to settle
await new Promise((resolve) => setTimeout(resolve, 300));

assert("onDeadLetter callback fired", dlqEntries.length === 1);

// Query the DLQ
const dlqResult = await test5Backend.queryDeadLetters({ subscriptionName: "e2e-dlq-sub" });
assert("queryDeadLetters returns entry", dlqResult.ok);
if (dlqResult.ok) {
  assert("DLQ has 1 entry", dlqResult.value.length === 1);
  const entry = dlqResult.value[0];
  if (entry !== undefined) {
    assert("DLQ entry has correct error", entry.error === "simulated failure");
    assert("DLQ entry records 2 attempts", entry.attempts === 2);
  }
}

dlqHandle.unsubscribe();
test5Backend.close();

// ---------------------------------------------------------------------------
// Test 6 — DLQ retry
// ---------------------------------------------------------------------------

console.log("\n[test 6] DLQ retry");

const test6Backend = createInMemoryEventBackend();
const RETRY_STREAM = "e2e:agent-run-6";
// let: mutated across handler invocations to control failure/success
let failCount = 0;
const retryDelivered: EventEnvelope[] = [];

// Subscribe with a handler that fails first, succeeds on retry
await test6Backend.subscribe({
  streamId: RETRY_STREAM,
  subscriptionName: "e2e-retry-sub",
  fromPosition: 0,
  maxRetries: 1, // Fail immediately (1 attempt → DLQ)
  handler: (event) => {
    if (failCount < 1) {
      failCount++;
      throw new Error("first-time failure");
    }
    retryDelivered.push(event);
  },
});

// Append event — will fail and land in DLQ
await test6Backend.append(RETRY_STREAM, {
  type: "engine:text_delta",
  data: { kind: "text_delta", delta: "retry-me" },
});

await new Promise((resolve) => setTimeout(resolve, 200));
assert("event landed in DLQ", failCount === 1);

// Get the DLQ entry ID
const dlq6 = await test6Backend.queryDeadLetters({ subscriptionName: "e2e-retry-sub" });
assert("DLQ has entry for retry", dlq6.ok && dlq6.value.length === 1);

if (dlq6.ok && dlq6.value.length > 0) {
  const entryId = dlq6.value[0]?.id;
  if (entryId !== undefined) {
    // Retry — handler should now succeed
    const retryResult = await test6Backend.retryDeadLetter(entryId);
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert("retryDeadLetter returns ok", retryResult.ok === true);
    assert("retried event delivered successfully", retryDelivered.length === 1);
  }
}

test6Backend.close();

// ---------------------------------------------------------------------------
// Test 7 — FIFO eviction with real events
// ---------------------------------------------------------------------------

console.log("\n[test 7] FIFO eviction with real events");

const test7Backend = createInMemoryEventBackend({ maxEventsPerStream: 3 });
const EVICT_STREAM = "e2e:eviction";

// Append 5 events — only last 3 should survive
for (let i = 1; i <= 5; i++) {
  await test7Backend.append(EVICT_STREAM, {
    type: "engine:text_delta",
    data: { index: i },
  });
}

const evictLen = await test7Backend.streamLength(EVICT_STREAM);
assert("FIFO eviction caps at maxEventsPerStream", evictLen === 3);

const evictFirst = await test7Backend.firstSequence(EVICT_STREAM);
assert("firstSequence reflects eviction", evictFirst === 3);

test7Backend.close();

// ---------------------------------------------------------------------------
// Test 8 — Multiple independent subscriptions
// ---------------------------------------------------------------------------

console.log("\n[test 8] Multiple independent subscriptions");

const test8Backend = createInMemoryEventBackend();
const MULTI_STREAM = "e2e:multi-sub";
const sub1Events: EventEnvelope[] = [];
const sub2Events: EventEnvelope[] = [];

const h1 = await test8Backend.subscribe({
  streamId: MULTI_STREAM,
  subscriptionName: "e2e-sub-1",
  fromPosition: 0,
  handler: (event) => {
    sub1Events.push(event);
  },
});

const h2 = await test8Backend.subscribe({
  streamId: MULTI_STREAM,
  subscriptionName: "e2e-sub-2",
  fromPosition: 0,
  types: ["engine:done"], // Only done events
  handler: (event) => {
    sub2Events.push(event);
  },
});

// Run a real LLM call
await withTimeout(
  async () => {
    const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

    for await (const event of adapter.stream({
      kind: "text",
      text: "Reply with: OK",
    })) {
      await test8Backend.append(MULTI_STREAM, {
        type: `engine:${event.kind}`,
        data: event,
      });
    }
  },
  60_000,
  "Test 8",
);

await new Promise((resolve) => setTimeout(resolve, 200));

const multiStreamLen = await test8Backend.streamLength(MULTI_STREAM);
assert("sub-1 receives all events", sub1Events.length === multiStreamLen);
assert("sub-2 receives only done events", sub2Events.length === 1);
assert("sub-2 event is done type", sub2Events[0]?.type === "engine:done");
// Both subs advance to the end — sub-2 skips non-matching events but still advances position
assert(
  "both subscriptions reach final position",
  h1.position() === multiStreamLen && h2.position() === multiStreamLen,
);

h1.unsubscribe();
h2.unsubscribe();
test8Backend.close();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function verifyMonotonicSequences(events: readonly EventEnvelope[]): boolean {
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const curr = events[i];
    if (prev === undefined || curr === undefined) return false;
    if (curr.sequence <= prev.sequence) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.passed).length;
const total = results.length;
const allPassed = passed === total;

console.log(`\n[e2e] Results: ${passed}/${total} passed`);

if (!allPassed) {
  console.error("\n[e2e] Failed assertions:");
  for (const r of results) {
    if (!r.passed) {
      console.error(`  FAIL  ${r.name}`);
    }
  }
  process.exit(1);
}

console.log("\n[e2e] All event-backend E2E tests passed!");
