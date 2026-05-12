# `notify` tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fire-and-forget `notify` tool to `@koi/proactive` that lets an agent send a one-shot text message via any `ChannelAdapter` attached to the agent.

**Architecture:** Pure factory `createNotifyTool({ resolveChannel })` returning an L0 `Tool`. `ComponentProvider` snapshots `channel:*` components from the agent at attach time and passes a closure-bound lookup. No state, no scheduler, no retries.

**Tech Stack:** TypeScript 6, Bun 1.3, `bun:test`, zod, `@koi/core`, `@koi/tools-core`.

**Spec:** `docs/superpowers/specs/2026-05-10-notify-tool-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/lib/proactive/src/notify-tool.ts` (new) | `createNotifyTool` factory + zod schema + `ResolveChannel` type |
| `packages/lib/proactive/src/notify-tool.test.ts` (new) | Unit tests for the tool execute path |
| `packages/lib/proactive/src/types.ts` (modify) | Extend `ProactiveToolsConfig` with optional `resolveChannel` |
| `packages/lib/proactive/src/create-proactive-tools.ts` (modify) | Add `"notify"` to `PROACTIVE_TOOL_NAMES`, wire into `assembleProactiveTools` |
| `packages/lib/proactive/src/provider.ts` (modify) | Snapshot `channel:*` components → pass `resolveChannel` |
| `packages/lib/proactive/src/provider.test.ts` (modify) | Add tests for channel snapshotting + skip behavior |
| `packages/lib/proactive/src/index.ts` (modify) | Export `createNotifyTool`, `ResolveChannel` |
| `docs/L2/proactive.md` (modify) | Add `notify` row + behavior section |

---

## Task 1: Define types and schema

**Files:**
- Modify: `packages/lib/proactive/src/types.ts`

- [ ] **Step 1: Add `ResolveChannel` type and extend `ProactiveToolsConfig`**

In `packages/lib/proactive/src/types.ts`, add the import and new type:

```typescript
import type { AgentId, ChannelAdapter, SchedulerComponent } from "@koi/core";

/**
 * Lookup function returning a `ChannelAdapter` by channel name, or
 * `undefined` if no channel with that name is attached. The provider
 * builds this from a snapshot of `channel:*` components taken at attach
 * time.
 */
export type ResolveChannel = (name: string) => ChannelAdapter | undefined;
```

Then extend `ProactiveToolsConfig` with one new optional field (place after `now`):

```typescript
  /**
   * Lookup function for the `notify` tool. When omitted, `notify` is still
   * created but every call resolves to "no channels available". The provider
   * supplies this from a snapshot of the agent's `channel:*` components.
   */
  readonly resolveChannel?: ResolveChannel;
```

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/lib/proactive && bun run typecheck`
Expected: PASS (no callers reference the new field yet).

- [ ] **Step 3: Commit**

```bash
git add packages/lib/proactive/src/types.ts
git commit -m "feat(proactive): add ResolveChannel type for notify tool"
```

---

## Task 2: Failing test for unknown channel

**Files:**
- Create: `packages/lib/proactive/src/notify-tool.test.ts`

- [ ] **Step 1: Write the first failing test**

Create `packages/lib/proactive/src/notify-tool.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { ChannelAdapter, JsonObject } from "@koi/core";
import { createNotifyTool } from "./notify-tool.js";

function stubAdapter(overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    name: "stub",
    capabilities: {
      text: true,
      images: false,
      files: false,
      buttons: false,
      audio: false,
      video: false,
      threads: true,
      supportsA2ui: false,
    },
    connect: async () => {},
    disconnect: async () => {},
    send: async () => {},
    onMessage: () => () => {},
    ...overrides,
  };
}

describe("notify tool", () => {
  test("returns ok:false with sorted available_channels for unknown channel", async () => {
    const channels = new Map<string, ChannelAdapter>([
      ["slack", stubAdapter({ name: "slack" })],
      ["email", stubAdapter({ name: "email" })],
    ]);
    const tool = createNotifyTool({ resolveChannel: (n) => channels.get(n) ?? undefined, names: () => [...channels.keys()] });
    const result = (await tool.execute({ channel: "telegram", text: "hi" })) as JsonObject;
    expect(result).toEqual({
      ok: false,
      error: "unknown channel: telegram",
      available_channels: ["email", "slack"],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/lib/proactive && bun test notify-tool.test.ts`
Expected: FAIL — module `./notify-tool.js` not found.

---

## Task 3: Minimal `createNotifyTool` to make Task 2 pass

**Files:**
- Create: `packages/lib/proactive/src/notify-tool.ts`

- [ ] **Step 1: Implement minimal factory**

Create `packages/lib/proactive/src/notify-tool.ts`:

```typescript
/**
 * `notify` tool — fire-and-forget text message to an attached ChannelAdapter.
 *
 * Thin pass-through: validate args, look up adapter by name, build an
 * OutboundMessage with a single TextBlock, await `adapter.send`. No state,
 * no idempotency, no retries. Adapter dedupe is the adapter's concern.
 */

import type { JsonObject, OutboundMessage, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { toJSONSchema, z } from "zod";
import type { ResolveChannel } from "./types.js";

const schema = z.object({
  channel: z.string().min(1, "channel must be non-empty"),
  text: z.string().min(1, "text must be non-empty"),
  thread_id: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export interface NotifyToolConfig {
  readonly resolveChannel: ResolveChannel;
  /** Returns the currently-known channel names, used in error responses. */
  readonly names: () => readonly string[];
}

export function createNotifyTool(config: NotifyToolConfig): Tool {
  const { resolveChannel, names } = config;

  return {
    descriptor: {
      name: "notify",
      description:
        "Send a one-shot text message to the user via a named channel " +
        "(e.g. 'slack', 'email'). Fire-and-forget: no retries, no delivery " +
        "confirmation beyond `ok:true`. Returns `ok:false` with the list " +
        "of available channels if the named channel is not attached.",
      inputSchema: toJSONSchema(schema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.message };
      }
      const { channel, text, thread_id, metadata } = parsed.data;
      const adapter = resolveChannel(channel);
      if (adapter === undefined) {
        return {
          ok: false,
          error: `unknown channel: ${channel}`,
          available_channels: [...names()].sort(),
        };
      }
      const message: OutboundMessage = {
        content: [{ kind: "text", text }],
        ...(thread_id !== undefined ? { threadId: thread_id } : {}),
        ...(metadata !== undefined ? { metadata: metadata as JsonObject } : {}),
      };
      try {
        await adapter.send(message);
        return { ok: true };
      } catch (e: unknown) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "channel.send failed",
        };
      }
    },
  };
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd packages/lib/proactive && bun test notify-tool.test.ts`
Expected: PASS (1 test).

- [ ] **Step 3: Commit**

```bash
git add packages/lib/proactive/src/notify-tool.ts packages/lib/proactive/src/notify-tool.test.ts
git commit -m "feat(proactive): add notify tool with unknown-channel error path"
```

---

## Task 4: Add successful-send test (TDD second case)

**Files:**
- Modify: `packages/lib/proactive/src/notify-tool.test.ts`

- [ ] **Step 1: Add test for successful send**

Append inside the `describe("notify tool", ...)` block:

```typescript
  test("forwards exact OutboundMessage shape on successful send", async () => {
    const sent: OutboundMessage[] = [];
    const slack = stubAdapter({
      name: "slack",
      send: async (m) => {
        sent.push(m);
      },
    });
    const tool = createNotifyTool({
      resolveChannel: (n) => (n === "slack" ? slack : undefined),
      names: () => ["slack"],
    });

    const result = await tool.execute({
      channel: "slack",
      text: "hello",
      thread_id: "T1",
      metadata: { priority: "high" },
    });

    expect(result).toEqual({ ok: true });
    expect(sent).toEqual([
      {
        content: [{ kind: "text", text: "hello" }],
        threadId: "T1",
        metadata: { priority: "high" },
      },
    ]);
  });
```

Add the missing import at the top of the file:

```typescript
import type { ChannelAdapter, JsonObject, OutboundMessage } from "@koi/core";
```

- [ ] **Step 2: Run tests**

Run: `cd packages/lib/proactive && bun test notify-tool.test.ts`
Expected: PASS (2 tests). Implementation already covers this — test verifies it.

---

## Task 5: Test omitted optional fields produce no `undefined` keys

**Files:**
- Modify: `packages/lib/proactive/src/notify-tool.test.ts`

- [ ] **Step 1: Add test**

Append inside the `describe` block:

```typescript
  test("omits threadId and metadata from outbound when not provided", async () => {
    const sent: OutboundMessage[] = [];
    const slack = stubAdapter({ name: "slack", send: async (m) => { sent.push(m); } });
    const tool = createNotifyTool({
      resolveChannel: () => slack,
      names: () => ["slack"],
    });

    await tool.execute({ channel: "slack", text: "hi" });

    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!).sort()).toEqual(["content"]);
  });
```

- [ ] **Step 2: Run tests**

Run: `cd packages/lib/proactive && bun test notify-tool.test.ts`
Expected: PASS (3 tests).

---

## Task 6: Test adapter throw is caught

**Files:**
- Modify: `packages/lib/proactive/src/notify-tool.test.ts`

- [ ] **Step 1: Add test**

Append inside the `describe` block:

```typescript
  test("returns ok:false when adapter.send rejects, never throws", async () => {
    const slack = stubAdapter({
      name: "slack",
      send: async () => { throw new Error("network down"); },
    });
    const tool = createNotifyTool({
      resolveChannel: () => slack,
      names: () => ["slack"],
    });

    const result = await tool.execute({ channel: "slack", text: "hi" });
    expect(result).toEqual({ ok: false, error: "network down" });
  });

  test("returns ok:false with default message when adapter throws non-Error", async () => {
    const slack = stubAdapter({
      name: "slack",
      send: async () => { throw "string thrown"; },
    });
    const tool = createNotifyTool({
      resolveChannel: () => slack,
      names: () => ["slack"],
    });

    const result = await tool.execute({ channel: "slack", text: "hi" });
    expect(result).toEqual({ ok: false, error: "channel.send failed" });
  });
```

- [ ] **Step 2: Run tests**

Run: `cd packages/lib/proactive && bun test notify-tool.test.ts`
Expected: PASS (5 tests).

---

## Task 7: Test schema validation for empty inputs

**Files:**
- Modify: `packages/lib/proactive/src/notify-tool.test.ts`

- [ ] **Step 1: Add test**

Append inside the `describe` block:

```typescript
  test("rejects empty channel name at schema boundary", async () => {
    const tool = createNotifyTool({ resolveChannel: () => undefined, names: () => [] });
    const result = (await tool.execute({ channel: "", text: "hi" })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("channel");
  });

  test("rejects empty text at schema boundary", async () => {
    const tool = createNotifyTool({ resolveChannel: () => undefined, names: () => [] });
    const result = (await tool.execute({ channel: "slack", text: "" })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("text");
  });
```

- [ ] **Step 2: Run tests**

Run: `cd packages/lib/proactive && bun test notify-tool.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 3: Commit**

```bash
git add packages/lib/proactive/src/notify-tool.test.ts
git commit -m "test(proactive): cover notify success, omitted optionals, errors, validation"
```

---

## Task 8: Wire `notify` into the proactive tool roster

**Files:**
- Modify: `packages/lib/proactive/src/create-proactive-tools.ts`

- [ ] **Step 1: Update `PROACTIVE_TOOL_NAMES` and `assembleProactiveTools`**

Add `"notify"` to the names tuple (last entry):

```typescript
export const PROACTIVE_TOOL_NAMES = [
  "sleep",
  "cancel_sleep",
  "schedule_cron",
  "cancel_schedule",
  "create_monitor",
  "list_monitors",
  "update_monitor",
  "cancel_monitor",
  "notify",
] as const;
```

Add the import at top:

```typescript
import { createNotifyTool } from "./notify-tool.js";
```

In `assembleProactiveTools`, append the notify tool to the returned array — but only when `config.resolveChannel` is provided:

```typescript
export function assembleProactiveTools(
  config: ProactiveToolsConfig,
  states: ProactiveToolStates,
): readonly Tool[] {
  const { sleepState, cronState, monitorState } = states;
  const tools: Tool[] = [
    createSleepTool(config, sleepState),
    createCancelSleepTool(config, sleepState),
    createScheduleCronTool(config, cronState),
    createCancelScheduleTool(config, cronState),
    createCreateMonitorTool(config, monitorState),
    createListMonitorsTool(monitorState),
    createUpdateMonitorTool(config, monitorState),
    createCancelMonitorTool(config, monitorState),
  ];
  if (config.resolveChannel !== undefined) {
    const resolve = config.resolveChannel;
    tools.push(
      createNotifyTool({
        resolveChannel: resolve,
        names: () => collectChannelNames(config),
      }),
    );
  }
  return tools;
}
```

Add a tiny helper at module scope (after imports):

```typescript
/**
 * Collect channel names for `notify`'s available_channels error response.
 * The provider supplies a `channelNames` callback closing over its snapshot;
 * standalone callers without it get an empty list (the resolveChannel they
 * provided still works for the success path).
 */
function collectChannelNames(config: ProactiveToolsConfig): readonly string[] {
  return config.channelNames !== undefined ? config.channelNames() : [];
}
```

- [ ] **Step 2: Add `channelNames` to `ProactiveToolsConfig`**

In `packages/lib/proactive/src/types.ts`, add after `resolveChannel`:

```typescript
  /**
   * Returns the currently-attached channel names. Used by `notify` to
   * populate `available_channels` in error responses. The provider
   * supplies a callback closing over its `channel:*` snapshot.
   */
  readonly channelNames?: () => readonly string[];
```

- [ ] **Step 3: Verify typecheck and existing tests still pass**

Run: `cd packages/lib/proactive && bun run typecheck && bun test`
Expected: PASS — no behavior change for existing tests (resolveChannel undefined → notify not installed).

- [ ] **Step 4: Commit**

```bash
git add packages/lib/proactive/src/create-proactive-tools.ts packages/lib/proactive/src/types.ts
git commit -m "feat(proactive): wire notify into tool roster when resolveChannel set"
```

---

## Task 9: Provider snapshots `channel:*` components — failing test

**Files:**
- Modify: `packages/lib/proactive/src/provider.test.ts`

- [ ] **Step 1: Update `makeAgent` helper to accept channels**

Modify the existing `makeAgent` signature and body (around line 8 of `provider.test.ts`):

```typescript
function makeAgent(
  scheduler: SchedulerComponent | undefined,
  agentIdValue = "agent-default",
  channels: ReadonlyMap<string, ChannelAdapter> = new Map(),
): Agent {
  const map = new Map<string, unknown>();
  if (scheduler !== undefined) map.set(SCHEDULER as string, scheduler);
  for (const [name, adapter] of channels) {
    map.set(`channel:${name}`, adapter);
  }
  // ... rest unchanged
```

Add `ChannelAdapter` to the import line at top:

```typescript
import type { Agent, ChannelAdapter, SchedulerComponent, SubsystemToken } from "@koi/core";
```

- [ ] **Step 2: Add new test for notify installation**

Append inside `describe("createProactiveToolsProvider", ...)`:

```typescript
  test("installs notify tool when channel:* components are attached", async () => {
    const provider = createProactiveToolsProvider();
    const slack: ChannelAdapter = {
      name: "slack",
      capabilities: { text: true, images: false, files: false, buttons: false, audio: false, video: false, threads: true, supportsA2ui: false },
      connect: async () => {},
      disconnect: async () => {},
      send: async () => {},
      onMessage: () => () => {},
    };
    const agent = makeAgent(createSchedulerStub(), "agent-1", new Map([["slack", slack]]));

    const result = await provider.attach(agent);
    const map = result instanceof Map ? result : result.components;
    expect(map.has(toolToken("notify") as string)).toBe(true);
  });

  test("omits notify tool when no channel:* components are attached", async () => {
    const provider = createProactiveToolsProvider();
    const agent = makeAgent(createSchedulerStub(), "agent-1");

    const result = await provider.attach(agent);
    const map = result instanceof Map ? result : result.components;
    expect(map.has(toolToken("notify") as string)).toBe(false);
  });
```

- [ ] **Step 3: Run tests to verify the new tests fail**

Run: `cd packages/lib/proactive && bun test provider.test.ts`
Expected: the two new tests FAIL — first asserts `notify` present (provider doesn't install it yet), second passes incidentally.

---

## Task 10: Wire channel snapshot into provider

**Files:**
- Modify: `packages/lib/proactive/src/provider.ts`

- [ ] **Step 1: Snapshot channels and pass to assemble**

Add `ChannelAdapter` and `channelToken` to the import line:

```typescript
import type { Agent, AttachResult, ChannelAdapter, ComponentProvider, SkippedComponent, Tool } from "@koi/core";
import { COMPONENT_PRIORITY, SCHEDULER, channelToken, toolToken } from "@koi/core";
```

Inside `attach`, after the scheduler resolution block and before `toolConfig` is built, add:

```typescript
      // Snapshot channel:* components at attach time. Channels added or
      // removed after attach are not reflected by `notify` until reattach —
      // matches the provider's existing per-attach lifecycle.
      const channelSnapshot = new Map<string, ChannelAdapter>();
      for (const [key, value] of agent.components()) {
        if (key.startsWith("channel:")) {
          channelSnapshot.set(key.slice("channel:".length), value as ChannelAdapter);
        }
      }
```

Then extend `toolConfig` with the resolveChannel + names callbacks (only when channels are present, so the assembler skips the tool cleanly when none exist):

```typescript
      const toolConfig: ProactiveToolsConfig = {
        scheduler,
        agentId: agent.pid.id,
        ...(config.defaultWakeMessage !== undefined
          ? { defaultWakeMessage: config.defaultWakeMessage }
          : {}),
        ...(config.maxSleepMs !== undefined ? { maxSleepMs: config.maxSleepMs } : {}),
        ...(config.now !== undefined ? { now: config.now } : {}),
        ...(channelSnapshot.size > 0
          ? {
              resolveChannel: (n: string) => channelSnapshot.get(n),
              channelNames: () => [...channelSnapshot.keys()],
            }
          : {}),
      };
```

- [ ] **Step 2: Run tests**

Run: `cd packages/lib/proactive && bun test provider.test.ts`
Expected: PASS — both new notify tests now pass; existing tests unchanged.

- [ ] **Step 3: Run full package tests**

Run: `cd packages/lib/proactive && bun run typecheck && bun test`
Expected: PASS — all tests green.

- [ ] **Step 4: Commit**

```bash
git add packages/lib/proactive/src/provider.ts packages/lib/proactive/src/provider.test.ts
git commit -m "feat(proactive): provider snapshots channel:* and installs notify"
```

---

## Task 11: Snapshot semantics test (mutation-after-attach not reflected)

**Files:**
- Modify: `packages/lib/proactive/src/provider.test.ts`

- [ ] **Step 1: Add test**

Append inside `describe("createProactiveToolsProvider", ...)`:

```typescript
  test("notify uses snapshot — channels added after attach are not visible", async () => {
    const provider = createProactiveToolsProvider();
    const slack: ChannelAdapter = {
      name: "slack",
      capabilities: { text: true, images: false, files: false, buttons: false, audio: false, video: false, threads: true, supportsA2ui: false },
      connect: async () => {},
      disconnect: async () => {},
      send: async () => {},
      onMessage: () => () => {},
    };
    const channels = new Map<string, ChannelAdapter>([["slack", slack]]);
    const agent = makeAgent(createSchedulerStub(), "agent-1", channels);

    const result = await provider.attach(agent);
    const map = result instanceof Map ? result : result.components;
    const notify = map.get(toolToken("notify") as string) as { execute: (args: JsonObject) => Promise<unknown> };

    // Mutate the agent's components AFTER attach — should not change snapshot.
    (agent.components() as Map<string, unknown>).set("channel:email", slack);

    const res = await notify.execute({ channel: "email", text: "hi" });
    expect(res).toEqual({
      ok: false,
      error: "unknown channel: email",
      available_channels: ["slack"],
    });
  });
```

Add `JsonObject` to the type import line if not already present:

```typescript
import type { Agent, ChannelAdapter, JsonObject, SchedulerComponent, SubsystemToken } from "@koi/core";
```

- [ ] **Step 2: Run tests**

Run: `cd packages/lib/proactive && bun test provider.test.ts`
Expected: PASS — implementation already snapshots; this test locks the behavior.

- [ ] **Step 3: Commit**

```bash
git add packages/lib/proactive/src/provider.test.ts
git commit -m "test(proactive): pin notify channel-snapshot semantics"
```

---

## Task 12: Public exports

**Files:**
- Modify: `packages/lib/proactive/src/index.ts`

- [ ] **Step 1: Export new symbols**

Add to `packages/lib/proactive/src/index.ts`:

```typescript
export { createNotifyTool, type NotifyToolConfig } from "./notify-tool.js";
export type { ResolveChannel } from "./types.js";
```

- [ ] **Step 2: Verify typecheck + tests**

Run: `cd packages/lib/proactive && bun run typecheck && bun test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/lib/proactive/src/index.ts
git commit -m "feat(proactive): export notify tool surface"
```

---

## Task 13: Update package docs

**Files:**
- Modify: `docs/L2/proactive.md`

- [ ] **Step 1: Add `notify` row to the Tools table**

In `docs/L2/proactive.md`, find the table starting `| Tool | Inputs | Returns |` and append a new row:

```
| `notify` | `channel`, `text`, `thread_id?`, `metadata?` | `{ ok: true }` or `{ ok: false, error, available_channels? }` |
```

- [ ] **Step 2: Add a behavior section**

After the existing per-tool sections, append:

```markdown
### `notify`

Sends a one-shot text message via a `ChannelAdapter` attached to the agent.
Fire-and-forget: no retries, no delivery confirmation beyond `ok: true`.

The provider snapshots `channel:*` components at attach time. Channels added
or removed after attach are not visible to `notify` until the agent is
reassembled — matches the per-attach lifecycle of the cron and monitor
state. The tool is **only installed** when at least one `channel:*` component
is attached; agents with no channels do not see it in their tool list.

`thread_id` and `metadata` are forwarded verbatim to `OutboundMessage`.
Adapter `send` rejections become `{ ok: false, error }` — the tool never
throws to the caller.

Out of scope (not implemented):
- multi-channel broadcast (`channel: string[]`)
- rich content blocks (file, image, button, custom) — text-only for v1
- scheduled `notify_at` — would belong as a separate proactive tool
- cross-restart dedup — channel adapters own that via their own idempotency stores
```

- [ ] **Step 3: Update the "What this package does NOT own" table comment if needed**

Inspect that section; if it implies channels remain unowned, leave as-is. The
notify tool does not implement channels — it consumes them — so the existing
ownership statement remains correct.

- [ ] **Step 4: Commit**

```bash
git add docs/L2/proactive.md
git commit -m "docs(proactive): document notify tool"
```

---

## Task 14: Final verification

- [ ] **Step 1: Run full proactive test suite**

Run: `cd packages/lib/proactive && bun run typecheck && bun run lint && bun test`
Expected: PASS — all green.

- [ ] **Step 2: Run repo-wide layer check**

Run: `bun run check:layers`
Expected: PASS — `@koi/proactive` still imports only `@koi/core` and `@koi/tools-core`.

- [ ] **Step 3: Confirm no orphan check failures**

Run: `bun run check:orphans 2>/dev/null || true`
Expected: no new failures attributable to this change. (`@koi/proactive` is already a `@koi/runtime` dep — no new wiring needed.)

---

## Self-Review Notes

- Spec coverage: every spec section has a task. Surface (Tasks 2–7), wiring (Tasks 8, 10), provider snapshot (Tasks 9–11), exports (Task 12), docs (Task 13).
- No placeholders.
- Type consistency: `ResolveChannel`, `NotifyToolConfig`, `channelNames` callback used consistently across types.ts, notify-tool.ts, create-proactive-tools.ts, provider.ts.
- One ambiguity resolved inline: empty `channelNames` → empty `available_channels` array; `notify` only installed when channels exist, so this only matters for direct callers using `createProactiveTools` without the provider.
