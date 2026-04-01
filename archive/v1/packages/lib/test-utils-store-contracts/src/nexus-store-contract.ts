/**
 * Reusable contract test suite for Nexus namespace store adapters.
 *
 * Tests unified namespace conventions: agent isolation, group sharing,
 * glob boundaries, and path generation consistency.
 *
 * Accepts a factory that returns a NexusStoreAdapter (a minimal interface
 * for read/write/delete/glob operations on a Nexus-like namespace).
 */

import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Adapter interface — minimal surface for namespace testing
// ---------------------------------------------------------------------------

/**
 * Minimal adapter interface that any Nexus-backed store must implement
 * for namespace contract testing. Maps directly to Nexus filesystem ops.
 */
export interface NexusStoreAdapter {
  /** Write content to a path. */
  readonly write: (path: string, content: string) => Promise<Result<void, KoiError>>;
  /** Read content from a path. Returns NOT_FOUND error if missing. */
  readonly read: (path: string) => Promise<Result<string, KoiError>>;
  /** Delete a path. */
  readonly remove: (path: string) => Promise<Result<void, KoiError>>;
  /** Glob for paths matching a pattern. */
  readonly glob: (pattern: string) => Promise<Result<readonly string[], KoiError>>;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

/**
 * Run the Nexus namespace contract test suite against any adapter.
 *
 * Tests namespace conventions from issue #750:
 * - Agent isolation: writes to agent A don't appear in agent B's reads
 * - Group sharing: writes to group path readable by group members
 * - Glob boundary enforcement
 * - Path structure consistency
 */
export function runNexusStoreContractTests(
  createAdapter: () => NexusStoreAdapter | Promise<NexusStoreAdapter>,
): void {
  describe("Nexus namespace contract", () => {
    // -------------------------------------------------------------------
    // Basic read/write/delete
    // -------------------------------------------------------------------

    test("write and read round-trip", async () => {
      const adapter = await createAdapter();
      const path = "agents/a1/bricks/b1.json";
      const content = JSON.stringify({ id: "b1", name: "test" });

      const writeResult = await adapter.write(path, content);
      expect(writeResult.ok).toBe(true);

      const readResult = await adapter.read(path);
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value).toBe(content);
      }
    });

    test("read returns NOT_FOUND for missing path", async () => {
      const adapter = await createAdapter();
      const result = await adapter.read("agents/a1/nonexistent.json");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("delete removes content", async () => {
      const adapter = await createAdapter();
      const path = "agents/a1/bricks/del.json";

      await adapter.write(path, "content");
      const delResult = await adapter.remove(path);
      expect(delResult.ok).toBe(true);

      const readResult = await adapter.read(path);
      expect(readResult.ok).toBe(false);
    });

    // -------------------------------------------------------------------
    // Agent isolation
    // -------------------------------------------------------------------

    describe("agent isolation", () => {
      test("writes to agent A namespace are invisible to agent B", async () => {
        const adapter = await createAdapter();

        await adapter.write("agents/a1/bricks/shared.json", '{"owner":"a1"}');
        await adapter.write("agents/a2/bricks/shared.json", '{"owner":"a2"}');

        const a1Result = await adapter.read("agents/a1/bricks/shared.json");
        expect(a1Result.ok).toBe(true);
        if (a1Result.ok) {
          expect(JSON.parse(a1Result.value)).toEqual({ owner: "a1" });
        }

        const a2Result = await adapter.read("agents/a2/bricks/shared.json");
        expect(a2Result.ok).toBe(true);
        if (a2Result.ok) {
          expect(JSON.parse(a2Result.value)).toEqual({ owner: "a2" });
        }
      });

      test("glob on agent A does not return agent B results", async () => {
        const adapter = await createAdapter();

        await adapter.write("agents/a1/bricks/x.json", "a1x");
        await adapter.write("agents/a1/bricks/y.json", "a1y");
        await adapter.write("agents/a2/bricks/z.json", "a2z");

        const globResult = await adapter.glob("agents/a1/bricks/*.json");
        expect(globResult.ok).toBe(true);
        if (globResult.ok) {
          expect(globResult.value.length).toBe(2);
          for (const p of globResult.value) {
            expect(p).toContain("agents/a1/");
            expect(p).not.toContain("agents/a2/");
          }
        }
      });

      test("delete in agent A does not affect agent B", async () => {
        const adapter = await createAdapter();

        await adapter.write("agents/a1/bricks/b.json", "a1");
        await adapter.write("agents/a2/bricks/b.json", "a2");

        await adapter.remove("agents/a1/bricks/b.json");

        const a1Read = await adapter.read("agents/a1/bricks/b.json");
        expect(a1Read.ok).toBe(false);

        const a2Read = await adapter.read("agents/a2/bricks/b.json");
        expect(a2Read.ok).toBe(true);
        if (a2Read.ok) {
          expect(a2Read.value).toBe("a2");
        }
      });
    });

    // -------------------------------------------------------------------
    // Group sharing
    // -------------------------------------------------------------------

    describe("group sharing", () => {
      test("writes to group path are readable", async () => {
        const adapter = await createAdapter();
        const path = "groups/g1/scratch/config.yaml";

        await adapter.write(path, "key: value");
        const result = await adapter.read(path);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBe("key: value");
        }
      });

      test("glob on group path returns group entries only", async () => {
        const adapter = await createAdapter();

        await adapter.write("groups/g1/scratch/a.txt", "a");
        await adapter.write("groups/g1/scratch/b.txt", "b");
        await adapter.write("groups/g2/scratch/c.txt", "c");

        const result = await adapter.glob("groups/g1/scratch/*");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.length).toBe(2);
          for (const p of result.value) {
            expect(p).toContain("groups/g1/");
          }
        }
      });
    });

    // -------------------------------------------------------------------
    // Global paths
    // -------------------------------------------------------------------

    describe("global paths", () => {
      test("global brick path is accessible", async () => {
        const adapter = await createAdapter();
        const path = "global/bricks/std-tool.json";

        await adapter.write(path, '{"id":"std-tool"}');
        const result = await adapter.read(path);
        expect(result.ok).toBe(true);
      });

      test("global glob does not leak agent paths", async () => {
        const adapter = await createAdapter();

        await adapter.write("global/bricks/g1.json", "global");
        await adapter.write("agents/a1/bricks/a1.json", "agent");

        const result = await adapter.glob("global/bricks/*.json");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.length).toBe(1);
          expect(result.value[0]).toContain("global/");
        }
      });
    });

    // -------------------------------------------------------------------
    // Namespace path structure
    // -------------------------------------------------------------------

    describe("path structure", () => {
      test("event stream paths follow convention", async () => {
        const adapter = await createAdapter();

        await adapter.write("agents/a1/events/stream-x/meta.json", '{"maxSequence":0}');
        await adapter.write("agents/a1/events/stream-x/events/0000000001.json", '{"seq":1}');

        const metaResult = await adapter.read("agents/a1/events/stream-x/meta.json");
        expect(metaResult.ok).toBe(true);

        const eventResult = await adapter.read("agents/a1/events/stream-x/events/0000000001.json");
        expect(eventResult.ok).toBe(true);
      });

      test("session paths follow convention", async () => {
        const adapter = await createAdapter();

        await adapter.write("agents/a1/session/record.json", '{"status":"active"}');
        await adapter.write("agents/a1/session/pending-frames/f1.json", '{"frameId":"f1"}');

        const recordResult = await adapter.read("agents/a1/session/record.json");
        expect(recordResult.ok).toBe(true);

        const frameGlob = await adapter.glob("agents/a1/session/pending-frames/*.json");
        expect(frameGlob.ok).toBe(true);
        if (frameGlob.ok) {
          expect(frameGlob.value.length).toBe(1);
        }
      });

      test("memory entity paths follow convention", async () => {
        const adapter = await createAdapter();

        await adapter.write("agents/a1/memory/entities/user-prefs.json", "[]");
        await adapter.write("agents/a1/memory/entities/project-notes.json", "[]");

        const result = await adapter.glob("agents/a1/memory/entities/*.json");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.length).toBe(2);
        }
      });

      test("snapshot paths follow convention", async () => {
        const adapter = await createAdapter();

        await adapter.write("agents/a1/snapshots/chain-1/node-a.json", '{"data":"snap"}');
        await adapter.write("agents/a1/snapshots/chain-1/node-b.json", '{"data":"snap2"}');

        const result = await adapter.glob("agents/a1/snapshots/chain-1/*.json");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.length).toBe(2);
        }
      });
    });

    // -------------------------------------------------------------------
    // Glob boundary enforcement
    // -------------------------------------------------------------------

    describe("glob boundaries", () => {
      test("glob does not cross namespace boundaries", async () => {
        const adapter = await createAdapter();

        await adapter.write("agents/a1/bricks/b1.json", "a1");
        await adapter.write("agents/a2/bricks/b2.json", "a2");
        await adapter.write("global/bricks/g1.json", "global");
        await adapter.write("groups/g1/scratch/s1.txt", "group");

        // Each glob should only match its own namespace
        const a1Glob = await adapter.glob("agents/a1/bricks/*.json");
        expect(a1Glob.ok).toBe(true);
        if (a1Glob.ok) {
          expect(a1Glob.value.length).toBe(1);
        }

        const a2Glob = await adapter.glob("agents/a2/bricks/*.json");
        expect(a2Glob.ok).toBe(true);
        if (a2Glob.ok) {
          expect(a2Glob.value.length).toBe(1);
        }

        const globalGlob = await adapter.glob("global/bricks/*.json");
        expect(globalGlob.ok).toBe(true);
        if (globalGlob.ok) {
          expect(globalGlob.value.length).toBe(1);
        }
      });

      test("empty glob returns empty array", async () => {
        const adapter = await createAdapter();

        const result = await adapter.glob("agents/nonexistent/bricks/*.json");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.length).toBe(0);
        }
      });
    });

    // -------------------------------------------------------------------
    // Overwrite semantics
    // -------------------------------------------------------------------

    test("overwrite replaces content", async () => {
      const adapter = await createAdapter();
      const path = "agents/a1/bricks/mut.json";

      await adapter.write(path, "v1");
      await adapter.write(path, "v2");

      const result = await adapter.read(path);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("v2");
      }
    });
  });
}
