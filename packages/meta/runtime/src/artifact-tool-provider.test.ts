/**
 * Unit tests for createArtifactToolProvider.
 *
 * Covers the behaviour the TUI wiring depends on:
 *   - all 4 tools (save/get/list/delete) are attached on the provider
 *   - each tool's execute returns a JSON-serialisable envelope
 *   - session-scoping: owner can read, non-owner gets not_found
 *   - not_found round-trip to model (ok:false + error.kind = "not_found")
 *   - empty list returns ok:true, count: 0, items: []
 *   - delete then get returns not_found
 *   - tags and includeShared filters flow through listArtifacts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ArtifactStore, createArtifactStore } from "@koi/artifacts";
import type { Agent, JsonObject, Tool } from "@koi/core";
import { agentId, DEFAULT_SANDBOXED_POLICY, isAttachResult, sessionId, toolToken } from "@koi/core";
import { createArtifactToolProvider } from "./artifact-tool-provider.js";

const OWNER = sessionId("unit-owner");
const STRANGER = sessionId("unit-stranger");

const stubAgent: Agent = {
  pid: {
    id: agentId("unit-agent"),
    name: "stub",
    type: "worker",
    depth: 0,
  },
  manifest: {} as Agent["manifest"],
  state: "created",
  component: () => undefined,
  has: () => false,
  hasAll: () => false,
  query: () => new Map(),
  components: () => new Map(),
};

async function attachTools(store: ArtifactStore, sid = OWNER): Promise<Map<string, Tool>> {
  const provider = createArtifactToolProvider({ store, sessionId: sid });
  const result = await provider.attach(stubAgent);
  const components = isAttachResult(result) ? result.components : result;
  const tools = new Map<string, Tool>();
  for (const name of ["artifact_save", "artifact_get", "artifact_list", "artifact_delete"]) {
    const tool = components.get(toolToken(name) as string) as Tool | undefined;
    if (tool === undefined) throw new Error(`tool missing: ${name}`);
    tools.set(name, tool);
  }
  return tools;
}

async function run(tool: Tool, args: JsonObject): Promise<JsonObject> {
  return (await tool.execute(args)) as JsonObject;
}

function pick(tools: Map<string, Tool>, name: string): Tool {
  const t = tools.get(name);
  if (t === undefined) throw new Error(`tool missing: ${name}`);
  return t;
}

describe("createArtifactToolProvider", () => {
  let blobDir: string;
  let dbPath: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    blobDir = join(tmpdir(), `koi-atp-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    dbPath = join(blobDir, "store.db");
    store = await createArtifactStore({ dbPath, blobDir });
  });

  afterEach(async () => {
    await store.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  test("attach returns all 4 tools with descriptors", async () => {
    const tools = await attachTools(store);
    expect(tools.size).toBe(4);
    expect(tools.get("artifact_save")?.descriptor.description).toContain("Save UTF-8 text");
    expect(tools.get("artifact_get")?.descriptor.inputSchema).toMatchObject({
      required: ["id"],
    });
    // Policy defaults to BUNDLED tooling posture.
    for (const t of tools.values()) {
      expect(t.policy).toBeDefined();
      expect(t.origin).toBe("primordial");
    }
    expect(DEFAULT_SANDBOXED_POLICY).toBeDefined(); // sanity: policy constant importable
  });

  test("artifact_save + artifact_get round-trip returns original bytes", async () => {
    const tools = await attachTools(store);
    const saved = await run(pick(tools, "artifact_save"), {
      name: "round.txt",
      content: "unit-content",
    });
    expect(saved.ok).toBe(true);
    expect(typeof saved.id).toBe("string");
    expect(saved.version).toBe(1);
    expect(saved.size).toBe("unit-content".length);
    expect(typeof saved.contentHash).toBe("string");

    const got = await run(pick(tools, "artifact_get"), { id: saved.id as string });
    expect(got.ok).toBe(true);
    expect(got.content).toBe("unit-content");
  });

  test("artifact_get with unknown id returns ok:false + error.kind='not_found'", async () => {
    const tools = await attachTools(store);
    const got = await run(pick(tools, "artifact_get"), {
      id: "art_00000000-0000-0000-0000-000000000000",
    });
    expect(got.ok).toBe(false);
    const err = got.error as { readonly kind: string };
    expect(err.kind).toBe("not_found");
  });

  test("artifact_list on empty store returns count:0 and items:[]", async () => {
    const tools = await attachTools(store);
    const listed = await run(pick(tools, "artifact_list"), {});
    expect(listed.ok).toBe(true);
    expect(listed.count).toBe(0);
    expect(listed.items).toEqual([]);
  });

  test("artifact_list passes name + tags + includeShared filters", async () => {
    const tools = await attachTools(store);
    const save = pick(tools, "artifact_save");
    await run(save, { name: "a.txt", content: "x", tags: ["red"] });
    await run(save, { name: "a.txt", content: "y", tags: ["blue"] });
    await run(save, { name: "b.txt", content: "z", tags: ["red", "blue"] });

    // name filter: both a.txt versions, not b.txt
    const byName = await run(pick(tools, "artifact_list"), { name: "a.txt" });
    expect(byName.count).toBe(2);
    for (const item of byName.items as readonly { readonly name: string }[]) {
      expect(item.name).toBe("a.txt");
    }

    // tag filter: red → a.txt (v1) + b.txt = 2
    const byTag = await run(pick(tools, "artifact_list"), { tags: ["red"] });
    expect(byTag.count).toBe(2);

    // compound filter: name=a.txt AND tag=blue → only a.txt v2
    const compound = await run(pick(tools, "artifact_list"), {
      name: "a.txt",
      tags: ["blue"],
    });
    expect(compound.count).toBe(1);

    // includeShared: self-session listing is unaffected by default-true — just ensure no throw
    const withShared = await run(pick(tools, "artifact_list"), { includeShared: true });
    expect(withShared.count).toBe(3);
    const withoutShared = await run(pick(tools, "artifact_list"), { includeShared: false });
    expect(withoutShared.count).toBe(3);
  });

  test("cross-session artifact_get returns not_found (probe-resistant ACL)", async () => {
    const ownerTools = await attachTools(store, OWNER);
    const saved = await run(pick(ownerTools, "artifact_save"), {
      name: "secret.txt",
      content: "hidden",
    });
    expect(saved.ok).toBe(true);

    const strangerTools = await attachTools(store, STRANGER);
    const probe = await run(pick(strangerTools, "artifact_get"), { id: saved.id as string });
    expect(probe.ok).toBe(false);
    expect((probe.error as { readonly kind: string }).kind).toBe("not_found");
  });

  test("artifact_delete then artifact_get returns not_found", async () => {
    const tools = await attachTools(store);
    const saved = await run(pick(tools, "artifact_save"), {
      name: "gone.txt",
      content: "bye",
    });
    const id = saved.id as string;

    const deleted = await run(pick(tools, "artifact_delete"), { id });
    expect(deleted.ok).toBe(true);

    const got = await run(pick(tools, "artifact_get"), { id });
    expect(got.ok).toBe(false);
    expect((got.error as { readonly kind: string }).kind).toBe("not_found");

    // listing after delete shows nothing
    const listed = await run(pick(tools, "artifact_list"), {});
    expect(listed.count).toBe(0);
  });

  test("artifact_save coerces missing mimeType to text/plain", async () => {
    const tools = await attachTools(store);
    const saved = await run(pick(tools, "artifact_save"), {
      name: "default-mime.txt",
      content: "hi",
    });
    expect(saved.ok).toBe(true);

    const got = await run(pick(tools, "artifact_get"), { id: saved.id as string });
    expect(got.ok).toBe(true);
    expect(got.mimeType).toBe("text/plain");
  });

  test("artifact_save ignores a non-string-array tags input (no throw)", async () => {
    const tools = await attachTools(store);
    // tags with mixed types → helper treats the whole thing as undefined
    const saved = await run(pick(tools, "artifact_save"), {
      name: "bad-tags.txt",
      content: "hi",
      tags: ["ok", 42, null] as unknown as readonly string[],
    });
    expect(saved.ok).toBe(true);

    // Listing by the partial-valid tag "ok" must NOT match — the provider dropped the whole array.
    const listed = await run(pick(tools, "artifact_list"), { tags: ["ok"] });
    expect(listed.count).toBe(0);
  });
});
