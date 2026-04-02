import { afterEach, describe, expect, test } from "bun:test";
import { rmdir } from "node:fs/promises";
import type { AtifDocument } from "./atif-types.js";
import { createFsAtifDelegate } from "./fs-delegate.js";

const TEST_DIR = `/tmp/koi-atif-test-${Date.now()}`;

describe("createFsAtifDelegate", () => {
  const delegate = createFsAtifDelegate(TEST_DIR);

  const DOC: AtifDocument = {
    schema_version: "ATIF-v1.6",
    session_id: "test-session",
    agent: { name: "test-agent" },
    steps: [
      {
        step_id: 0,
        source: "agent",
        timestamp: new Date().toISOString(),
        model_name: "test-model",
        message: "hello",
        outcome: "success",
        duration_ms: 100,
      },
    ],
  };

  afterEach(async () => {
    try {
      await rmdir(TEST_DIR, { recursive: true });
    } catch {
      // ignore
    }
  });

  test("write and read a document", async () => {
    await delegate.write("doc1", DOC);
    const result = await delegate.read("doc1");
    expect(result).toBeDefined();
    expect(result?.session_id).toBe("test-session");
    expect(result?.steps).toHaveLength(1);
  });

  test("read returns undefined for missing document", async () => {
    const result = await delegate.read("nonexistent");
    expect(result).toBeUndefined();
  });

  test("list returns original docIds (decoded from percent-encoded filenames)", async () => {
    await delegate.write("alpha", DOC);
    await delegate.write("beta", DOC);
    const ids = await delegate.list();
    expect(ids).toContain("alpha");
    expect(ids).toContain("beta");
  });

  test("delete removes a document", async () => {
    await delegate.write("to-delete", DOC);
    const deleted = await delegate.delete("to-delete");
    expect(deleted).toBe(true);
    const result = await delegate.read("to-delete");
    expect(result).toBeUndefined();
  });

  test("delete returns false for missing document", async () => {
    const deleted = await delegate.delete("never-existed");
    expect(deleted).toBe(false);
  });

  test("percent-encodes docId to prevent path traversal", async () => {
    await delegate.write("../../../etc/passwd", DOC);
    const result = await delegate.read("../../../etc/passwd");
    expect(result).toBeDefined();
    // list() decodes back to the original docId
    const ids = await delegate.list();
    expect(ids).toContain("../../../etc/passwd");
  });

  test("different docIds with similar chars produce different files (no collision)", async () => {
    const docA: AtifDocument = { ...DOC, session_id: "tenant/a" };
    const docB: AtifDocument = { ...DOC, session_id: "tenant_a" };
    const docC: AtifDocument = { ...DOC, session_id: "tenant:a" };

    await delegate.write("tenant/a", docA);
    await delegate.write("tenant_a", docB);
    await delegate.write("tenant:a", docC);

    // All three should coexist — no overwrites
    const ids = await delegate.list();
    expect(ids).toContain("tenant/a");
    expect(ids).toContain("tenant_a");
    expect(ids).toContain("tenant:a");
    expect(ids).toHaveLength(3);

    // Each should have its own data
    const readA = await delegate.read("tenant/a");
    const readB = await delegate.read("tenant_a");
    const readC = await delegate.read("tenant:a");
    expect(readA?.session_id).toBe("tenant/a");
    expect(readB?.session_id).toBe("tenant_a");
    expect(readC?.session_id).toBe("tenant:a");
  });
});
