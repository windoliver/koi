import { beforeEach, describe, expect, test } from "bun:test";
import type { BrickId, ForgeProvenance, ForgeScope, ForgeStore, ToolArtifact } from "@koi/core";
import { brickId, DEFAULT_SANDBOXED_POLICY, runId, sessionId } from "@koi/core";
import type { ToolExecutionContext } from "@koi/execution-context";
import { runWithExecutionContext } from "@koi/execution-context";
import { createInMemoryForgeStore } from "../memory-store.js";
import { computeIdentityBrickId } from "../shared.js";
import { createForgeInspectTool } from "./forge-inspect.js";
import { createForgeToolTool } from "./forge-tool.js";

function makeContext(agentId: string): ToolExecutionContext {
  return {
    session: {
      agentId,
      sessionId: sessionId("s1"),
      runId: runId("r1"),
      metadata: {},
    },
    turnIndex: 0,
  };
}

let store: ForgeStore;
beforeEach(() => {
  store = createInMemoryForgeStore();
});

async function synthAs(agentId: string, name: string): Promise<BrickId> {
  const tool = createForgeToolTool({ store });
  const r = await runWithExecutionContext(makeContext(agentId), () =>
    tool.execute({
      name,
      description: name,
      version: "0.0.1",
      scope: "agent",
      implementation: `return ${JSON.stringify(name)};`,
      inputSchema: { type: "object" },
    }),
  );
  if (!(r as { ok: boolean }).ok) throw new Error(`synth failed: ${JSON.stringify(r)}`);
  return (r as { ok: true; value: { brickId: BrickId } }).value.brickId;
}

/**
 * Bypasses the LLM-facing tool to inject artifacts whose scope (zone) the tool
 * would reject, or whose ownerAgentId differs from the current caller. The
 * provenance shape mirrors `buildProvenance` in `forge-tool.ts`.
 */
async function injectBrick(opts: {
  readonly ownerAgentId: string;
  readonly scope: ForgeScope;
  readonly name?: string;
}): Promise<BrickId> {
  const name = opts.name ?? "injected";
  const implementation = `return ${JSON.stringify(name)};`;
  const id = computeIdentityBrickId({
    kind: "tool",
    name,
    description: name,
    version: "0.0.1",
    scope: opts.scope,
    ownerAgentId: opts.ownerAgentId,
    content: { implementation, inputSchema: { type: "object" } },
  });
  const now = Date.now();
  const provenance: ForgeProvenance = {
    source: { origin: "forged", forgedBy: opts.ownerAgentId, sessionId: "s1" },
    buildDefinition: {
      buildType: "https://koi.dev/forge-tools/v1",
      externalParameters: {},
    },
    builder: { id: "@koi/forge-tools" },
    metadata: {
      invocationId: id,
      startedAt: now,
      finishedAt: now,
      sessionId: "s1",
      agentId: opts.ownerAgentId,
      depth: 0,
    },
    verification: {
      passed: false,
      sandbox: true,
      totalDurationMs: 0,
      stageResults: [],
    },
    classification: "internal",
    contentMarkers: [],
    contentHash: id,
  };
  const artifact: ToolArtifact = {
    id,
    kind: "tool",
    name,
    description: name,
    scope: opts.scope,
    origin: "forged",
    policy: DEFAULT_SANDBOXED_POLICY,
    lifecycle: "draft",
    provenance,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    implementation,
    inputSchema: { type: "object" },
  };
  const saved = await store.save(artifact);
  if (!saved.ok) throw new Error(`inject failed: ${JSON.stringify(saved.error)}`);
  return id;
}

describe("forge_inspect", () => {
  test("returns artifact for caller's own agent-scoped brick", async () => {
    const id = await synthAs("agent-A", "mine");
    const tool = createForgeInspectTool({ store });
    const r = await runWithExecutionContext(makeContext("agent-A"), () =>
      tool.execute({ brickId: id }),
    );
    const ok = r as { ok: true; value: { artifact: { id: string; kind: string } } };
    expect(ok.ok).toBe(true);
    expect(ok.value.artifact.id).toBe(id);
    expect(ok.value.artifact.kind).toBe("tool");
  });

  test("returns NOT_FOUND for unknown id", async () => {
    const ghostId = await injectBrick({ ownerAgentId: "agent-A", scope: "agent", name: "ghost" });
    await store.remove(ghostId);
    const tool = createForgeInspectTool({ store });
    const r = await runWithExecutionContext(makeContext("agent-A"), () =>
      tool.execute({ brickId: ghostId }),
    );
    const err = r as { ok: false; error: { code: string } };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe("NOT_FOUND");
  });

  test("returns NOT_FOUND for known peer-agent agent-scoped brick (existence non-leak)", async () => {
    const peerId = await injectBrick({
      ownerAgentId: "agent-B",
      scope: "agent",
      name: "peer-private",
    });
    const tool = createForgeInspectTool({ store });
    const r = await runWithExecutionContext(makeContext("agent-A"), () =>
      tool.execute({ brickId: peerId }),
    );
    const err = r as { ok: false; error: { code: string } };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe("NOT_FOUND");
  });

  test("returns NOT_FOUND for any zone-scoped brick (zone hidden)", async () => {
    const zid = await injectBrick({ ownerAgentId: "agent-A", scope: "zone", name: "zonal" });
    const tool = createForgeInspectTool({ store });
    const r = await runWithExecutionContext(makeContext("agent-A"), () =>
      tool.execute({ brickId: zid }),
    );
    const err = r as { ok: false; error: { code: string } };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe("NOT_FOUND");
  });

  test("returns global-scoped brick to any caller", async () => {
    const gid = await injectBrick({ ownerAgentId: "agent-B", scope: "global", name: "g" });
    const tool = createForgeInspectTool({ store });
    const r = await runWithExecutionContext(makeContext("agent-A"), () =>
      tool.execute({ brickId: gid }),
    );
    const ok = r as { ok: true; value: { artifact: { id: string } } };
    expect(ok.ok).toBe(true);
    expect(ok.value.artifact.id).toBe(gid);
  });

  test("rejects malformed brickId with VALIDATION", async () => {
    const tool = createForgeInspectTool({ store });
    const r = await runWithExecutionContext(makeContext("agent-A"), () =>
      tool.execute({ brickId: "not-a-real-id" }),
    );
    const err = r as { ok: false; error: { code: string } };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe("VALIDATION");
  });

  test("descriptor is a primordial ToolDescriptor with JSON Schema input", () => {
    const tool = createForgeInspectTool({ store });
    expect(tool.descriptor.name).toBe("forge_inspect");
    expect(tool.descriptor.origin).toBe("primordial");
    expect(typeof tool.descriptor.description).toBe("string");
    expect(tool.descriptor.inputSchema).toBeDefined();
  });

  test("throws NO_CONTEXT when invoked outside any execution context", async () => {
    const tool = createForgeInspectTool({ store });
    let caught: unknown;
    try {
      await tool.execute({ brickId: brickId(`sha256:${"0".repeat(64)}`) });
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) expect(caught.message).toMatch(/NO_CONTEXT/);
  });
});
