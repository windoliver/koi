import { describe, expect, test } from "bun:test";
import { spawnBash } from "./exec.js";

describe("spawnBash — streaming callbacks", () => {
  test("without callbacks: behavior byte-identical to prior", async () => {
    const r = await spawnBash(
      "echo hello && echo world >&2",
      process.cwd(),
      5_000,
      1_000_000,
      undefined,
      undefined,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello");
    expect(r.stderr).toContain("world");
  });

  test("with onStdout: callback fires as bytes arrive", async () => {
    const chunks: string[] = [];
    const r = await spawnBash(
      "for i in 1 2 3; do echo line$i; sleep 0.02; done",
      process.cwd(),
      5_000,
      1_000_000,
      undefined,
      undefined,
      { onStdout: (c) => chunks.push(c) },
    );
    expect(r.exitCode).toBe(0);
    const concatenated = chunks.join("");
    expect(concatenated).toContain("line1");
    expect(concatenated).toContain("line3");
  });

  test("onStderr: fires for stderr bytes", async () => {
    const chunks: string[] = [];
    const r = await spawnBash(
      "echo warn-msg >&2",
      process.cwd(),
      5_000,
      1_000_000,
      undefined,
      undefined,
      { onStderr: (c) => chunks.push(c) },
    );
    expect(r.exitCode).toBe(0);
    expect(chunks.join("")).toContain("warn-msg");
  });

  test("callbacks continue firing after capture cap is exhausted", async () => {
    // Emit 2 MB of filler then a late marker. maxOutputBytes = 1 MB.
    const cmd = `yes x | head -c 2000000; echo LATE_MARKER`;
    const stdoutChunks: string[] = [];
    const r = await spawnBash(cmd, process.cwd(), 20_000, 1_000_000, undefined, undefined, {
      onStdout: (c) => stdoutChunks.push(c),
    });
    expect(r.exitCode).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThan(1_100_000);
    expect(stdoutChunks.join("")).toContain("LATE_MARKER");
  });

  test("callback throwing does not break the drain loop", async () => {
    const r = await spawnBash(
      "echo one && echo two",
      process.cwd(),
      5_000,
      1_000_000,
      undefined,
      undefined,
      {
        onStdout: () => {
          throw new Error("consumer bug");
        },
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("one");
    expect(r.stdout).toContain("two");
  });
});
