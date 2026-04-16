/**
 * Cross-process concurrency tests for MemoryStore.upsert().
 *
 * Spawns real child processes via Bun.spawn to verify that the file lock
 * serializes the full check+write across process boundaries.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "./store.js";

const TEST_ROOT = join(tmpdir(), "koi-memfs-cross-process");
const WORKER_PATH = join(import.meta.dir, "__tests__", "cross-process-worker.ts");

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

function makeDir(label: string): string {
  const id = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(TEST_ROOT, id);
}

interface WorkerResult {
  readonly action: string;
}

async function spawnWorker(
  dir: string,
  name: string,
  type: string,
  force: boolean,
  goSignal: string,
): Promise<WorkerResult> {
  const proc = Bun.spawn(["bun", "run", WORKER_PATH, dir, name, type, String(force), goSignal], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    throw new Error(`Worker exited ${String(exitCode)}: ${stderr}`);
  }

  return JSON.parse(stdout.trim()) as WorkerResult;
}

describe("cross-process upsert", () => {
  test("two processes, same (name,type), force=false → one created, one conflict", async () => {
    const dir = makeDir("xproc-conflict");
    await mkdir(dir, { recursive: true });
    const goSignal = join(dir, ".go-signal");
    await writeFile(goSignal, "wait", "utf-8");

    // Spawn two child workers — both will spin-wait on the go signal.
    const p1 = spawnWorker(dir, "shared", "user", false, goSignal);
    const p2 = spawnWorker(dir, "shared", "user", false, goSignal);

    // Brief delay to let both workers start spinning.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Remove the go signal — both workers race to upsert.
    await unlink(goSignal);

    const [r1, r2] = await Promise.all([p1, p2]);
    const actions = [r1.action, r2.action].sort();

    expect(actions).toEqual(["conflict", "created"]);

    // Verify exactly one file on disk.
    const store = createMemoryStore({ dir });
    const all = await store.list();
    expect(all.length).toBe(1);
    expect(all[0]?.name).toBe("shared");
  }, 15_000);

  test("two processes, same (name,type), force=true → both updated, one file", async () => {
    const dir = makeDir("xproc-force");
    await mkdir(dir, { recursive: true });

    // Seed the record before spawning workers.
    const store = createMemoryStore({ dir });
    await store.upsert(
      {
        name: "force-target",
        description: "Seed",
        type: "project",
        content: "Seed content for cross-process force test record.",
      },
      { force: false },
    );

    const goSignal = join(dir, ".go-signal");
    await writeFile(goSignal, "wait", "utf-8");

    const p1 = spawnWorker(dir, "force-target", "project", true, goSignal);
    const p2 = spawnWorker(dir, "force-target", "project", true, goSignal);

    await new Promise((resolve) => setTimeout(resolve, 100));
    await unlink(goSignal);

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.action).toBe("updated");
    expect(r2.action).toBe("updated");

    const all = await store.list();
    expect(all.length).toBe(1);
  }, 15_000);

  test("two processes, different (name,type) → both created, two files", async () => {
    const dir = makeDir("xproc-distinct");
    await mkdir(dir, { recursive: true });
    const goSignal = join(dir, ".go-signal");
    await writeFile(goSignal, "wait", "utf-8");

    const p1 = spawnWorker(dir, "record-alpha", "user", false, goSignal);
    const p2 = spawnWorker(dir, "record-beta", "feedback", false, goSignal);

    await new Promise((resolve) => setTimeout(resolve, 100));
    await unlink(goSignal);

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.action).toBe("created");
    expect(r2.action).toBe("created");

    const store = createMemoryStore({ dir });
    const all = await store.list();
    expect(all.length).toBe(2);
  }, 15_000);
});
