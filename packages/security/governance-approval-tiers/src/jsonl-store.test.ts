import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@koi/core";
import { agentId as mkAgentId } from "@koi/core";
import { computeGrantKey } from "@koi/hash";
import { createJsonlApprovalStore } from "./jsonl-store.js";
import type { AliasSpec, PersistedApproval } from "./types.js";

let dir: string;
let path: string;
const AID = mkAgentId("test-agent");
const OTHER_AID = mkAgentId("other-agent");

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
      await store.match({
        kind: "tool_call",
        agentId: AID,
        payload: {} satisfies JsonObject,
      }),
    ).toBeUndefined();
    expect(await store.load()).toEqual([]);
  });

  it("appends one grant per line", async () => {
    const store = createJsonlApprovalStore({ path });
    const g1: PersistedApproval = {
      kind: "tool_call",
      agentId: AID,
      payload: { tool: "bash", cmd: "ls" } satisfies JsonObject,
      grantKey: computeGrantKey("tool_call", { tool: "bash", cmd: "ls" }),
      grantedAt: 1,
    };
    const g2: PersistedApproval = {
      kind: "tool_call",
      agentId: AID,
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

  it("matches a stored grant by canonical (kind, agentId, payload)", async () => {
    const store = createJsonlApprovalStore({ path });
    const payload = { tool: "bash", cmd: "ls" } satisfies JsonObject;
    await store.append({
      kind: "tool_call",
      agentId: AID,
      payload,
      grantKey: computeGrantKey("tool_call", payload),
      grantedAt: 1,
    });
    const hit = await store.match({ kind: "tool_call", agentId: AID, payload });
    expect(hit?.grantKey).toBe(computeGrantKey("tool_call", payload));
  });

  // Regression for codex round-1 finding: persisted grants must NOT
  // satisfy queries from a different agent, even when (kind, payload)
  // are identical.
  it("does not match a query from a different agentId", async () => {
    const store = createJsonlApprovalStore({ path });
    const payload = { tool: "bash", cmd: "ls" } satisfies JsonObject;
    await store.append({
      kind: "tool_call",
      agentId: AID,
      payload,
      grantKey: computeGrantKey("tool_call", payload),
      grantedAt: 1,
    });
    const hit = await store.match({ kind: "tool_call", agentId: OTHER_AID, payload });
    expect(hit).toBeUndefined();
  });

  it("persists across store instances (read-path)", async () => {
    const a = createJsonlApprovalStore({ path });
    const payload = { tool: "bash" } satisfies JsonObject;
    await a.append({
      kind: "tool_call",
      agentId: AID,
      payload,
      grantKey: computeGrantKey("tool_call", payload),
      grantedAt: 1,
    });
    const b = createJsonlApprovalStore({ path });
    const hit = await b.match({ kind: "tool_call", agentId: AID, payload });
    expect(hit).toBeDefined();
  });

  it("skips malformed lines and loads the rest", async () => {
    const good: PersistedApproval = {
      kind: "tool_call",
      agentId: AID,
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

  // Codex round-1 finding: read failures must not bubble out of match —
  // they should fall through to ask. Simulate via chmod 0 on a regular
  // file so exists() returns true but text() rejects with EACCES.
  it("returns undefined from match when the store cannot be read", async () => {
    const blocked = join(dir, "blocked.json");
    await writeFile(blocked, "");
    await chmod(blocked, 0);
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const store = createJsonlApprovalStore({ path: blocked });
      const hit = await store.match({
        kind: "tool_call",
        agentId: AID,
        payload: { tool: "bash" } satisfies JsonObject,
      });
      expect(hit).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      // Restore mode so afterEach can rm the dir.
      await chmod(blocked, 0o600).catch(() => undefined);
    }
  });

  it("rewrites the new-side query via aliases before matching", async () => {
    const aliases: readonly AliasSpec[] = [
      { kind: "tool_call", field: "tool", from: "bash_exec", to: "bash" },
    ];
    const store = createJsonlApprovalStore({ path, aliases });
    const newPayload = { tool: "bash" } satisfies JsonObject;
    await store.append({
      kind: "tool_call",
      agentId: AID,
      payload: newPayload,
      grantKey: computeGrantKey("tool_call", newPayload),
      grantedAt: 1,
    });
    const hit = await store.match({
      kind: "tool_call",
      agentId: AID,
      payload: { tool: "bash_exec" } satisfies JsonObject,
    });
    expect(hit).toBeDefined();
  });

  // Codex round-1 finding: an old-value approval must still match a
  // new-value query AFTER it is canonicalised on append. Persist with
  // pre-migration value, query with post-migration value.
  it("canonicalises grants on append so old-value approvals match new-value queries", async () => {
    const aliases: readonly AliasSpec[] = [
      { kind: "tool_call", field: "tool", from: "bash_exec", to: "bash" },
    ];
    const store = createJsonlApprovalStore({ path, aliases });
    const oldPayload = { tool: "bash_exec" } satisfies JsonObject;
    await store.append({
      kind: "tool_call",
      agentId: AID,
      payload: oldPayload,
      // Caller's pre-migration grantKey — store recomputes for canonical form.
      grantKey: computeGrantKey("tool_call", oldPayload),
      grantedAt: 1,
    });
    const hit = await store.match({
      kind: "tool_call",
      agentId: AID,
      payload: { tool: "bash" } satisfies JsonObject,
    });
    expect(hit).toBeDefined();
    expect(hit?.aliasOf).toBe(computeGrantKey("tool_call", oldPayload));
  });

  it("serialises concurrent appends without losing writes", async () => {
    const store = createJsonlApprovalStore({ path });
    const grants = Array.from({ length: 20 }, (_, i) => {
      const payload = { tool: "bash", n: i } satisfies JsonObject;
      return {
        kind: "tool_call" as const,
        agentId: AID,
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
      agentId: AID,
      payload,
      grantKey: computeGrantKey("tool_call", payload),
      grantedAt: 1,
    });
    const loaded = await store.load();
    expect(loaded.length).toBe(1);
  });

  // Codex round-2 finding: a single rejected writeLine must not poison
  // every later append. The previous implementation chained from a
  // permanently-rejected promise, dropping all subsequent writes.
  // Force a real writeLine failure by pointing at a path under a
  // read-only directory, then restore write permission and verify
  // the next append lands.
  it("recovers the write queue after a transient writeLine failure", async () => {
    const lockedDir = join(dir, "locked");
    const lockedPath = join(lockedDir, "approvals.json");
    const store = createJsonlApprovalStore({ path: lockedPath });
    const ok1: JsonObject = { tool: "bash", cmd: "ls" };
    const ok2: JsonObject = { tool: "bash", cmd: "rm" };
    await mkdir(lockedDir, { recursive: true });
    await chmod(lockedDir, 0o500); // r-x — append cannot create approvals.json
    try {
      await expect(
        store.append({
          kind: "tool_call",
          agentId: AID,
          payload: ok1,
          grantKey: computeGrantKey("tool_call", ok1),
          grantedAt: 1,
        }),
      ).rejects.toThrow();
      await chmod(lockedDir, 0o700); // restore — next append must succeed
      await store.append({
        kind: "tool_call",
        agentId: AID,
        payload: ok2,
        grantKey: computeGrantKey("tool_call", ok2),
        grantedAt: 2,
      });
      const loaded = await store.load();
      expect(loaded.length).toBe(1);
      expect(loaded[0]?.grantKey).toBe(computeGrantKey("tool_call", ok2));
    } finally {
      await chmod(lockedDir, 0o700).catch(() => undefined);
    }
  });

  // Codex round-3 finding: raw payload must NOT be persisted by
  // default — it can carry shell commands, file paths, prompts, and
  // other sensitive content that is not needed for matching.
  it("omits payload from the persisted record by default", async () => {
    const store = createJsonlApprovalStore({ path });
    const payload = { tool: "bash", cmd: "echo super-secret" } satisfies JsonObject;
    await store.append({
      kind: "tool_call",
      agentId: AID,
      payload,
      grantKey: computeGrantKey("tool_call", payload),
      grantedAt: 1,
    });
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("super-secret");
    expect(raw).not.toContain("echo");
    // Match still works — grantKey is recomputed from the live query.
    const hit = await store.match({ kind: "tool_call", agentId: AID, payload });
    expect(hit?.grantKey).toBe(computeGrantKey("tool_call", payload));
    expect(hit?.payload).toBeUndefined();
  });

  it("retains payload when persistPayload: true", async () => {
    const store = createJsonlApprovalStore({ path, persistPayload: true });
    const payload = { tool: "bash", cmd: "ls" } satisfies JsonObject;
    await store.append({
      kind: "tool_call",
      agentId: AID,
      payload,
      grantKey: computeGrantKey("tool_call", payload),
      grantedAt: 1,
    });
    const hit = await store.match({ kind: "tool_call", agentId: AID, payload });
    expect(hit?.payload).toEqual(payload);
  });

  // Codex round-3 finding: tighten file mode to 0o600 so other local
  // users cannot read durable approval grants.
  it("restricts the approvals file mode to owner-only (0o600)", async () => {
    const store = createJsonlApprovalStore({ path });
    const payload = { tool: "bash" } satisfies JsonObject;
    await store.append({
      kind: "tool_call",
      agentId: AID,
      payload,
      grantKey: computeGrantKey("tool_call", payload),
      grantedAt: 1,
    });
    const { stat } = await import("node:fs/promises");
    const s = await stat(path);
    expect(s.mode & 0o777).toBe(0o600);
  });

  // Codex round-3 finding: append must return the canonical stored
  // record so the audit adapter can emit grantKey/aliasOf that match
  // what is durably written.
  it("returns the canonicalised stored record from append", async () => {
    const aliases: readonly AliasSpec[] = [
      { kind: "tool_call", field: "tool", from: "bash_exec", to: "bash" },
    ];
    const store = createJsonlApprovalStore({ path, aliases });
    const oldPayload = { tool: "bash_exec" } satisfies JsonObject;
    const oldGrantKey = computeGrantKey("tool_call", oldPayload);
    const stored = await store.append({
      kind: "tool_call",
      agentId: AID,
      payload: oldPayload,
      grantKey: oldGrantKey,
      grantedAt: 1,
    });
    const newPayload = { tool: "bash" } satisfies JsonObject;
    expect(stored.grantKey).toBe(computeGrantKey("tool_call", newPayload));
    expect(stored.aliasOf).toBe(oldGrantKey);
  });

  // Codex round-1 finding: refuse rows above maxRowBytes so a malicious
  // or buggy caller cannot generate a record larger than the kernel's
  // atomic-write threshold. With persistPayload enabled the row size
  // grows with the input — verify the guard fires before write.
  it("rejects oversized rows when payload retention pushes the row past the limit", async () => {
    const store = createJsonlApprovalStore({ path, maxRowBytes: 200, persistPayload: true });
    const payload = { tool: "bash", filler: "x".repeat(500) } satisfies JsonObject;
    await expect(
      store.append({
        kind: "tool_call",
        agentId: AID,
        payload,
        grantKey: computeGrantKey("tool_call", payload),
        grantedAt: 1,
      }),
    ).rejects.toThrow(/maxRowBytes/);
  });

  // Regression: cross-process concurrent appends lost ~30% of writes
  // under read-modify-write. O_APPEND on bounded rows interleaves at
  // line boundaries with no inter-process race.
  it("preserves every write when two processes append concurrently", async () => {
    // Runner lives inside the package src dir so its `@koi/core` import
    // resolves through the workspace; spawning from a tmp dir without
    // node_modules cannot resolve workspace packages.
    const runner = join(import.meta.dir, "__tests__", "concurrent-runner.ts");
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
