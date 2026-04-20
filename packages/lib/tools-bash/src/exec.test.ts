import { describe, expect, test } from "bun:test";
import type {
  SandboxAdapter,
  SandboxAdapterResult,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import { execSandboxed, spawnBash } from "./exec.js";

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

// ---------------------------------------------------------------------------
// execSandboxed — callback threading (mock adapter, no real sandbox binary)
// ---------------------------------------------------------------------------

/** Captured exec options from the mock adapter — box type avoids exactOptionalPropertyTypes issues. */
interface CapturedExecOpts {
  onStdout: ((chunk: string) => void) | undefined;
  onStderr: ((chunk: string) => void) | undefined;
}

/**
 * Build a minimal mock SandboxAdapter that captures exec opts for assertions.
 * The captured onStdout/onStderr callbacks are what we need to verify are threaded.
 */
function makeMockAdapter(captured: CapturedExecOpts): SandboxAdapter {
  const instance: SandboxInstance = {
    async exec(
      _command: string,
      _args: readonly string[],
      execOpts?: import("@koi/core").SandboxExecOptions,
    ): Promise<SandboxAdapterResult> {
      // Use explicit assignment with explicit type annotation to satisfy exactOptionalPropertyTypes.
      captured.onStdout = execOpts?.onStdout ?? undefined;
      captured.onStderr = execOpts?.onStderr ?? undefined;
      return {
        exitCode: 0,
        stdout: "mock-stdout",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        oomKilled: false,
      };
    },
    async readFile(_path: string): Promise<Uint8Array> {
      return new Uint8Array();
    },
    async writeFile(_path: string, _data: Uint8Array): Promise<void> {},
    async destroy(): Promise<void> {},
  };

  return {
    name: "mock-adapter",
    async create(_profile: SandboxProfile): Promise<SandboxInstance> {
      return instance;
    },
  };
}

const testProfile: SandboxProfile = {
  filesystem: { defaultReadAccess: "open" },
  network: { allow: false },
  resources: {},
};

describe("execSandboxed — callback threading", () => {
  test("threads onStdout callback into SandboxExecOptions", async () => {
    const captured: CapturedExecOpts = { onStdout: undefined, onStderr: undefined };
    const adapter = makeMockAdapter(captured);
    const onStdout = (_c: string): void => {};

    await execSandboxed(
      adapter,
      testProfile,
      "echo hi",
      process.cwd(),
      5_000,
      1_000_000,
      undefined,
      undefined,
      { onStdout },
    );

    expect(captured.onStdout).toBe(onStdout);
    expect(captured.onStderr).toBeUndefined();
  });

  test("threads onStderr callback into SandboxExecOptions", async () => {
    const captured: CapturedExecOpts = { onStdout: undefined, onStderr: undefined };
    const adapter = makeMockAdapter(captured);
    const onStderr = (_c: string): void => {};

    await execSandboxed(
      adapter,
      testProfile,
      "echo hi",
      process.cwd(),
      5_000,
      1_000_000,
      undefined,
      undefined,
      { onStderr },
    );

    expect(captured.onStdout).toBeUndefined();
    expect(captured.onStderr).toBe(onStderr);
  });

  test("omits onStdout/onStderr from opts when callbacks is undefined (source-compatible)", async () => {
    const captured: CapturedExecOpts = { onStdout: undefined, onStderr: undefined };
    const adapter = makeMockAdapter(captured);

    await execSandboxed(
      adapter,
      testProfile,
      "echo hi",
      process.cwd(),
      5_000,
      1_000_000,
      undefined,
    );

    expect(captured.onStdout).toBeUndefined();
    expect(captured.onStderr).toBeUndefined();
  });
});
