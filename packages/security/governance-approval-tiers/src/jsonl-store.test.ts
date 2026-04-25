import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@koi/core";
import { computeGrantKey } from "@koi/hash";
import { createJsonlApprovalStore } from "./jsonl-store.js";
import type { AliasSpec, PersistedApproval } from "./types.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "approval-tiers-"));
  path = join(dir, "approvals.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createJsonlApprovalStore", () => {
  it("returns undefined when the file does not exist", async () => {
    const store = createJsonlApprovalStore({ path });
    expect(
      await store.match({ kind: "tool_call", payload: {} satisfies JsonObject }),
    ).toBeUndefined();
    expect(await store.load()).toEqual([]);
  });

  it("appends one grant per line", async () => {
    const store = createJsonlApprovalStore({ path });
    const g1: PersistedApproval = {
      kind: "tool_call",
      payload: { tool: "bash", cmd: "ls" } satisfies JsonObject,
      grantKey: computeGrantKey("tool_call", { tool: "bash", cmd: "ls" }),
      grantedAt: 1,
    };
    const g2: PersistedApproval = {
      kind: "tool_call",
      payload: { tool: "bash", cmd: "rm" } satisfies JsonObject,
      grantKey: computeGrantKey("tool_call", { tool: "bash", cmd: "rm" }),
      grantedAt: 2,
    };
    await store.append(g1);
    await store.append(g2);
    const raw = await readFile(path, "utf8");
    expect(raw.split("\n").filter((l) => l.length > 0).length).toBe(2);
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("matches a stored grant by canonical (kind, payload)", async () => {
    const store = createJsonlApprovalStore({ path });
    const payload = { tool: "bash", cmd: "ls" } satisfies JsonObject;
    await store.append({
      kind: "tool_call",
      payload,
      grantKey: computeGrantKey("tool_call", payload),
      grantedAt: 1,
    });
    const hit = await store.match({ kind: "tool_call", payload });
    expect(hit?.grantKey).toBe(computeGrantKey("tool_call", payload));
  });

  it("persists across store instances (read-path)", async () => {
    const a = createJsonlApprovalStore({ path });
    const payload = { tool: "bash" } satisfies JsonObject;
    await a.append({
      kind: "tool_call",
      payload,
      grantKey: computeGrantKey("tool_call", payload),
      grantedAt: 1,
    });
    const b = createJsonlApprovalStore({ path });
    const hit = await b.match({ kind: "tool_call", payload });
    expect(hit).toBeDefined();
  });

  it("skips malformed lines and loads the rest", async () => {
    const good: PersistedApproval = {
      kind: "tool_call",
      payload: { tool: "bash" } satisfies JsonObject,
      grantKey: computeGrantKey("tool_call", { tool: "bash" }),
      grantedAt: 1,
    };
    await writeFile(path, `${JSON.stringify(good)}\nnot-json\n\n`);
    const store = createJsonlApprovalStore({ path });
    const loaded = await store.load();
    expect(loaded.length).toBe(1);
    expect(loaded[0]?.grantKey).toBe(good.grantKey);
  });

  it("rewrites query via aliases before matching", async () => {
    const aliases: readonly AliasSpec[] = [
      { kind: "tool_call", field: "tool", from: "bash_exec", to: "bash" },
    ];
    const store = createJsonlApprovalStore({ path, aliases });
    const newPayload = { tool: "bash" } satisfies JsonObject;
    await store.append({
      kind: "tool_call",
      payload: newPayload,
      grantKey: computeGrantKey("tool_call", newPayload),
      grantedAt: 1,
    });
    const hit = await store.match({
      kind: "tool_call",
      payload: { tool: "bash_exec" } satisfies JsonObject,
    });
    expect(hit).toBeDefined();
  });

  it("serialises concurrent appends without losing writes", async () => {
    const store = createJsonlApprovalStore({ path });
    const grants = Array.from({ length: 20 }, (_, i) => {
      const payload = { tool: "bash", n: i } satisfies JsonObject;
      return {
        kind: "tool_call" as const,
        payload,
        grantKey: computeGrantKey("tool_call", payload),
        grantedAt: i,
      };
    });
    await Promise.all(grants.map((g) => store.append(g)));
    const loaded = await store.load();
    expect(loaded.length).toBe(20);
  });

  it("creates the parent directory if missing", async () => {
    const deep = join(dir, "nested", "path", "approvals.json");
    const store = createJsonlApprovalStore({ path: deep });
    const payload = { tool: "bash" } satisfies JsonObject;
    await store.append({
      kind: "tool_call",
      payload,
      grantKey: computeGrantKey("tool_call", payload),
      grantedAt: 1,
    });
    const loaded = await store.load();
    expect(loaded.length).toBe(1);
  });

  // Regression: cross-process concurrent appends lost ~30% of writes under
  // read-modify-write. O_APPEND on sub-PIPE_BUF payloads is POSIX-atomic,
  // so two processes cannot interleave mid-line or overwrite each other.
  it("preserves every write when two processes append concurrently", async () => {
    const runner = join(dir, "runner.ts");
    await writeFile(
      runner,
      `
import { createJsonlApprovalStore } from "${join(import.meta.dir, "jsonl-store.ts")}";
const store = createJsonlApprovalStore({ path: process.argv[2] });
const label = process.argv[3];
const count = Number(process.argv[4]);
await Promise.all(
  Array.from({ length: count }, (_, i) =>
    store.append({
      kind: "tool_call",
      payload: { tool: "bash", n: i, w: label },
      grantKey: label + "-" + i,
      grantedAt: i,
    }),
  ),
);
`,
    );
    const procA = Bun.spawn(["bun", "run", runner, path, "A", "50"], { stdout: "pipe" });
    const procB = Bun.spawn(["bun", "run", runner, path, "B", "50"], { stdout: "pipe" });
    await Promise.all([procA.exited, procB.exited]);
    const store = createJsonlApprovalStore({ path });
    const loaded = await store.load();
    expect(loaded.length).toBe(100);
    const keys = new Set(loaded.map((r) => r.grantKey));
    expect(keys.size).toBe(100);
  });
});
