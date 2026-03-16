import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionId } from "@koi/core";
import { makeTranscriptEntry, runSessionTranscriptContractTests } from "@koi/test-utils";
import { createJsonlTranscript } from "./jsonl-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "koi-transcript-"));
}

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

describe("JsonlTranscript", () => {
  const tmpDirs: string[] = [];

  function createStore(): ReturnType<typeof createJsonlTranscript> {
    // Use a synchronous trick: create the dir eagerly via Bun
    const dir = join(
      tmpdir(),
      `koi-transcript-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    // We need sync dir creation for the factory pattern
    Bun.spawnSync(["mkdir", "-p", dir]);
    tmpDirs.push(dir);
    return createJsonlTranscript({ baseDir: dir });
  }

  afterEach(async () => {
    for (const dir of tmpDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  runSessionTranscriptContractTests(() => createStore());

  // -----------------------------------------------------------------------
  // JSONL-specific edge cases
  // -----------------------------------------------------------------------

  describe("JSONL edge cases", () => {
    test("crash recovery: trailing malformed line is skipped", async () => {
      const dir = await makeTmpDir();
      tmpDirs.push(dir);
      const store = createJsonlTranscript({ baseDir: dir });
      const sid = sessionId("crash-test");

      // Append valid entries
      const entry = makeTranscriptEntry({ content: "valid entry" });
      await store.append(sid, [entry]);

      // Simulate crash: append a truncated line directly to the file
      const { Glob } = Bun;
      const glob = new Glob(`*/${sid}.jsonl`);
      let filePath: string | undefined;
      for await (const match of glob.scan({ cwd: dir, absolute: false })) {
        filePath = join(dir, match);
      }
      expect(filePath).toBeDefined();
      if (filePath) {
        const existing = await Bun.file(filePath).text();
        await Bun.write(filePath, `${existing}{"id":"broken","role":"user","content":"trun`);
      }

      const result = await store.load(sid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.length).toBe(1);
        expect(result.value.entries[0]?.content).toBe("valid entry");
        expect(result.value.skipped.length).toBe(1);
        expect(result.value.skipped[0]?.lineNumber).toBe(2);
      }
    });

    test("empty/missing file returns empty entries", async () => {
      const dir = await makeTmpDir();
      tmpDirs.push(dir);
      const store = createJsonlTranscript({ baseDir: dir });

      const result = await store.load(sessionId("nonexistent"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.length).toBe(0);
        expect(result.value.skipped.length).toBe(0);
      }
    });

    test("directory auto-creation on append", async () => {
      const dir = join(tmpdir(), `koi-transcript-auto-${Date.now()}`);
      tmpDirs.push(dir);
      const store = createJsonlTranscript({ baseDir: dir });
      const sid = sessionId("auto-dir");

      const result = await store.append(sid, [makeTranscriptEntry({ content: "first" })]);
      expect(result.ok).toBe(true);

      const loadResult = await store.load(sid);
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.entries.length).toBe(1);
        expect(loadResult.value.entries[0]?.content).toBe("first");
      }
    });

    test("unicode content survives JSONL round-trip", async () => {
      const dir = await makeTmpDir();
      tmpDirs.push(dir);
      const store = createJsonlTranscript({ baseDir: dir });
      const sid = sessionId("unicode");

      const entry = makeTranscriptEntry({
        content: "Hello 工具-名前-도구 🤖 مرحبا 🎉",
      });
      await store.append(sid, [entry]);

      const result = await store.load(sid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries[0]?.content).toBe("Hello 工具-名前-도구 🤖 مرحبا 🎉");
      }
    });

    test("large entries (>4KB) survive round-trip", async () => {
      const dir = await makeTmpDir();
      tmpDirs.push(dir);
      const store = createJsonlTranscript({ baseDir: dir });
      const sid = sessionId("large");

      const largeContent = "x".repeat(8192);
      const entry = makeTranscriptEntry({ content: largeContent });
      await store.append(sid, [entry]);

      const result = await store.load(sid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries[0]?.content).toBe(largeContent);
        expect(result.value.entries[0]?.content.length).toBe(8192);
      }
    });

    test("concurrent appends: both entries present", async () => {
      const dir = await makeTmpDir();
      tmpDirs.push(dir);
      const store = createJsonlTranscript({ baseDir: dir });
      const sid = sessionId("concurrent");

      const e1 = makeTranscriptEntry({ content: "first" });
      const e2 = makeTranscriptEntry({ content: "second" });

      // Two rapid appends (sequential since JSONL is not safe for true concurrent writes)
      await store.append(sid, [e1]);
      await store.append(sid, [e2]);

      const result = await store.load(sid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.length).toBe(2);
        const contents = result.value.entries.map((e) => e.content);
        expect(contents).toContain("first");
        expect(contents).toContain("second");
      }
    });

    test("mid-file corruption is reported in skipped", async () => {
      const dir = await makeTmpDir();
      tmpDirs.push(dir);
      const store = createJsonlTranscript({ baseDir: dir });
      const sid = sessionId("corrupt-mid");

      // Write valid entries, then corrupt middle, then valid
      const e1 = makeTranscriptEntry({ content: "first" });
      const e2 = makeTranscriptEntry({ content: "third" });
      await store.append(sid, [e1]);

      // Find file and inject corruption
      const { Glob } = Bun;
      const glob = new Glob(`*/${sid}.jsonl`);
      let filePath: string | undefined;
      for await (const match of glob.scan({ cwd: dir, absolute: false })) {
        filePath = join(dir, match);
      }
      expect(filePath).toBeDefined();
      if (filePath) {
        const existing = await Bun.file(filePath).text();
        const corruptLine = "NOT VALID JSON\n";
        const validLine = `${JSON.stringify(e2)}\n`;
        await Bun.write(filePath, `${existing}${corruptLine}${validLine}`);
      }

      const result = await store.load(sid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.length).toBe(2);
        expect(result.value.entries[0]?.content).toBe("first");
        expect(result.value.entries[1]?.content).toBe("third");
        expect(result.value.skipped.length).toBe(1);
        expect(result.value.skipped[0]?.lineNumber).toBe(2);
      }
    });

    test("append to non-writable dir returns INTERNAL error", async () => {
      const store = createJsonlTranscript({ baseDir: "/dev/null/impossible" });
      const sid = sessionId("err-append");
      const result = await store.append(sid, [makeTranscriptEntry()]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INTERNAL");
      }
    });

    test("remove non-existent file is a no-op success", async () => {
      const dir = await makeTmpDir();
      tmpDirs.push(dir);
      const store = createJsonlTranscript({ baseDir: dir });
      const result = await store.remove(sessionId("does-not-exist"));
      expect(result.ok).toBe(true);
    });

    test("compact on non-existent session is a no-op success", async () => {
      const dir = await makeTmpDir();
      tmpDirs.push(dir);
      const store = createJsonlTranscript({ baseDir: dir });
      const result = await store.compact(sessionId("does-not-exist"), "summary", 2);
      expect(result.ok).toBe(true);
    });

    test("valid JSON that does not match schema is reported as skipped", async () => {
      const dir = await makeTmpDir();
      tmpDirs.push(dir);
      const store = createJsonlTranscript({ baseDir: dir });
      const sid = sessionId("bad-schema");

      // Append a valid entry first so the file/dir exists
      await store.append(sid, [makeTranscriptEntry({ content: "good" })]);

      // Find the file and write a valid-JSON but invalid-schema line
      const dirs = await import("node:fs/promises").then((m) => m.readdir(dir));
      let filePath: string | undefined;
      for (const d of dirs) {
        const candidate = join(dir, d, `${sid}.jsonl`);
        if (await Bun.file(candidate).exists()) {
          filePath = candidate;
        }
      }
      expect(filePath).toBeDefined();
      if (filePath) {
        await import("node:fs/promises").then((m) =>
          m.appendFile(filePath, `${JSON.stringify({ notATranscript: true })}\n`),
        );
      }

      const result = await store.load(sid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.length).toBe(1);
        expect(result.value.entries[0]?.content).toBe("good");
        expect(result.value.skipped.length).toBe(1);
        expect(result.value.skipped[0]?.error).toContain("does not match TranscriptEntry schema");
      }
    });

    test("path traversal in sessionId is rejected", async () => {
      const dir = await makeTmpDir();
      tmpDirs.push(dir);
      const store = createJsonlTranscript({ baseDir: dir });

      const result = await store.append(sessionId("../escape"), [makeTranscriptEntry()]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("load on non-existent baseDir returns empty", async () => {
      const store = createJsonlTranscript({ baseDir: "/tmp/koi-nonexistent-dir-xyz" });
      const result = await store.load(sessionId("any"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.length).toBe(0);
      }
    });

    test("compact rejects negative preserveLastN", async () => {
      const dir = await makeTmpDir();
      tmpDirs.push(dir);
      const store = createJsonlTranscript({ baseDir: dir });
      const result = await store.compact(sessionId("s1"), "summary", -1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("compact with preserveLastN=0 keeps only compaction entry", async () => {
      const dir = await makeTmpDir();
      tmpDirs.push(dir);
      const store = createJsonlTranscript({ baseDir: dir });
      const sid = sessionId("compact-zero");

      const entries = Array.from({ length: 5 }, (_, i) =>
        makeTranscriptEntry({ content: `msg-${i}`, timestamp: 1000 * (i + 1) }),
      );
      await store.append(sid, entries);

      const compactResult = await store.compact(sid, "Full conversation summary", 0);
      expect(compactResult.ok).toBe(true);

      const loadResult = await store.load(sid);
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.entries.length).toBe(1);
        expect(loadResult.value.entries[0]?.role).toBe("compaction");
        expect(loadResult.value.entries[0]?.content).toBe("Full conversation summary");
      }
    });
  });
});
