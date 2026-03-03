import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEntry } from "@koi/core";
import { createNdjsonAuditSink } from "./ndjson-sink.js";

function createEntry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    timestamp: Date.now(),
    sessionId: "session-1",
    agentId: "agent-1",
    turnIndex: 0,
    kind: "tool_call",
    durationMs: 100,
    ...overrides,
  };
}

describe("createNdjsonAuditSink", () => {
  // let justified: temp dir changes per test
  let tempDir: string;
  // let justified: file path changes per test
  let filePath: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function setup(): Promise<void> {
    tempDir = await mkdtemp(join(tmpdir(), "koi-audit-"));
    filePath = join(tempDir, "audit.ndjson");
  }

  test("log writes one JSON line per entry", async () => {
    await setup();
    const sink = createNdjsonAuditSink({ filePath });

    await sink.log(createEntry({ turnIndex: 0 }));
    await sink.log(createEntry({ turnIndex: 1 }));

    const entries = await sink.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.turnIndex).toBe(0);
    expect(entries[1]?.turnIndex).toBe(1);

    sink.close();
  });

  test("entries are valid JSON objects", async () => {
    await setup();
    const sink = createNdjsonAuditSink({ filePath });

    await sink.log(createEntry({ metadata: { key: "value" } }));

    const entries = await sink.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.metadata).toEqual({ key: "value" });

    sink.close();
  });

  test("redaction rules are applied", async () => {
    await setup();
    const sink = createNdjsonAuditSink({
      filePath,
      redactionRules: [{ pattern: /password123/g, replacement: "***" }],
    });

    await sink.log(createEntry({ request: { password: "password123" } }));

    const entries = await sink.getEntries();
    const req = entries[0]?.request as { password: string } | undefined;
    expect(req?.password).toBe("***");

    sink.close();
  });

  test("getEntries returns empty array when file does not exist", async () => {
    await setup();
    const sink = createNdjsonAuditSink({ filePath: join(tempDir, "nonexistent.ndjson") });

    const entries = await sink.getEntries();
    expect(entries).toHaveLength(0);

    sink.close();
  });
});
