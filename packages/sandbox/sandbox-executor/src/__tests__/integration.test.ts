/**
 * Real-subprocess integration tests for sandbox-executor.
 *
 * Gated on EXEC_E2E=1 — skipped in default CI, run locally / nightly.
 * Requires: bun on PATH, setsid on PATH for the process-group cases (Linux native;
 * macOS install via `brew install util-linux` then export PATH).
 */
import { describe, expect, test } from "bun:test";
import { createSubprocessExecutor } from "../subprocess-executor.js";

const E2E = process.env.EXEC_E2E === "1";
const d = E2E ? describe : describe.skip;

d("sandbox-executor integration (real subprocess)", () => {
  test("happy path: returns structured output", async () => {
    const exec = createSubprocessExecutor();
    const r = await exec.execute(
      "export default async (input) => ({ doubled: input * 2 });",
      21,
      5000,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.output).toEqual({ doubled: 42 });
  });

  test("throw inside user code produces CRASH error with message", async () => {
    const exec = createSubprocessExecutor();
    const r = await exec.execute(
      "export default async () => { throw new Error('boom-marker'); };",
      null,
      5000,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("CRASH");
    expect(r.error.message).toContain("boom");
  });

  test("timeout reaps process group — no grandchild orphans", async () => {
    const exec = createSubprocessExecutor();
    const marker = `koi-e2e-orphan-${process.pid}-${Date.now()}`;
    // User code spawns a grandchild that would outlive the parent if PG-kill failed.
    const code = `
      export default async () => {
        Bun.spawn(["sleep", "${marker}-30"]);
        await new Promise((r) => setTimeout(r, 30_000));
        return { unreachable: true };
      };
    `;
    const r = await exec.execute(code, null, 800);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("TIMEOUT");

    // Give the kernel a moment to reap.
    await new Promise((res) => setTimeout(res, 200));
    const ps = Bun.spawnSync(["pgrep", "-f", marker], { stdout: "pipe", stderr: "ignore" });
    const survivors = new TextDecoder().decode(new Uint8Array(ps.stdout)).trim();
    expect(survivors).toBe("");
  });

  test("context.env is honored by child", async () => {
    const exec = createSubprocessExecutor({ externalIsolation: true });
    const code = `
      export default async () => ({ value: process.env.KOI_E2E_FOO });
    `;
    const r = await exec.execute(code, null, 5000, {
      env: { KOI_E2E_FOO: "bar-baz-quux" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.output).toEqual({ value: "bar-baz-quux" });
  });

  test("non-allowlisted env is scrubbed by default", async () => {
    process.env.KOI_E2E_SECRET = "should-be-scrubbed";
    try {
      const exec = createSubprocessExecutor();
      const code = `
        export default async () => ({ leaked: process.env.KOI_E2E_SECRET ?? null });
      `;
      const r = await exec.execute(code, null, 5000);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.output).toEqual({ leaked: null });
    } finally {
      delete process.env.KOI_E2E_SECRET;
    }
  });

  test("requireProcessGroupIsolation fails closed when setsid is absent", async () => {
    const exec = createSubprocessExecutor({
      requireProcessGroupIsolation: true,
      resolveSetsid: () => null,
    });
    const r = await exec.execute("export default async () => ({});", null, 5000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(["PERMISSION", "CRASH"]).toContain(r.error.code);
    expect(r.error.message.toLowerCase()).toContain("setsid");
  });

  test("20 concurrent executions all succeed independently", async () => {
    const exec = createSubprocessExecutor();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        exec.execute("export default async (i) => ({ i });", i, 30_000),
      ),
    );
    const oks = results.filter((r) => r.ok);
    expect(oks.length).toBe(20);
    const sum = oks.reduce((acc, r) => {
      if (!r.ok) return acc;
      const out = r.value.output as { i: number };
      return acc + out.i;
    }, 0);
    expect(sum).toBe((20 * 19) / 2);
  }, 90_000);
});
