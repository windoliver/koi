/**
 * E2E lifecycle governance tests — validates Issue #393 features with real
 * Anthropic LLM calls through the full createKoi + createPiAdapter pipeline.
 *
 * Tests:
 *   1. Manifest lifecycle field drives PID agentType
 *   2. Parent spawns a worker child that makes real LLM calls
 *   3. Parent spawns a copilot child — copilot survives parent termination
 *   4. Cascading termination kills workers, spares copilots
 *   5. ChildHandle.signal() delivers to child and fires signaled event
 *   6. ChildHandle.terminate() CAS-transitions child to terminated
 *   7. Spawner lineage tracked through ProcessTree
 *   8. Completed/error events fire before terminated event
 *   9. Middleware chain fires correctly in parent and child
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-lifecycle-governance.test.ts
 *
 * Requires ANTHROPIC_API_KEY in .env (auto-loaded by Bun).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  ChildLifecycleEvent,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  Tool,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createPiAdapter } from "@koi/engine-pi";
import { createCascadingTermination } from "../cascading-termination.js";
import { createKoi } from "../koi.js";
import { createProcessTree } from "../process-tree.js";
import type { InMemoryRegistry } from "../registry.js";
import { createInMemoryRegistry } from "../registry.js";
import { spawnChildAgent } from "../spawn-child.js";
import { createInMemorySpawnLedger } from "../spawn-ledger.js";
import { DEFAULT_SPAWN_POLICY } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

function testManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    name: "E2E Lifecycle Agent",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const MULTIPLY_TOOL: Tool = {
  descriptor: {
    name: "multiply",
    description: "Multiplies two numbers together and returns the product.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  },
  trustTier: "sandbox",
  execute: async (input: Readonly<Record<string, unknown>>) => {
    const a = Number(input.a ?? 0);
    const b = Number(input.b ?? 0);
    return String(a * b);
  },
};

const ECHO_TOOL: Tool = {
  descriptor: {
    name: "echo",
    description: "Echoes back the input message verbatim. Useful for testing.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message to echo" },
      },
      required: ["message"],
    },
  },
  trustTier: "sandbox",
  execute: async (input: Readonly<Record<string, unknown>>) => {
    return String(input.message ?? "");
  },
};

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-lifecycle-tool-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

function createAdapter(systemPrompt?: string): ReturnType<typeof createPiAdapter> {
  return createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: systemPrompt ?? "You are a concise assistant. Reply briefly.",
    getApiKey: async () => ANTHROPIC_KEY,
  });
}

/** Microtask flush — allows async cascade to settle. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: lifecycle governance with real LLM", () => {
  let registry: InMemoryRegistry;

  beforeEach(() => {
    registry = createInMemoryRegistry();
  });

  afterEach(async () => {
    await registry[Symbol.asyncDispose]();
  });

  // ── Test 1: manifest.lifecycle drives PID agentType ───────────────────

  test(
    "manifest lifecycle='copilot' produces copilot PID via createKoi",
    async () => {
      const adapter = createAdapter();

      const runtime = await createKoi({
        manifest: testManifest({ lifecycle: "copilot" }),
        adapter,
        loopDetection: false,
      });

      expect(runtime.agent.pid.type).toBe("copilot");

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: lifecycle-copilot" }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("lifecycle-copilot");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "manifest lifecycle='worker' produces worker PID via createKoi",
    async () => {
      const adapter = createAdapter();

      // Worker without parent → still gets worker type from manifest
      const runtime = await createKoi({
        manifest: testManifest({ lifecycle: "worker" }),
        adapter,
        loopDetection: false,
      });

      expect(runtime.agent.pid.type).toBe("worker");

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: lifecycle-worker" }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 2: spawn worker child with real LLM call ─────────────────────

  test(
    "parent spawns worker child that makes real LLM call + tool call",
    async () => {
      const ledger = createInMemorySpawnLedger(10);

      // Create parent agent via createKoi
      const parentAdapter = createAdapter("You are a parent agent. Reply briefly.");
      const parentRuntime = await createKoi({
        manifest: testManifest({ name: "parent-agent", lifecycle: "copilot" }),
        adapter: parentAdapter,
        providers: [createToolProvider([MULTIPLY_TOOL])],
        spawnLedger: ledger,
        registry,
        loopDetection: false,
      });

      // Register parent in registry
      registry.register({
        agentId: parentRuntime.agent.pid.id,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "copilot",
        metadata: {},
        registeredAt: Date.now(),
        priority: 10,
      });
      registry.transition(parentRuntime.agent.pid.id, "running", 0, {
        kind: "assembly_complete",
      });

      // Spawn a worker child with real LLM adapter
      const childAdapter = createAdapter(
        "You MUST use the multiply tool to answer math questions. Never compute in your head. Always use the tool.",
      );

      // let justified: capture tool call metadata for assertions
      let childToolCalled = false;
      const childToolObserver: KoiMiddleware = {
        name: "child-tool-observer",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          if (request.toolId === "multiply") {
            childToolCalled = true;
          }
          return next(request);
        },
      };

      const childResult = await spawnChildAgent({
        manifest: testManifest({ name: "worker-child", lifecycle: "worker" }),
        adapter: childAdapter,
        parentAgent: parentRuntime.agent,
        spawnLedger: ledger,
        spawnPolicy: DEFAULT_SPAWN_POLICY,
        registry,
        middleware: [childToolObserver],
        providers: [createToolProvider([MULTIPLY_TOOL])],
        loopDetection: false,
      });

      // Verify child PID
      expect(childResult.childPid.type).toBe("worker");
      expect(childResult.childPid.parent).toBe(parentRuntime.agent.pid.id);
      expect(childResult.childPid.depth).toBe(1);

      // Verify registry entry
      const childEntry = registry.lookup(childResult.childPid.id);
      expect(childEntry).toBeDefined();
      expect(childEntry?.agentType).toBe("worker");
      expect(childEntry?.parentId).toBe(parentRuntime.agent.pid.id);
      expect(childEntry?.spawner).toBe(parentRuntime.agent.pid.id);

      // Collect child lifecycle events
      const lifecycleEvents: ChildLifecycleEvent[] = [];
      childResult.handle.onEvent((e) => lifecycleEvents.push(e));

      // Transition child: created → running in registry
      registry.transition(childResult.childPid.id, "running", 0, {
        kind: "assembly_complete",
      });

      // Run child — real LLM call with tool usage
      const childEvents = await collectEvents(
        childResult.runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 6 * 9. Then tell me the result.",
        }),
      );

      const childOutput = findDoneOutput(childEvents);
      expect(childOutput).toBeDefined();
      expect(childOutput?.stopReason).toBe("completed");
      expect(childOutput?.metrics.totalTokens).toBeGreaterThan(0);

      // Tool should have been called through middleware
      expect(childToolCalled).toBe(true);

      // Response should contain 54
      const childText = extractText(childEvents);
      expect(childText).toContain("54");

      // Verify started event fired
      expect(lifecycleEvents.some((e) => e.kind === "started")).toBe(true);

      // Terminate child
      registry.transition(childResult.childPid.id, "terminated", 1, {
        kind: "completed",
      });
      await flush();

      // Verify completed + terminated events fired
      expect(lifecycleEvents.some((e) => e.kind === "completed")).toBe(true);
      expect(lifecycleEvents.some((e) => e.kind === "terminated")).toBe(true);

      // Ledger slot released
      expect(ledger.activeCount()).toBe(0);

      await childResult.runtime.dispose();
      await parentRuntime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: copilot child survives parent termination with real LLM ────

  test(
    "copilot child survives parent termination, worker child cascade-dies",
    async () => {
      const ledger = createInMemorySpawnLedger(10);

      // Create parent
      const parentAdapter = createAdapter();
      const parentRuntime = await createKoi({
        manifest: testManifest({ name: "cascade-parent", lifecycle: "copilot" }),
        adapter: parentAdapter,
        spawnLedger: ledger,
        registry,
        loopDetection: false,
      });

      // Register and start parent
      registry.register({
        agentId: parentRuntime.agent.pid.id,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "copilot",
        metadata: {},
        registeredAt: Date.now(),
        priority: 10,
      });
      registry.transition(parentRuntime.agent.pid.id, "running", 0, {
        kind: "assembly_complete",
      });

      // Wire up cascade + tree
      const tree = createProcessTree(registry);
      const cascade = createCascadingTermination(registry, tree);

      // Spawn copilot child
      const copilotChild = await spawnChildAgent({
        manifest: testManifest({ name: "copilot-child", lifecycle: "copilot" }),
        adapter: createAdapter("You are an independent copilot."),
        parentAgent: parentRuntime.agent,
        spawnLedger: ledger,
        spawnPolicy: DEFAULT_SPAWN_POLICY,
        registry,
        loopDetection: false,
      });

      // Spawn worker child
      const workerChild = await spawnChildAgent({
        manifest: testManifest({ name: "worker-child", lifecycle: "worker" }),
        adapter: createAdapter("You are a worker."),
        parentAgent: parentRuntime.agent,
        spawnLedger: ledger,
        spawnPolicy: DEFAULT_SPAWN_POLICY,
        registry,
        loopDetection: false,
      });

      // Move children to running
      registry.transition(copilotChild.childPid.id, "running", 0, {
        kind: "assembly_complete",
      });
      registry.transition(workerChild.childPid.id, "running", 0, {
        kind: "assembly_complete",
      });

      // Verify types
      expect(copilotChild.childPid.type).toBe("copilot");
      expect(workerChild.childPid.type).toBe("worker");

      // Collect worker lifecycle events
      const workerEvents: ChildLifecycleEvent[] = [];
      workerChild.handle.onEvent((e) => workerEvents.push(e));

      // Parent terminates
      registry.transition(parentRuntime.agent.pid.id, "terminated", 1, { kind: "completed" });
      await flush();

      // Copilot survives
      const copilotEntry = registry.lookup(copilotChild.childPid.id);
      expect(copilotEntry).toBeDefined();
      expect(copilotEntry?.status.phase).toBe("running");

      // Worker cascade-terminated
      const workerEntry = registry.lookup(workerChild.childPid.id);
      expect(workerEntry?.status.phase).toBe("terminated");

      // Now run the surviving copilot child — it should still work with real LLM
      const copilotEvents = await collectEvents(
        copilotChild.runtime.run({
          kind: "text",
          text: "Reply with exactly: I survived",
        }),
      );

      const copilotOutput = findDoneOutput(copilotEvents);
      expect(copilotOutput).toBeDefined();
      expect(copilotOutput?.stopReason).toBe("completed");

      const copilotText = extractText(copilotEvents);
      expect(copilotText.toLowerCase()).toContain("survived");

      await copilotChild.runtime.dispose();
      await workerChild.runtime.dispose();
      await parentRuntime.dispose();
      await cascade[Symbol.asyncDispose]();
      await tree[Symbol.asyncDispose]();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: ChildHandle.signal() fires event ──────────────────────────

  test(
    "ChildHandle.signal() fires signaled event on running child",
    async () => {
      const ledger = createInMemorySpawnLedger(10);

      const parentAdapter = createAdapter();
      const parentRuntime = await createKoi({
        manifest: testManifest({ name: "signal-parent" }),
        adapter: parentAdapter,
        spawnLedger: ledger,
        registry,
        loopDetection: false,
      });

      registry.register({
        agentId: parentRuntime.agent.pid.id,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "copilot",
        metadata: {},
        registeredAt: Date.now(),
        priority: 10,
      });
      registry.transition(parentRuntime.agent.pid.id, "running", 0, {
        kind: "assembly_complete",
      });

      const child = await spawnChildAgent({
        manifest: testManifest({ name: "signal-child", lifecycle: "worker" }),
        adapter: createAdapter(),
        parentAgent: parentRuntime.agent,
        spawnLedger: ledger,
        spawnPolicy: DEFAULT_SPAWN_POLICY,
        registry,
        loopDetection: false,
      });

      registry.transition(child.childPid.id, "running", 0, { kind: "assembly_complete" });

      const events: ChildLifecycleEvent[] = [];
      child.handle.onEvent((e) => events.push(e));

      // Signal the child
      await child.handle.signal("graceful_shutdown");

      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("signaled");
      if (events[0]?.kind === "signaled") {
        expect(events[0].signal).toBe("graceful_shutdown");
      }

      // Now terminate the child via handle
      await child.handle.terminate("no longer needed");

      // terminated event should fire (via registry watcher)
      await flush();

      const terminatedEntry = registry.lookup(child.childPid.id);
      expect(terminatedEntry?.status.phase).toBe("terminated");

      await child.runtime.dispose();
      await parentRuntime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 5: ChildHandle.terminate() CAS-transitions child ─────────────

  test(
    "ChildHandle.terminate() CAS-transitions running child to terminated",
    async () => {
      const ledger = createInMemorySpawnLedger(10);

      const parentAdapter = createAdapter();
      const parentRuntime = await createKoi({
        manifest: testManifest({ name: "term-parent" }),
        adapter: parentAdapter,
        spawnLedger: ledger,
        registry,
        loopDetection: false,
      });

      registry.register({
        agentId: parentRuntime.agent.pid.id,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "copilot",
        metadata: {},
        registeredAt: Date.now(),
        priority: 10,
      });
      registry.transition(parentRuntime.agent.pid.id, "running", 0, {
        kind: "assembly_complete",
      });

      const child = await spawnChildAgent({
        manifest: testManifest({ name: "term-child", lifecycle: "worker" }),
        adapter: createAdapter(),
        parentAgent: parentRuntime.agent,
        spawnLedger: ledger,
        spawnPolicy: DEFAULT_SPAWN_POLICY,
        registry,
        loopDetection: false,
      });

      registry.transition(child.childPid.id, "running", 0, { kind: "assembly_complete" });

      const lifecycleEvents: ChildLifecycleEvent[] = [];
      child.handle.onEvent((e) => lifecycleEvents.push(e));

      // Terminate via handle
      await child.handle.terminate();
      await flush();

      // Registry should reflect terminated
      const entry = registry.lookup(child.childPid.id);
      expect(entry?.status.phase).toBe("terminated");

      // Terminated event should have fired
      expect(lifecycleEvents.some((e) => e.kind === "terminated")).toBe(true);

      // Ledger slot released
      expect(ledger.activeCount()).toBe(0);

      // Terminate again — should be idempotent (no error)
      await child.handle.terminate();

      await child.runtime.dispose();
      await parentRuntime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 6: spawner lineage through ProcessTree ────────────────────────

  test(
    "spawner lineage tracked across grandparent → parent → child",
    async () => {
      const ledger = createInMemorySpawnLedger(10);
      const tree = createProcessTree(registry);

      // Create grandparent
      const gpAdapter = createAdapter();
      const gpRuntime = await createKoi({
        manifest: testManifest({ name: "grandparent", lifecycle: "copilot" }),
        adapter: gpAdapter,
        spawnLedger: ledger,
        registry,
        loopDetection: false,
      });

      registry.register({
        agentId: gpRuntime.agent.pid.id,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "copilot",
        metadata: {},
        registeredAt: Date.now(),
        priority: 10,
      });
      registry.transition(gpRuntime.agent.pid.id, "running", 0, {
        kind: "assembly_complete",
      });

      // Spawn parent child
      const parentChild = await spawnChildAgent({
        manifest: testManifest({ name: "parent-child", lifecycle: "copilot" }),
        adapter: createAdapter(),
        parentAgent: gpRuntime.agent,
        spawnLedger: ledger,
        spawnPolicy: DEFAULT_SPAWN_POLICY,
        registry,
        loopDetection: false,
      });

      registry.transition(parentChild.childPid.id, "running", 0, {
        kind: "assembly_complete",
      });

      // Spawn grandchild from parent-child (copilot forging copilot)
      // We need a mock-ish parent agent object that references the parentChild's PID
      const parentChildAsAgent = parentChild.runtime.agent;

      const grandchild = await spawnChildAgent({
        manifest: testManifest({ name: "grandchild", lifecycle: "worker" }),
        adapter: createAdapter(),
        parentAgent: parentChildAsAgent,
        spawnLedger: ledger,
        spawnPolicy: DEFAULT_SPAWN_POLICY,
        registry,
        loopDetection: false,
      });

      // Verify lineage
      const grandchildLineage = tree.lineage(grandchild.childPid.id);
      expect(grandchildLineage).toHaveLength(2);
      expect(grandchildLineage[0]).toBe(parentChildAsAgent.pid.id);
      expect(grandchildLineage[1]).toBe(gpRuntime.agent.pid.id);

      // Parent's lineage is just grandparent
      const parentLineage = tree.lineage(parentChild.childPid.id);
      expect(parentLineage).toHaveLength(1);
      expect(parentLineage[0]).toBe(gpRuntime.agent.pid.id);

      // Root has no lineage
      expect(tree.lineage(gpRuntime.agent.pid.id)).toHaveLength(0);

      await grandchild.runtime.dispose();
      await parentChild.runtime.dispose();
      await gpRuntime.dispose();
      await tree[Symbol.asyncDispose]();
    },
    TIMEOUT_MS,
  );

  // ── Test 7: completed + error events fire before terminated ────────────

  test(
    "completed event fires before terminated on successful child",
    async () => {
      const ledger = createInMemorySpawnLedger(10);

      const parentAdapter = createAdapter();
      const parentRuntime = await createKoi({
        manifest: testManifest({ name: "event-parent" }),
        adapter: parentAdapter,
        spawnLedger: ledger,
        registry,
        loopDetection: false,
      });

      registry.register({
        agentId: parentRuntime.agent.pid.id,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "copilot",
        metadata: {},
        registeredAt: Date.now(),
        priority: 10,
      });
      registry.transition(parentRuntime.agent.pid.id, "running", 0, {
        kind: "assembly_complete",
      });

      const child = await spawnChildAgent({
        manifest: testManifest({ name: "event-child", lifecycle: "worker" }),
        adapter: createAdapter(),
        parentAgent: parentRuntime.agent,
        spawnLedger: ledger,
        spawnPolicy: DEFAULT_SPAWN_POLICY,
        registry,
        loopDetection: false,
      });

      const events: ChildLifecycleEvent[] = [];
      child.handle.onEvent((e) => events.push(e));

      // Lifecycle: created → running → terminated (completed reason)
      registry.transition(child.childPid.id, "running", 0, { kind: "assembly_complete" });
      registry.transition(child.childPid.id, "terminated", 1, { kind: "completed" });
      await flush();

      // Event order: started, completed, terminated
      expect(events).toHaveLength(3);
      expect(events[0]?.kind).toBe("started");
      expect(events[1]?.kind).toBe("completed");
      expect(events[2]?.kind).toBe("terminated");

      await child.runtime.dispose();
      await parentRuntime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "error event fires before terminated on failed child",
    async () => {
      const ledger = createInMemorySpawnLedger(10);

      const parentAdapter = createAdapter();
      const parentRuntime = await createKoi({
        manifest: testManifest({ name: "error-parent" }),
        adapter: parentAdapter,
        spawnLedger: ledger,
        registry,
        loopDetection: false,
      });

      registry.register({
        agentId: parentRuntime.agent.pid.id,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "copilot",
        metadata: {},
        registeredAt: Date.now(),
        priority: 10,
      });
      registry.transition(parentRuntime.agent.pid.id, "running", 0, {
        kind: "assembly_complete",
      });

      const child = await spawnChildAgent({
        manifest: testManifest({ name: "error-child", lifecycle: "worker" }),
        adapter: createAdapter(),
        parentAgent: parentRuntime.agent,
        spawnLedger: ledger,
        spawnPolicy: DEFAULT_SPAWN_POLICY,
        registry,
        loopDetection: false,
      });

      const events: ChildLifecycleEvent[] = [];
      child.handle.onEvent((e) => events.push(e));

      // Lifecycle: created → running → terminated (error reason)
      registry.transition(child.childPid.id, "running", 0, { kind: "assembly_complete" });
      registry.transition(child.childPid.id, "terminated", 1, {
        kind: "error",
        cause: "something broke",
      });
      await flush();

      // Event order: started, error, terminated
      expect(events).toHaveLength(3);
      expect(events[0]?.kind).toBe("started");
      expect(events[1]?.kind).toBe("error");
      if (events[1]?.kind === "error") {
        expect(events[1].cause).toBe("something broke");
      }
      expect(events[2]?.kind).toBe("terminated");

      await child.runtime.dispose();
      await parentRuntime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 8: middleware chain fires in parent + child with real LLM ─────

  test(
    "middleware hooks fire correctly in both parent and child agents",
    async () => {
      const ledger = createInMemorySpawnLedger(10);
      const parentHooks: string[] = [];
      const childHooks: string[] = [];

      const parentMiddleware: KoiMiddleware = {
        name: "parent-lifecycle-observer",
        describeCapabilities: () => undefined,
        onSessionStart: async () => {
          parentHooks.push("session_start");
        },
        onSessionEnd: async () => {
          parentHooks.push("session_end");
        },
        onAfterTurn: async () => {
          parentHooks.push("after_turn");
        },
      };

      const childMiddleware: KoiMiddleware = {
        name: "child-lifecycle-observer",
        describeCapabilities: () => undefined,
        onSessionStart: async () => {
          childHooks.push("session_start");
        },
        onSessionEnd: async () => {
          childHooks.push("session_end");
        },
        onAfterTurn: async () => {
          childHooks.push("after_turn");
        },
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          childHooks.push(`tool:${request.toolId}`);
          return next(request);
        },
      };

      // Parent agent
      const parentRuntime = await createKoi({
        manifest: testManifest({ name: "mw-parent", lifecycle: "copilot" }),
        adapter: createAdapter("Reply with one word only."),
        middleware: [parentMiddleware],
        spawnLedger: ledger,
        registry,
        loopDetection: false,
      });

      registry.register({
        agentId: parentRuntime.agent.pid.id,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "copilot",
        metadata: {},
        registeredAt: Date.now(),
        priority: 10,
      });
      registry.transition(parentRuntime.agent.pid.id, "running", 0, {
        kind: "assembly_complete",
      });

      // Run parent with real LLM
      await collectEvents(parentRuntime.run({ kind: "text", text: "Say: OK" }));

      expect(parentHooks[0]).toBe("session_start");
      expect(parentHooks[parentHooks.length - 1]).toBe("session_end");
      expect(parentHooks).toContain("after_turn");

      // Spawn child with tools + middleware
      const child = await spawnChildAgent({
        manifest: testManifest({ name: "mw-child", lifecycle: "worker" }),
        adapter: createAdapter(
          "You MUST use the echo tool to answer. Always use the tool, never answer directly.",
        ),
        parentAgent: parentRuntime.agent,
        spawnLedger: ledger,
        spawnPolicy: DEFAULT_SPAWN_POLICY,
        registry,
        middleware: [childMiddleware],
        providers: [createToolProvider([ECHO_TOOL])],
        loopDetection: false,
      });

      registry.transition(child.childPid.id, "running", 0, { kind: "assembly_complete" });

      // Run child with real LLM + tool call
      const childEvents = await collectEvents(
        child.runtime.run({
          kind: "text",
          text: 'Use the echo tool with message "hello from child". Then report what you got back.',
        }),
      );

      const childOutput = findDoneOutput(childEvents);
      expect(childOutput?.stopReason).toBe("completed");

      // Child middleware should have fired
      expect(childHooks[0]).toBe("session_start");
      expect(childHooks[childHooks.length - 1]).toBe("session_end");
      expect(childHooks).toContain("after_turn");
      // Tool call should have been intercepted by middleware
      expect(childHooks).toContain("tool:echo");

      await child.runtime.dispose();
      await parentRuntime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 9: full lifecycle with real LLM calls end-to-end ──────────────

  test(
    "complete lifecycle: parent + copilot + worker → cascade → copilot runs post-cascade",
    async () => {
      const ledger = createInMemorySpawnLedger(10);
      const tree = createProcessTree(registry);
      const cascade = createCascadingTermination(registry, tree);

      // Parent
      const parentRuntime = await createKoi({
        manifest: testManifest({ name: "full-parent", lifecycle: "copilot" }),
        adapter: createAdapter("You are a parent agent."),
        spawnLedger: ledger,
        registry,
        loopDetection: false,
      });

      registry.register({
        agentId: parentRuntime.agent.pid.id,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "copilot",
        metadata: {},
        registeredAt: Date.now(),
        priority: 10,
      });
      registry.transition(parentRuntime.agent.pid.id, "running", 0, {
        kind: "assembly_complete",
      });

      // Run parent first
      const parentEvents = await collectEvents(
        parentRuntime.run({ kind: "text", text: "Reply: parent ready" }),
      );
      expect(findDoneOutput(parentEvents)?.stopReason).toBe("completed");

      // Spawn copilot child
      const copilotChild = await spawnChildAgent({
        manifest: testManifest({ name: "full-copilot", lifecycle: "copilot" }),
        adapter: createAdapter("You are an independent copilot."),
        parentAgent: parentRuntime.agent,
        spawnLedger: ledger,
        spawnPolicy: DEFAULT_SPAWN_POLICY,
        registry,
        providers: [createToolProvider([MULTIPLY_TOOL])],
        loopDetection: false,
      });

      // Spawn worker child
      const workerChild = await spawnChildAgent({
        manifest: testManifest({ name: "full-worker", lifecycle: "worker" }),
        adapter: createAdapter("You are a worker."),
        parentAgent: parentRuntime.agent,
        spawnLedger: ledger,
        spawnPolicy: DEFAULT_SPAWN_POLICY,
        registry,
        loopDetection: false,
      });

      registry.transition(copilotChild.childPid.id, "running", 0, {
        kind: "assembly_complete",
      });
      registry.transition(workerChild.childPid.id, "running", 0, {
        kind: "assembly_complete",
      });

      // Verify lineage
      expect(tree.lineage(copilotChild.childPid.id)).toEqual([parentRuntime.agent.pid.id]);
      expect(tree.lineage(workerChild.childPid.id)).toEqual([parentRuntime.agent.pid.id]);

      // Parent terminates → cascade
      registry.transition(parentRuntime.agent.pid.id, "terminated", 1, { kind: "completed" });
      await flush();

      // Worker killed, copilot alive
      expect(registry.lookup(workerChild.childPid.id)?.status.phase).toBe("terminated");
      expect(registry.lookup(copilotChild.childPid.id)?.status.phase).toBe("running");

      // Run copilot after parent death — real LLM call with tool
      const copilotEvents = await collectEvents(
        copilotChild.runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 12 * 12. Report the result.",
        }),
      );

      const copilotOutput = findDoneOutput(copilotEvents);
      expect(copilotOutput).toBeDefined();
      expect(copilotOutput?.stopReason).toBe("completed");

      const copilotText = extractText(copilotEvents);
      expect(copilotText).toContain("144");

      await copilotChild.runtime.dispose();
      await workerChild.runtime.dispose();
      await parentRuntime.dispose();
      await cascade[Symbol.asyncDispose]();
      await tree[Symbol.asyncDispose]();
    },
    TIMEOUT_MS,
  );
});
