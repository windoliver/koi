#!/usr/bin/env bun
/**
 * Manual E2E test: Spawn child agent lifecycle (#191)
 *
 * Validates with real LLM calls:
 * 1. Parent agent assembles and runs via createKoi + loopAdapter
 * 2. spawnChildAgent() creates a child with inherited tools
 * 3. Child agent runs with real model, inherits parent tools
 * 4. Child lifecycle events fire correctly (started, terminated)
 * 5. Ledger slots are acquired on spawn and released on termination
 * 6. Cascading termination: parent death kills child + releases slots
 * 7. Registry tracks parent-child relationship end-to-end
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-spawn-lifecycle.ts
 */

import type {
  ChildLifecycleEvent,
  EngineEvent,
  ModelRequest,
  Tool,
} from "../packages/core/src/index.js";
import { toolToken } from "../packages/core/src/index.js";
import { createKoi } from "../packages/engine/src/koi.js";
import { createInMemoryRegistry } from "../packages/engine/src/registry.js";
import { spawnChildAgent } from "../packages/engine/src/spawn-child.js";
import { createInMemorySpawnLedger } from "../packages/engine/src/spawn-ledger.js";
import { DEFAULT_SPAWN_POLICY } from "../packages/engine/src/types.js";
import { createLoopAdapter } from "../packages/engine-loop/src/loop-adapter.js";
import { createAnthropicAdapter } from "../packages/model-router/src/adapters/anthropic.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping.");
  process.exit(1);
}

console.log("[e2e] Starting spawn lifecycle E2E test...");
console.log("[e2e] ANTHROPIC_API_KEY: set\n");

// ---------------------------------------------------------------------------
// Test infra
// ---------------------------------------------------------------------------

interface TestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, detail?: string): void {
  results.push({ name, passed: condition, detail });
  const tag = condition ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  const suffix = detail && !condition ? ` \u2014 ${detail}` : "";
  console.log(`  ${tag}  ${name}${suffix}`);
}

function printReport(): void {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  console.log(`\n${"\u2500".repeat(60)}`);
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  console.log("\u2500".repeat(60));

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}${r.detail ? ` \u2014 ${r.detail}` : ""}`);
    }
  }
}

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Shared infra
// ---------------------------------------------------------------------------

const MODEL = "claude-haiku-4-5-20251001";
const anthropic = createAnthropicAdapter({ apiKey: API_KEY });
const modelCall = (request: ModelRequest) => anthropic.complete({ ...request, model: MODEL });

function makeLoopAdapter(maxTurns = 3): ReturnType<typeof createLoopAdapter> {
  return createLoopAdapter({ modelCall, maxTurns });
}

/** A simple tool that the parent agent will carry and the child should inherit. */
function makeGreetTool(): Tool {
  return {
    descriptor: {
      name: "greet",
      description: "Returns a greeting for the given name",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
      },
    },
    trustTier: "sandbox",
    execute: async (input: unknown) => {
      const name =
        typeof input === "object" && input !== null && "name" in input
          ? String((input as { name: unknown }).name)
          : "world";
      return { greeting: `Hello, ${name}!` };
    },
  };
}

// ===========================================================================
// Test 1: Parent agent assembles and runs with real LLM
// ===========================================================================

console.log("[test 1] Parent agent assembles and runs with real LLM");

const registry = createInMemoryRegistry();
const ledger = createInMemorySpawnLedger(20);

const parentAdapter = makeLoopAdapter(1);
const parentRuntime = await createKoi({
  manifest: {
    name: "e2e-parent",
    version: "0.1.0",
    model: { name: MODEL },
  },
  adapter: parentAdapter,
  registry,
  spawnLedger: ledger,
  loopDetection: false,
});

// Register parent in registry
registry.register({
  agentId: parentRuntime.agent.pid.id,
  status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
  agentType: "copilot",
  metadata: {},
  registeredAt: Date.now(),
});
registry.transition(parentRuntime.agent.pid.id, "running", 0, {
  kind: "assembly_complete",
});

assert(
  "parent assembled",
  parentRuntime.agent.state === "created" || parentRuntime.agent.state === "running",
);
assert("parent PID has depth 0", parentRuntime.agent.pid.depth === 0);
assert("parent is copilot", parentRuntime.agent.pid.type === "copilot");

console.log(`  Parent PID: ${parentRuntime.agent.pid.id}`);
console.log(`  Sending: "Say hello in one word."\n`);

let parentResponse = "";
const parentEvents = await collectEvents(
  parentRuntime.run({ kind: "text", text: "Say hello in one word." }),
);

for (const event of parentEvents) {
  if (event.kind === "text_delta") {
    parentResponse += event.delta;
  }
}

const parentDone = parentEvents.find((e) => e.kind === "done");
assert("parent got LLM response", parentResponse.length > 0);
assert(
  "parent completed successfully",
  parentDone?.kind === "done" && parentDone.output.stopReason === "completed",
);

console.log(`  Response: "${parentResponse.trim()}"\n`);

// ===========================================================================
// Test 2: Spawn child agent with inherited tools
// ===========================================================================

console.log("[test 2] Spawn child with inherited tools");

const greetTool = makeGreetTool();

// Attach greet tool to parent entity manually (simulates forge/provider)
const parentWithTool = {
  ...parentRuntime.agent,
  component: <T>(tok: unknown) => {
    if (tok === toolToken("greet")) return greetTool as T;
    return parentRuntime.agent.component(tok as never);
  },
  has: (tok: unknown) => tok === toolToken("greet") || parentRuntime.agent.has(tok as never),
  hasAll: (...tokens: readonly unknown[]) =>
    tokens.every((t) => t === toolToken("greet") || parentRuntime.agent.has(t as never)),
  query: <T>(prefix: string) => {
    const base = parentRuntime.agent.query<T>(prefix);
    if (prefix === "tool:") {
      const combined = new Map(base as ReadonlyMap<string, unknown>);
      combined.set(toolToken("greet") as string, greetTool);
      return combined as unknown as ReadonlyMap<
        import("../packages/core/src/index.js").SubsystemToken<T>,
        T
      >;
    }
    return base;
  },
  components: () => {
    const base = new Map(parentRuntime.agent.components());
    base.set(toolToken("greet") as string, greetTool);
    return base as ReadonlyMap<string, unknown>;
  },
};

const childAdapter = makeLoopAdapter(1);

assert("ledger starts at 0", ledger.activeCount() === 0);

const spawnResult = await spawnChildAgent({
  manifest: {
    name: "e2e-child",
    version: "0.1.0",
    model: { name: MODEL },
  },
  adapter: childAdapter,
  parentAgent: parentWithTool,
  spawnLedger: ledger,
  spawnPolicy: DEFAULT_SPAWN_POLICY,
  registry,
});

assert("child spawned", spawnResult.runtime !== undefined);
assert("child PID has depth 1", spawnResult.childPid.depth === 1);
assert("child is worker", spawnResult.childPid.type === "worker");
assert("child references parent", spawnResult.childPid.parent === parentRuntime.agent.pid.id);
assert("ledger acquired slot", ledger.activeCount() === 1);

console.log(`  Child PID: ${spawnResult.childPid.id}`);
console.log(`  Depth: ${spawnResult.childPid.depth}, Type: ${spawnResult.childPid.type}`);

// Verify inherited tool
const inheritedGreet = spawnResult.runtime.agent.component(toolToken("greet"));
assert("child inherited greet tool", inheritedGreet !== undefined);
assert("inherited tool has correct name", inheritedGreet?.descriptor.name === "greet");

// Execute inherited tool directly
if (inheritedGreet !== undefined) {
  const toolResult = await inheritedGreet.execute({ name: "Koi" });
  const greeting = (toolResult as { greeting: string }).greeting;
  assert("inherited tool executes correctly", greeting === "Hello, Koi!");
  console.log(`  Tool result: ${greeting}`);
}

console.log();

// ===========================================================================
// Test 3: Child agent runs with real LLM
// ===========================================================================

console.log("[test 3] Child agent runs with real LLM");

// Transition child to running
registry.transition(spawnResult.childPid.id, "running", 0, {
  kind: "assembly_complete",
});

const childEvents: ChildLifecycleEvent[] = [];
spawnResult.handle.onEvent((e) => childEvents.push(e));

console.log(`  Sending: "Say goodbye in one word."\n`);

let childResponse = "";
const childRunEvents = await collectEvents(
  spawnResult.runtime.run({ kind: "text", text: "Say goodbye in one word." }),
);

for (const event of childRunEvents) {
  if (event.kind === "text_delta") {
    childResponse += event.delta;
  }
}

const childDone = childRunEvents.find((e) => e.kind === "done");
assert("child got LLM response", childResponse.length > 0);
assert(
  "child completed successfully",
  childDone?.kind === "done" && childDone.output.stopReason === "completed",
);

console.log(`  Response: "${childResponse.trim()}"`);

if (childDone?.kind === "done") {
  console.log(
    `  Tokens: ${childDone.output.metrics.inputTokens} in / ${childDone.output.metrics.outputTokens} out`,
  );
}

console.log();

// ===========================================================================
// Test 4: Registry tracks parent-child relationship
// ===========================================================================

console.log("[test 4] Registry tracks parent-child relationship");

const childEntry = registry.lookup(spawnResult.childPid.id);
assert("child is registered", childEntry !== undefined);
assert("child parentId matches parent", childEntry?.parentId === parentRuntime.agent.pid.id);
assert("child agentType is worker", childEntry?.agentType === "worker");

const parentEntry = registry.lookup(parentRuntime.agent.pid.id);
assert("parent is registered", parentEntry !== undefined);
assert("parent is running", parentEntry?.status.phase === "running");

console.log(`  Parent: ${parentRuntime.agent.pid.id} (${parentEntry?.status.phase})`);
console.log(`  Child:  ${spawnResult.childPid.id} (${childEntry?.status.phase})`);
console.log(`  Child.parentId: ${childEntry?.parentId}`);
console.log();

// ===========================================================================
// Test 5: Ledger released on child termination
// ===========================================================================

console.log("[test 5] Ledger released on child termination");

assert("ledger has 1 active slot before terminate", ledger.activeCount() === 1);

registry.transition(spawnResult.childPid.id, "terminated", 1, {
  kind: "completed",
});

assert("ledger released after child terminated", ledger.activeCount() === 0);
assert(
  "child lifecycle event fired: terminated",
  childEvents.some((e) => e.kind === "terminated"),
);

console.log(`  Ledger active: ${ledger.activeCount()}`);
console.log(`  Lifecycle events: ${childEvents.map((e) => e.kind).join(", ")}`);
console.log();

// ===========================================================================
// Test 6: Cascading termination — parent death kills child
// ===========================================================================

console.log("[test 6] Cascading termination: parent death kills child");

// Spawn a new child for cascade test
const child2Adapter = makeLoopAdapter(1);
const child2 = await spawnChildAgent({
  manifest: {
    name: "e2e-child-cascade",
    version: "0.1.0",
    model: { name: MODEL },
  },
  adapter: child2Adapter,
  parentAgent: parentWithTool,
  spawnLedger: ledger,
  spawnPolicy: DEFAULT_SPAWN_POLICY,
  registry,
});

registry.transition(child2.childPid.id, "running", 0, {
  kind: "assembly_complete",
});

const cascadeEvents: ChildLifecycleEvent[] = [];
child2.handle.onEvent((e) => cascadeEvents.push(e));

assert("child2 spawned and running", ledger.activeCount() === 1);

console.log(`  Child2 PID: ${child2.childPid.id}`);
console.log(`  Terminating parent...`);

// Kill the parent — child should cascade-terminate
registry.transition(parentRuntime.agent.pid.id, "terminated", 1, {
  kind: "completed",
});

const child2Entry = registry.lookup(child2.childPid.id);
assert("child2 cascade-terminated when parent died", child2Entry?.status.phase === "terminated");
assert("ledger released after cascade", ledger.activeCount() === 0);
assert(
  "cascade event fired on child2",
  cascadeEvents.some((e) => e.kind === "terminated"),
);

console.log(`  Child2 phase: ${child2Entry?.status.phase}`);
console.log(`  Ledger active: ${ledger.activeCount()}`);
console.log(`  Cascade events: ${cascadeEvents.map((e) => e.kind).join(", ")}`);
console.log();

// ===========================================================================
// Test 7: Multiple children + ledger accounting
// ===========================================================================

console.log("[test 7] Multiple children + ledger accounting");

const registry2 = createInMemoryRegistry();
const ledger2 = createInMemorySpawnLedger(20);

// Create a fresh parent
const parent2Adapter = makeLoopAdapter(1);
const parent2 = await createKoi({
  manifest: {
    name: "e2e-parent-2",
    version: "0.1.0",
    model: { name: MODEL },
  },
  adapter: parent2Adapter,
  registry: registry2,
  spawnLedger: ledger2,
  loopDetection: false,
});

registry2.register({
  agentId: parent2.agent.pid.id,
  status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
  agentType: "copilot",
  metadata: {},
  registeredAt: Date.now(),
});
registry2.transition(parent2.agent.pid.id, "running", 0, { kind: "assembly_complete" });

// Spawn 3 children
const children = await Promise.all(
  [1, 2, 3].map(async (i) => {
    const childResult = await spawnChildAgent({
      manifest: {
        name: `e2e-multi-child-${i}`,
        version: "0.1.0",
        model: { name: MODEL },
      },
      adapter: makeLoopAdapter(1),
      parentAgent: parent2.agent,
      spawnLedger: ledger2,
      spawnPolicy: DEFAULT_SPAWN_POLICY,
      registry: registry2,
    });
    registry2.transition(childResult.childPid.id, "running", 0, {
      kind: "assembly_complete",
    });
    return childResult;
  }),
);

assert("3 children spawned", children.length === 3);
assert("ledger has 3 active slots", ledger2.activeCount() === 3);

// Terminate children one by one
for (let i = 0; i < children.length; i++) {
  const child = children[i];
  if (child === undefined) continue;
  registry2.transition(child.childPid.id, "terminated", 1, {
    kind: "completed",
  });
  assert(`ledger after child ${i + 1} terminated: ${2 - i}`, ledger2.activeCount() === 2 - i);
}

assert("ledger fully drained", ledger2.activeCount() === 0);
console.log();

// Cleanup
await registry2[Symbol.asyncDispose]();
await parent2.dispose();

// ===========================================================================
// Test 8: Runtime disposal on termination (adapter resource cleanup)
// ===========================================================================

console.log("[test 8] Runtime disposal on termination");

const registry3 = createInMemoryRegistry();
const ledger3 = createInMemorySpawnLedger(20);

// Fresh parent for disposal test
const parent3Adapter = makeLoopAdapter(1);
const parent3 = await createKoi({
  manifest: {
    name: "e2e-parent-3",
    version: "0.1.0",
    model: { name: MODEL },
  },
  adapter: parent3Adapter,
  registry: registry3,
  spawnLedger: ledger3,
  loopDetection: false,
});

registry3.register({
  agentId: parent3.agent.pid.id,
  status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
  agentType: "copilot",
  metadata: {},
  registeredAt: Date.now(),
});
registry3.transition(parent3.agent.pid.id, "running", 0, { kind: "assembly_complete" });

// Track disposal via a wrapper
// let justified: mutable flag to track dispose call from termination handler
let disposeCalledByTermination = false;
const childAdapterForDisposal = makeLoopAdapter(1);
const originalDispose = childAdapterForDisposal.dispose;
childAdapterForDisposal.dispose = async () => {
  disposeCalledByTermination = true;
  await originalDispose?.();
};

const disposalChild = await spawnChildAgent({
  manifest: {
    name: "e2e-child-disposal",
    version: "0.1.0",
    model: { name: MODEL },
  },
  adapter: childAdapterForDisposal,
  parentAgent: parent3.agent,
  spawnLedger: ledger3,
  spawnPolicy: DEFAULT_SPAWN_POLICY,
  registry: registry3,
});

registry3.transition(disposalChild.childPid.id, "running", 0, { kind: "assembly_complete" });

assert("dispose not called before termination", !disposeCalledByTermination);

// Terminate child — should trigger automatic disposal
registry3.transition(disposalChild.childPid.id, "terminated", 1, { kind: "completed" });

// Allow async dispose to settle
await new Promise((resolve) => setTimeout(resolve, 50));

assert("runtime.dispose() called on child termination", disposeCalledByTermination);
assert("ledger released after disposal", ledger3.activeCount() === 0);

console.log(`  Dispose called: ${disposeCalledByTermination}`);
console.log(`  Ledger active: ${ledger3.activeCount()}`);
console.log();

// Test cascade disposal too
// let justified: mutable flag to track cascade dispose
let cascadeDisposeCalled = false;
const cascadeChildAdapter = makeLoopAdapter(1);
const cascadeOrigDispose = cascadeChildAdapter.dispose;
cascadeChildAdapter.dispose = async () => {
  cascadeDisposeCalled = true;
  await cascadeOrigDispose?.();
};

const cascadeDisposalChild = await spawnChildAgent({
  manifest: {
    name: "e2e-child-cascade-disposal",
    version: "0.1.0",
    model: { name: MODEL },
  },
  adapter: cascadeChildAdapter,
  parentAgent: parent3.agent,
  spawnLedger: ledger3,
  spawnPolicy: DEFAULT_SPAWN_POLICY,
  registry: registry3,
});

registry3.transition(cascadeDisposalChild.childPid.id, "running", 0, { kind: "assembly_complete" });

assert("cascade dispose not called before parent death", !cascadeDisposeCalled);

// Kill parent — cascade should dispose child
registry3.transition(parent3.agent.pid.id, "terminated", 1, { kind: "completed" });

// Allow async dispose to settle
await new Promise((resolve) => setTimeout(resolve, 50));

assert("runtime.dispose() called on cascade termination", cascadeDisposeCalled);
assert("ledger released after cascade disposal", ledger3.activeCount() === 0);

console.log(`  Cascade dispose called: ${cascadeDisposeCalled}`);
console.log(`  Ledger active: ${ledger3.activeCount()}`);
console.log();

// Cleanup
await registry3[Symbol.asyncDispose]();
await parent3.dispose();

// ===========================================================================
// Cleanup
// ===========================================================================

await registry[Symbol.asyncDispose]();
await parentRuntime.dispose();
await spawnResult.runtime.dispose();
await child2.runtime.dispose();

// ===========================================================================
// Report
// ===========================================================================

printReport();

const failed = results.filter((r) => !r.passed).length;
if (failed > 0) {
  process.exit(1);
}

console.log("\n[e2e] SPAWN LIFECYCLE E2E VALIDATION PASSED");
