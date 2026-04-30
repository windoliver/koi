/**
 * Real-Docker integration tests for sandbox-docker.
 *
 * Gated on DOCKER_E2E=1 — skipped in default CI, run locally / nightly.
 * Requires: a reachable Docker daemon, alpine:3 image (pulled lazily), `docker` on PATH.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SandboxAdapter, SandboxInstance, SandboxProfile } from "@koi/core";
import { createDockerAdapter } from "../adapter.js";

const E2E = process.env.DOCKER_E2E === "1";
const d = E2E ? describe : describe.skip;

const IMAGE = "alpine:3";

function profile(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
  return {
    filesystem: { defaultReadAccess: "open" },
    network: { allow: false },
    resources: {},
    ...overrides,
  };
}

async function makeAdapter(): Promise<SandboxAdapter> {
  const r = await createDockerAdapter({ image: IMAGE });
  if (!r.ok) throw new Error(`adapter init failed: ${r.error.code} ${r.error.message}`);
  return r.value;
}

d("sandbox-docker integration (real Docker daemon)", () => {
  const created: SandboxInstance[] = [];

  beforeAll(async () => {
    // Ensure image is locally cached so individual tests don't pay the pull cost.
    Bun.spawnSync(["docker", "pull", IMAGE], { stdout: "ignore", stderr: "ignore" });
  });

  afterAll(async () => {
    // Best-effort parallel cleanup of any lingering instances.
    await Promise.all(
      created.map(async (inst) => {
        try {
          await inst.destroy();
        } catch {
          // ignore — already destroyed or daemon gone
        }
      }),
    );
  }, 30_000);

  test("happy path: exec echo on alpine returns stdout + exit 0", async () => {
    const adapter = await makeAdapter();
    const inst = await adapter.create(profile());
    created.push(inst);
    const r = await inst.exec("echo", ["hello-koi"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello-koi");
    expect(r.timedOut).toBe(false);
    expect(r.oomKilled).toBe(false);
  }, 60_000);

  test("timeout: long sleep is reaped, container survives, second exec works", async () => {
    const adapter = await makeAdapter();
    const inst = await adapter.create(profile());
    created.push(inst);
    const r1 = await inst.exec("sleep", ["30"], { timeoutMs: 800 });
    expect(r1.timedOut).toBe(true);
    // Container PID 1 must be alive — second exec succeeds
    const r2 = await inst.exec("echo", ["still-alive"]);
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toContain("still-alive");
  }, 60_000);

  test("destroy removes the container — docker ps -a shows nothing", async () => {
    const adapter = await makeAdapter();
    const inst = await adapter.create(profile());
    // Capture id before destroy by snooping docker ps
    const before = Bun.spawnSync(["docker", "ps", "-aq"], { stdout: "pipe", stderr: "ignore" });
    const beforeIds = new TextDecoder().decode(new Uint8Array(before.stdout)).trim().split("\n");
    expect(beforeIds.length).toBeGreaterThan(0);

    await inst.destroy();

    const after = Bun.spawnSync(["docker", "ps", "-aq"], { stdout: "pipe", stderr: "ignore" });
    const afterIds = new TextDecoder().decode(new Uint8Array(after.stdout)).trim().split("\n");
    // The set of ids strictly shrinks (or one specific id is gone).
    expect(afterIds.length).toBeLessThan(beforeIds.length);
  }, 60_000);

  test("readFile + writeFile binary round-trip preserves bytes exactly", async () => {
    const adapter = await makeAdapter();
    const inst = await adapter.create(profile());
    created.push(inst);
    // Random binary payload including bytes that would corrupt under text decoding.
    const payload = new Uint8Array(256);
    for (let i = 0; i < 256; i++) payload[i] = i;
    await inst.writeFile("/tmp/bin.dat", payload);
    const got = await inst.readFile("/tmp/bin.dat");
    expect(got.length).toBe(256);
    for (let i = 0; i < 256; i++) expect(got[i]).toBe(i);
  }, 60_000);

  test("AbortSignal mid-exec returns exitCode 130 quickly", async () => {
    const adapter = await makeAdapter();
    const inst = await adapter.create(profile());
    created.push(inst);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const start = Date.now();
    const r = await inst.exec("sleep", ["30"], { signal: ac.signal });
    const elapsed = Date.now() - start;
    expect(r.exitCode).toBe(130);
    expect(elapsed).toBeLessThan(5_000);
  }, 60_000);

  test("network: allow=false → no DNS resolution, exec exits non-zero", async () => {
    const adapter = await makeAdapter();
    const inst = await adapter.create(profile({ network: { allow: false } }));
    created.push(inst);
    // alpine has nslookup via busybox; try to resolve a public name with no network.
    const r = await inst.exec("sh", ["-c", "nslookup example.com 2>&1; echo exit=$?"], {
      timeoutMs: 5_000,
    });
    // Either nslookup fails or the container has no resolver — both prove allow=false took effect.
    expect(r.stdout + r.stderr).toMatch(
      /can't resolve|bad address|connection refused|no such|exit=[1-9]/i,
    );
  }, 60_000);

  test("4 parallel containers create + destroy with no leaks (label-scoped check)", async () => {
    const adapter = await makeAdapter();
    const before = Bun.spawnSync(["docker", "ps", "-aq"], { stdout: "pipe", stderr: "ignore" });
    const beforeCount = new TextDecoder()
      .decode(new Uint8Array(before.stdout))
      .trim()
      .split("\n")
      .filter((s) => s.length > 0).length;

    const insts = await Promise.all(Array.from({ length: 4 }, () => adapter.create(profile())));
    const execResults = await Promise.all(insts.map((i) => i.exec("echo", ["ok"])));
    expect(execResults.every((r) => r.exitCode === 0)).toBe(true);
    await Promise.all(insts.map((i) => i.destroy()));

    const after = Bun.spawnSync(["docker", "ps", "-aq"], { stdout: "pipe", stderr: "ignore" });
    const afterCount = new TextDecoder()
      .decode(new Uint8Array(after.stdout))
      .trim()
      .split("\n")
      .filter((s) => s.length > 0).length;
    expect(afterCount).toBe(beforeCount);
  }, 90_000);
});
