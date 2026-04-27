import { beforeEach, describe, expect, test } from "bun:test";
import type { ForgeStore, JsonObject, KoiError, Result } from "@koi/core";
import { brickId, runId, sessionId } from "@koi/core";
import type { ToolExecutionContext } from "@koi/execution-context";
import { runWithExecutionContext } from "@koi/execution-context";
import { createInMemoryForgeStore } from "../memory-store.js";
import { createForgeToolTool, type ForgeToolOk } from "./forge-tool.js";

function makeContext(agent: string): ToolExecutionContext {
  return {
    session: {
      agentId: agent,
      sessionId: sessionId("s1"),
      runId: runId("r1"),
      metadata: {},
    },
    turnIndex: 0,
  };
}

function asResult(value: unknown): Result<ForgeToolOk, KoiError> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("ok" in value) ||
    typeof (value as { ok: unknown }).ok !== "boolean"
  ) {
    throw new Error(`unexpected tool result shape: ${JSON.stringify(value)}`);
  }
  return value as Result<ForgeToolOk, KoiError>;
}

const validArgs: JsonObject = {
  name: "add-numbers",
  description: "Sum two numbers.",
  version: "0.0.1",
  scope: "agent",
  implementation: "return args.a + args.b;",
  inputSchema: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
  },
};

let store: ForgeStore;
beforeEach(() => {
  store = createInMemoryForgeStore();
});

describe("forge_tool", () => {
  test("synthesizes ToolArtifact and persists with lifecycle: draft", async () => {
    const tool = createForgeToolTool({ store });
    const raw = await runWithExecutionContext(makeContext("agent-A"), () =>
      tool.execute(validArgs),
    );
    const result = asResult(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.lifecycle).toBe("draft");
    const loaded = await store.load(brickId(result.value.brickId));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error("unreachable");
    expect(loaded.value.kind).toBe("tool");
    expect(loaded.value.lifecycle).toBe("draft");
    expect(loaded.value.provenance.metadata.agentId).toBe("agent-A");
  });

  test("rejects invalid input with VALIDATION", async () => {
    const tool = createForgeToolTool({ store });
    const raw = await runWithExecutionContext(makeContext("agent-A"), () => tool.execute({}));
    const result = asResult(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects scope: zone with VALIDATION", async () => {
    const tool = createForgeToolTool({ store });
    const raw = await runWithExecutionContext(makeContext("agent-A"), () =>
      tool.execute({ ...validArgs, scope: "zone" }),
    );
    const result = asResult(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects scope: global with PERMISSION", async () => {
    const tool = createForgeToolTool({ store });
    const raw = await runWithExecutionContext(makeContext("agent-A"), () =>
      tool.execute({ ...validArgs, scope: "global" }),
    );
    const result = asResult(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("PERMISSION");
  });

  test("idempotent retry — same agent, same content yields same brickId", async () => {
    const tool = createForgeToolTool({ store });
    const a = asResult(
      await runWithExecutionContext(makeContext("agent-A"), () => tool.execute(validArgs)),
    );
    const b = asResult(
      await runWithExecutionContext(makeContext("agent-A"), () => tool.execute(validArgs)),
    );
    if (!a.ok || !b.ok) throw new Error("expected both ok");
    expect(a.value.brickId).toBe(b.value.brickId);
  });

  test("two agents synthesizing identical agent-scoped content produce distinct brickIds", async () => {
    const tool = createForgeToolTool({ store });
    const a = asResult(
      await runWithExecutionContext(makeContext("agent-A"), () => tool.execute(validArgs)),
    );
    const b = asResult(
      await runWithExecutionContext(makeContext("agent-B"), () => tool.execute(validArgs)),
    );
    if (!a.ok || !b.ok) throw new Error("expected both ok");
    expect(a.value.brickId).not.toBe(b.value.brickId);
  });

  test("throws NO_CONTEXT when invoked outside any execution context", async () => {
    const tool = createForgeToolTool({ store });
    let caught: unknown;
    try {
      await tool.execute(validArgs);
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) expect(caught.message).toMatch(/NO_CONTEXT/);
  });

  test("descriptor is a primordial ToolDescriptor with JSON Schema input", () => {
    const tool = createForgeToolTool({ store });
    expect(tool.descriptor.name).toBe("forge_tool");
    expect(typeof tool.descriptor.description).toBe("string");
    expect(tool.descriptor.inputSchema).toBeDefined();
    expect(tool.descriptor.origin).toBe("primordial");
    expect(tool.origin).toBe("primordial");
  });
});
