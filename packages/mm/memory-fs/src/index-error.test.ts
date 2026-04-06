/**
 * MEMORY.md rebuild-failure surfacing tests.
 *
 * We simulate rebuild failures by replacing `MEMORY.md` with a directory
 * of the same name *after* a successful first write. The record write
 * still succeeds, but the temp-then-rename index write fails because
 * `rename(file, directory)` returns EISDIR/ENOTDIR. The error must flow
 * through both the mutation return value and the `onIndexError` callback.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "./store.js";
import type { IndexErrorCallback } from "./types.js";

const TEST_ROOT = join(tmpdir(), "koi-memfs-index-error");

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

function makeDir(label: string): string {
  const id = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(TEST_ROOT, id);
}

/**
 * Replace the MEMORY.md file with a (non-empty) directory so that a
 * subsequent `rename(tmp, MEMORY.md)` fails with EISDIR/ENOTDIR/ENOTEMPTY.
 */
async function blockMemoryIndex(dir: string): Promise<void> {
  const indexPath = join(dir, "MEMORY.md");
  await rm(indexPath, { force: true });
  await mkdir(indexPath, { recursive: true });
  // Populate so rmdir-style fallbacks also fail.
  await mkdir(join(indexPath, "guard"), { recursive: true });
}

describe("index rebuild failures", () => {
  test("write returns indexError when MEMORY.md cannot be rewritten", async () => {
    const dir = makeDir("write-idx-err");
    const calls: { err: unknown; op: string }[] = [];
    const onIndexError: IndexErrorCallback = (err, ctx) => {
      calls.push({ err, op: ctx.operation });
    };
    const store = createMemoryStore({ dir, onIndexError });

    const first = await store.write({
      name: "Seed",
      description: "First record",
      type: "user",
      content: "Initial record seeded before the index path is blocked.",
    });
    expect(first.action).toBe("created");
    expect(first.indexError).toBeUndefined();

    await blockMemoryIndex(dir);

    const second = await store.write({
      name: "After lock",
      description: "Second record after the index path is a directory",
      type: "user",
      content: "This record is written successfully but the index cannot update.",
    });

    expect(second.action).toBe("created");
    // The new record is on disk and readable.
    const loaded = await store.read(second.record.id);
    expect(loaded?.name).toBe("After lock");
    // Index failure is surfaced both on the return value and via the callback.
    expect(second.indexError).toBeDefined();
    expect(calls.length).toBe(1);
    expect(calls[0]?.op).toBe("write");
  });

  test("onIndexError callback is invoked (fire-and-forget)", async () => {
    const dir = makeDir("fire-and-forget-cb");
    const done = { resolve: (): void => undefined };
    const finishedP = new Promise<void>((resolve) => {
      done.resolve = resolve;
    });
    // let — flipped inside the callback
    let callbackFinished = false;
    const onIndexError: IndexErrorCallback = async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      callbackFinished = true;
      done.resolve();
    };
    const store = createMemoryStore({ dir, onIndexError });

    await store.write({
      name: "Seed",
      description: "Seed record",
      type: "user",
      content: "First record to establish the index file.",
    });
    await blockMemoryIndex(dir);

    const result = await store.write({
      name: "Trigger",
      description: "Triggers an index error",
      type: "user",
      content: "Second record that should trigger a callback invocation.",
    });

    expect(result.indexError).toBeDefined();
    // Callback is fire-and-forget, so it may still be running. Wait for
    // it out-of-band to prove it was actually invoked.
    await finishedP;
    expect(callbackFinished).toBe(true);
  });

  test("slow onIndexError callback does not block other writers", async () => {
    // Regression: the observer callback is fire-and-forget, so a slow
    // callback cannot stall a mutation's return — neither the callback's
    // writer (A) nor any other writer (B) should wait on it.
    const dir = makeDir("slow-cb-nonblocking");
    const onIndexError: IndexErrorCallback = async () => {
      // Park forever. The test passes as long as no store.write() waits.
      await new Promise<void>(() => undefined);
    };
    const store = createMemoryStore({ dir, onIndexError });

    await store.write({
      name: "Seed",
      description: "Seed",
      type: "user",
      content: "Seed content before index is blocked.",
    });
    await blockMemoryIndex(dir);

    // Both writers must return promptly even though the callback parks.
    const outcome = await Promise.race([
      (async () => {
        const a = await store.write({
          name: "A",
          description: "Writer A whose rebuild fails and fires the (parked) callback",
          type: "user",
          content: "Writer A content distinct from writer B to avoid dedup.",
        });
        const b = await store.write({
          name: "B",
          description: "Writer B — must not wait on A's parked callback",
          type: "user",
          content: "Writer B content distinct from writer A content.",
        });
        return { a, b };
      })(),
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 500)),
    ]);

    expect(outcome).not.toBe("stuck");
    if (outcome !== "stuck") {
      expect(outcome.a.indexError).toBeDefined();
      expect(outcome.b.indexError).toBeDefined();
    }
  });

  test("rebuildIndex() propagates errors (unlike the best-effort path)", async () => {
    const dir = makeDir("rebuild-throws");
    const store = createMemoryStore({ dir });

    await store.write({
      name: "Seed",
      description: "Seed",
      type: "user",
      content: "Seed content for explicit rebuild test case.",
    });
    await blockMemoryIndex(dir);

    await expect(store.rebuildIndex()).rejects.toThrow();
  });
});
