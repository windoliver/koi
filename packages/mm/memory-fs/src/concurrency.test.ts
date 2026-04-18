/**
 * Concurrency tests — exercise the per-directory critical section.
 *
 * - Identical concurrent writes → exactly one `created`, rest `skipped`.
 * - Distinct concurrent writes → all succeed with unique files.
 * - Aliased paths (same realpath, different strings) share the mutex.
 * - Cross-process writes coordinate via the `.memory.lock` file.
 * - Dead PID in an existing lock file is stolen on the next acquire.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { readIndex } from "./index-file.js";
import { createMemoryStore } from "./store.js";

const TEST_ROOT = join(tmpdir(), "koi-memfs-concurrency");

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

function makeDir(label: string): string {
  const id = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(TEST_ROOT, id);
}

describe("write critical section", () => {
  test("10 identical writes → exactly 1 created, 9 skipped", async () => {
    const dir = makeDir("identical");
    const store = createMemoryStore({ dir });

    const input = {
      name: "Concurrent Preference",
      description: "User likes dark mode",
      type: "user" as const,
      content: "The user prefers dark mode in every editor and terminal they use.",
    };

    const results = await Promise.all(Array.from({ length: 10 }, () => store.write(input)));

    const created = results.filter((r) => r.action === "created");
    const skipped = results.filter((r) => r.action === "skipped");
    expect(created.length).toBe(1);
    expect(skipped.length).toBe(9);

    // Every skip points at the one created record.
    const createdId = created[0]?.record.id;
    for (const r of skipped) {
      expect(r.duplicateOf).toBe(createdId);
    }

    // On disk there is exactly one .md file for the record.
    const all = await store.list();
    expect(all.length).toBe(1);
  });

  test("10 distinct writes → 10 records, no EEXIST surface, no duplicates", async () => {
    const dir = makeDir("distinct");
    const store = createMemoryStore({ dir });

    // Each content string is a disjoint bag of words so Jaccard similarity
    // stays well below the 0.7 dedup threshold.
    const wordBanks = [
      "alpha beta gamma delta epsilon zeta eta",
      "rivers forests mountains canyons valleys coastlines",
      "kernel syscall mmap epoll futex cgroup",
      "polonium radium uranium thorium actinium",
      "sonnet ballad haiku villanelle sestina",
      "orca narwhal manatee otter walrus",
      "tungsten molybdenum cobalt palladium rhodium",
      "sourdough baguette ciabatta pumpernickel focaccia",
      "saxophone clarinet oboe bassoon piccolo",
      "equinox solstice zenith aphelion perihelion",
    ];
    const results = await Promise.all(
      wordBanks.map((bank, i) =>
        store.write({
          name: `Record ${String(i)}`,
          description: `Distinct record number ${String(i)}`,
          type: "project" as const,
          content: bank,
        }),
      ),
    );

    expect(results.every((r) => r.action === "created")).toBe(true);
    const ids = new Set(results.map((r) => r.record.id));
    expect(ids.size).toBe(10);

    const all = await store.list();
    expect(all.length).toBe(10);
  });

  test("aliased path strings with same realpath share the mutex", async () => {
    const dir = makeDir("alias");
    await mkdir(dir, { recursive: true });

    // Second store points at the same directory via a trailing "/./".
    const aliasDir = `${dir}/./`;

    const storeA = createMemoryStore({ dir });
    const storeB = createMemoryStore({ dir: aliasDir });

    const input = {
      name: "Aliased Entry",
      description: "Written from two stores",
      type: "reference" as const,
      content: "Content that is identical whether written through store A or store B.",
    };

    // Race a write on each store. Both should see the same lock because
    // realpath(dir) === realpath(aliasDir).
    const [ra, rb] = await Promise.all([storeA.write(input), storeB.write(input)]);

    const actions = [ra.action, rb.action].sort();
    expect(actions).toEqual(["created", "skipped"]);
  });

  test("concurrent rebuilds: MEMORY.md reflects every committed record", async () => {
    // Regression for the "rebuild scan races with later writers and can
    // publish a stale index" defect: fire many mutations concurrently
    // and assert that by the time ALL writes have returned, MEMORY.md
    // contains every record. The per-dir rebuild chain must guarantee
    // the last published index is at least as fresh as the last
    // committed mutation.
    const dir = makeDir("rebuild-freshness");
    const store = createMemoryStore({ dir });

    // Disjoint bags of words — Jaccard similarity between any pair is 0.
    const bags = [
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
      "golf",
      "hotel",
      "india",
      "juliet",
      "kilo",
      "lima",
      "mike",
      "november",
      "oscar",
      "papa",
      "quebec",
      "romeo",
      "sierra",
      "tango",
    ];
    const N = bags.length;
    const results = await Promise.all(
      bags.map((word, i) =>
        store.write({
          name: `Fresh ${String(i)}`,
          description: `Unique record ${String(i)}`,
          type: "project",
          content: word,
        }),
      ),
    );
    // Every write should have succeeded and every return value should
    // NOT carry an indexError.
    for (const r of results) {
      expect(r.action).toBe("created");
      expect(r.indexError).toBeUndefined();
    }

    const index = await readIndex(dir);
    expect(index.entries.length).toBe(N);
    const titles = new Set(index.entries.map((e) => e.title));
    for (let i = 0; i < N; i++) {
      expect(titles.has(`Fresh ${String(i)}`)).toBe(true);
    }
  });

  test("update is atomic — concurrent scan never sees a partial file", async () => {
    // Regression for the "non-atomic update lets rebuild read a partial
    // file and silently omit the record" defect. The record must survive
    // every intermediate scan that runs while an update is in flight.
    const dir = makeDir("update-atomic");
    const store = createMemoryStore({ dir });

    const seed = await store.write({
      name: "Seed",
      description: "Will be rewritten many times",
      type: "user",
      content: "Seed body xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx initial.",
    });
    expect(seed.action).toBe("created");
    const id = seed.record.id;

    // Fire many updates and many parallel reads. No read should ever
    // observe an unparsable/missing record.
    const updates = Array.from({ length: 30 }, (_, i) =>
      store.update(id, {
        content: `Seed body update iteration ${String(i)} with unique content marker mmm${String(i)}mmm and padding padding padding padding padding.`,
      }),
    );
    const reads = Array.from({ length: 60 }, async () => {
      // Interleave with updates — each read happens between update starts.
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
      return store.read(id);
    });

    const [updateResults, readResults] = await Promise.all([
      Promise.all(updates),
      Promise.all(reads),
    ]);

    for (const u of updateResults) {
      expect(u.record.id).toBe(id);
    }
    for (const r of readResults) {
      // The record MUST be present on every read — never partial, never
      // missing. If an atomic update ever exposed a truncated intermediate,
      // parseMemoryFrontmatter would return undefined and the record would
      // drop out of the scan.
      expect(r).toBeDefined();
      expect(r?.id).toBe(id);
    }
  });
});

describe("upsert critical section", () => {
  test("10 concurrent upserts same (name,type) force=false → 1 created, 9 conflict", async () => {
    const dir = makeDir("upsert-no-force");
    const store = createMemoryStore({ dir });

    const input = {
      name: "Concurrent Upsert",
      description: "Same name and type",
      type: "user" as const,
      content: "Content for the concurrent upsert no-force test scenario.",
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.upsert(input, { force: false })),
    );

    const created = results.filter((r) => r.action === "created");
    const conflict = results.filter((r) => r.action === "conflict");
    expect(created.length).toBe(1);
    expect(conflict.length).toBe(9);

    // On disk there is exactly one .md file for the record.
    const all = await store.list();
    expect(all.length).toBe(1);
  });

  test("10 concurrent upserts same (name,type) force=true → all updated, 1 file", async () => {
    const dir = makeDir("upsert-force");
    const store = createMemoryStore({ dir });

    // Seed a record so every concurrent upsert hits a name+type match.
    const seed = await store.upsert(
      {
        name: "Force Target",
        description: "Seed record",
        type: "project" as const,
        content: "Initial seed content for concurrent force upsert test scenario.",
      },
      { force: false },
    );
    expect(seed.action).toBe("created");

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.upsert(
          {
            name: "Force Target",
            description: `Update ${String(i)}`,
            type: "project" as const,
            content: `Force-updated content iteration ${String(i)} with unique marker fff${String(i)}fff and padding.`,
          },
          { force: true },
        ),
      ),
    );

    expect(results.every((r) => r.action === "updated")).toBe(true);

    // On disk there is exactly one .md file for the record.
    const all = await store.list();
    expect(all.length).toBe(1);
  });
});

describe("file-lock stale ownership", () => {
  test("dead-PID lock is stolen on next write", async () => {
    const dir = makeDir("stale-pid");
    await mkdir(dir, { recursive: true });

    // Fabricate a stale lock file pointing at a PID that definitely does
    // not exist on this host.
    const deadPid = 2 ** 30; // Kernels do not assign PIDs anywhere near this.
    const staleBody = JSON.stringify({
      pid: deadPid,
      host: hostname(),
      nonce: "feedfacefeedfaceDEAD",
    });
    await writeFile(join(dir, ".memory.lock"), staleBody, "utf-8");

    const store = createMemoryStore({ dir });
    const result = await store.write({
      name: "After Steal",
      description: "Lock was stolen from a dead owner",
      type: "project",
      content: "A record written after the stale lock was reclaimed.",
    });

    expect(result.action).toBe("created");

    // The lockfile should have been cleaned up after the write completed.
    const stillPresent = await readFile(join(dir, ".memory.lock"), "utf-8").then(
      () => true,
      () => false,
    );
    expect(stillPresent).toBe(false);
  });

  test("unparseable lock is treated as stealable (no wedge)", async () => {
    // Regression: a truncated/corrupted lockfile from a crashed writer
    // must not wedge the store forever. Corrupted owner records are
    // atomically stolen by the same rename-to-unique + wx protocol.
    const dir = makeDir("corrupt-lock");
    await mkdir(dir, { recursive: true });
    // Half-written payload — looks like JSON start but isn't valid.
    await writeFile(join(dir, ".memory.lock"), '{"pid":', "utf-8");

    const store = createMemoryStore({ dir });
    const result = await store.write({
      name: "After Recover",
      description: "Lock was unparseable and got stolen",
      type: "project",
      content: "A record written after the corrupted lockfile was recovered.",
    });
    expect(result.action).toBe("created");

    // Lockfile removed after the write.
    const stillPresent = await readFile(join(dir, ".memory.lock"), "utf-8").then(
      () => true,
      () => false,
    );
    expect(stillPresent).toBe(false);
  });

  test("empty lockfile (crashed mid-create) is stealable", async () => {
    // A wx+write sequence crashing between file-create and payload-write
    // leaves an empty file. The atomic-create path prevents this for
    // future writers, but a legacy/externally-created zero-byte lock
    // must still be recoverable.
    const dir = makeDir("empty-lock");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".memory.lock"), "", "utf-8");

    const store = createMemoryStore({ dir });
    const result = await store.write({
      name: "After Recover Empty",
      description: "Zero-byte lock file recovered",
      type: "project",
      content: "A record written after an empty lockfile was treated as stale.",
    });
    expect(result.action).toBe("created");
  });

  test("live-PID lock on another host is not stolen (treated as live)", async () => {
    const dir = makeDir("foreign-host");
    await mkdir(dir, { recursive: true });

    // Lock held by some process on a different host — we cannot probe it,
    // so we must wait (and ultimately time out) rather than steal.
    const foreignBody = JSON.stringify({
      pid: 1,
      host: "definitely-not-this-host.invalid",
      nonce: "aabbccddeeff00112233",
    });
    await writeFile(join(dir, ".memory.lock"), foreignBody, "utf-8");

    const store = createMemoryStore({ dir });
    // Give the acquire loop a short timeout by racing with a timer.
    const write = store.write({
      name: "Blocked",
      description: "Blocked by foreign-host lock",
      type: "user",
      content: "This write should not proceed while the foreign lock is held.",
    });

    const outcome = await Promise.race([
      write.then(() => "wrote" as const).catch(() => "error" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 300)),
    ]);

    expect(outcome).toBe("timeout");

    // Clean up the stuck lock so the pending write can finalize and we
    // don't leak a background promise into later tests.
    await rm(join(dir, ".memory.lock"));
    await write.catch(() => undefined);
  });
});
