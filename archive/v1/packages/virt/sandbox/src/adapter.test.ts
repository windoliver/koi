import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOsAdapter } from "./adapter.js";
import { restrictiveProfile } from "./profiles.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const tempFiles: string[] = [];

function tempPath(name: string): string {
  const p = join(tmpdir(), `koi-adapter-test-${Date.now()}-${name}`);
  tempFiles.push(p);
  return p;
}

afterEach(async () => {
  // Clean up temp files created during tests
  for (const path of tempFiles) {
    try {
      const file = Bun.file(path);
      if (await file.exists()) {
        await Bun.write(path, ""); // truncate — Bun has no unlink
      }
    } catch {
      // Ignore cleanup failures
    }
  }
  tempFiles.length = 0;
});

// ---------------------------------------------------------------------------
// Existing tests
// ---------------------------------------------------------------------------
describe("createOsAdapter", () => {
  test("returns adapter with name 'os'", () => {
    const adapter = createOsAdapter();
    expect(adapter.name).toBe("os");
  });

  test("adapter.create returns a SandboxInstance", async () => {
    const adapter = createOsAdapter();
    const profile = restrictiveProfile();
    const instance = await adapter.create(profile);
    expect(typeof instance.exec).toBe("function");
    expect(typeof instance.readFile).toBe("function");
    expect(typeof instance.writeFile).toBe("function");
    expect(typeof instance.destroy).toBe("function");
  });

  test("destroy prevents further exec calls", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());
    await instance.destroy();
    expect(instance.exec("/bin/echo", ["hello"])).rejects.toThrow("destroyed");
  });

  test("destroy prevents further readFile calls", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());
    await instance.destroy();
    expect(instance.readFile("/dev/null")).rejects.toThrow("destroyed");
  });

  test("destroy prevents further writeFile calls", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());
    await instance.destroy();
    expect(instance.writeFile("/dev/null", new Uint8Array())).rejects.toThrow("destroyed");
  });

  test("destroy can be called multiple times safely", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());
    await instance.destroy();
    await instance.destroy();
    // Third call — still no throw
    await instance.destroy();
  });
});

// ---------------------------------------------------------------------------
// New tests: SandboxResult shape from exec()
// ---------------------------------------------------------------------------
const SKIP_INTEGRATION = !process.env.SANDBOX_INTEGRATION;

describe.skipIf(SKIP_INTEGRATION)("SandboxInstance.exec", () => {
  test("returns SandboxResult with all expected fields", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    const result = await instance.exec("/bin/echo", ["result fields"]);

    expect(typeof result.exitCode).toBe("number");
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
    expect(typeof result.durationMs).toBe("number");
    expect(typeof result.timedOut).toBe("boolean");
    expect(typeof result.oomKilled).toBe("boolean");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("result fields");
    expect(result.timedOut).toBe(false);
    expect(result.oomKilled).toBe(false);
    expect(result.durationMs).toBeGreaterThan(0);

    await instance.destroy();
  });

  test("exitCode, stdout, stderr, durationMs, timedOut, oomKilled present on non-zero exit", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    const result = await instance.exec("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"]);

    expect(result.exitCode).toBe(3);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.timedOut).toBe(false);
    expect(result.oomKilled).toBe(false);

    await instance.destroy();
  });

  test("propagates errors from execute() as thrown errors with cause", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    // After destroy, exec should throw an Error (not a Result)
    await instance.destroy();

    try {
      await instance.exec("/bin/echo", ["should fail"]);
      // Should not reach here
      expect(true).toBe(false);
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      if (e instanceof Error) {
        expect(e.message).toContain("destroyed");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// New tests: readFile and writeFile with temp files
// ---------------------------------------------------------------------------
describe.skipIf(SKIP_INTEGRATION)("SandboxInstance.readFile / writeFile", () => {
  test("writeFile creates a file that readFile can read back", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    const path = tempPath("readwrite.txt");
    const content = new TextEncoder().encode("hello sandbox");

    await instance.writeFile(path, content);
    const read = await instance.readFile(path);

    expect(new TextDecoder().decode(read)).toBe("hello sandbox");

    await instance.destroy();
  });

  test("writeFile with empty content", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    const path = tempPath("empty.txt");
    await instance.writeFile(path, new Uint8Array(0));
    const read = await instance.readFile(path);

    expect(read.length).toBe(0);

    await instance.destroy();
  });

  test("writeFile overwrites existing file", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    const path = tempPath("overwrite.txt");
    await instance.writeFile(path, new TextEncoder().encode("first"));
    await instance.writeFile(path, new TextEncoder().encode("second"));
    const read = await instance.readFile(path);

    expect(new TextDecoder().decode(read)).toBe("second");

    await instance.destroy();
  });

  test("readFile returns Uint8Array", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    const path = tempPath("uint8.txt");
    await instance.writeFile(path, new TextEncoder().encode("binary"));
    const read = await instance.readFile(path);

    expect(read).toBeInstanceOf(Uint8Array);

    await instance.destroy();
  });

  test("readFile throws for non-existent file", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    const path = tempPath("nonexistent.txt");

    try {
      await instance.readFile(path);
      expect(true).toBe(false); // should not reach
    } catch (e: unknown) {
      expect(e).toBeDefined();
    }

    await instance.destroy();
  });

  test("writeFile with binary content preserves bytes", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    const path = tempPath("binary.dat");
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    await instance.writeFile(path, bytes);
    const read = await instance.readFile(path);

    expect(Array.from(read)).toEqual([0, 1, 127, 128, 255]);

    await instance.destroy();
  });
});

// ---------------------------------------------------------------------------
// New tests: adapter contract compliance
// ---------------------------------------------------------------------------
describe("adapter contract", () => {
  test("create returns a fresh instance each time", async () => {
    const adapter = createOsAdapter();
    const profile = restrictiveProfile();
    const a = await adapter.create(profile);
    const b = await adapter.create(profile);

    // Distinct instances
    expect(a).not.toBe(b);

    // Destroying one does not affect the other
    await a.destroy();
    // b should still have callable methods
    expect(typeof b.exec).toBe("function");
    expect(typeof b.readFile).toBe("function");
  });

  test("adapter name is a non-empty string", () => {
    const adapter = createOsAdapter();
    expect(adapter.name).toBeTruthy();
    expect(typeof adapter.name).toBe("string");
    expect(adapter.name.length).toBeGreaterThan(0);
  });

  test("adapter.create is an async function", () => {
    const adapter = createOsAdapter();
    expect(typeof adapter.create).toBe("function");
    // create() returns a Promise
    const result = adapter.create(restrictiveProfile());
    expect(result).toBeInstanceOf(Promise);
  });
});

// ---------------------------------------------------------------------------
// SandboxInstance.spawn() — lifecycle test matrix
// ---------------------------------------------------------------------------
describe("SandboxInstance.spawn", () => {
  test("instance exposes spawn as a function", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());
    expect(typeof instance.spawn).toBe("function");
  });

  test("destroy prevents further spawn calls", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());
    await instance.destroy();
    expect(spawnOrFail(instance, "/bin/echo", ["hello"])).rejects.toThrow("destroyed");
  });
});

/** Assert spawn is defined and call it — avoids optional chaining in tests. */
async function spawnOrFail(
  instance: Awaited<ReturnType<ReturnType<typeof createOsAdapter>["create"]>>,
  cmd: string,
  args: readonly string[],
  opts?: Parameters<NonNullable<typeof instance.spawn>>[2],
): ReturnType<NonNullable<typeof instance.spawn>> {
  if (instance.spawn === undefined) {
    throw new Error("spawn is not defined on instance");
  }
  return instance.spawn(cmd, args, opts);
}

describe.skipIf(SKIP_INTEGRATION)("SandboxInstance.spawn lifecycle", () => {
  test("returns SandboxProcessHandle with all expected fields", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    const handle = await spawnOrFail(instance, "/bin/cat", []);

    expect(typeof handle.pid).toBe("number");
    expect(handle.pid).toBeGreaterThan(0);
    expect(handle.stdin).toBeDefined();
    expect(typeof handle.stdin.write).toBe("function");
    expect(typeof handle.stdin.end).toBe("function");
    expect(handle.stdout).toBeInstanceOf(ReadableStream);
    expect(handle.stderr).toBeInstanceOf(ReadableStream);
    expect(handle.exited).toBeInstanceOf(Promise);
    expect(typeof handle.kill).toBe("function");

    handle.kill();
    await handle.exited;
    await instance.destroy();
  });

  test("stdin.write sends data to process stdout via cat", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    const handle = await spawnOrFail(instance, "/bin/cat", []);

    handle.stdin.write("hello from spawn\n");
    handle.stdin.end();

    const output = await new Response(handle.stdout).text();
    expect(output).toBe("hello from spawn\n");

    await handle.exited;
    await instance.destroy();
  });

  test("exited resolves with exit code after process terminates", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    const handle = await spawnOrFail(instance, "/bin/sh", ["-c", "exit 42"]);
    const exitCode = await handle.exited;
    expect(exitCode).toBe(42);

    await instance.destroy();
  });

  test("kill terminates the process", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    const handle = await spawnOrFail(instance, "/bin/sleep", ["60"]);
    handle.kill();
    const exitCode = await handle.exited;
    // Killed with SIGKILL → exit code 137 (128 + 9)
    expect(exitCode).toBeGreaterThan(0);

    await instance.destroy();
  });

  test("stderr stream captures error output", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    const handle = await spawnOrFail(instance, "/bin/sh", ["-c", "echo error >&2"]);

    const stderr = await new Response(handle.stderr).text();
    expect(stderr.trim()).toBe("error");

    await handle.exited;
    await instance.destroy();
  });

  test("AbortSignal kills the process", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    const controller = new AbortController();
    const handle = await spawnOrFail(instance, "/bin/sleep", ["60"], {
      signal: controller.signal,
    });

    controller.abort();
    const exitCode = await handle.exited;
    expect(exitCode).toBeGreaterThan(0);

    await instance.destroy();
  });

  test("pre-aborted signal rejects spawn immediately", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    const controller = new AbortController();
    controller.abort();

    await expect(
      spawnOrFail(instance, "/bin/echo", ["should not run"], {
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");

    await instance.destroy();
  });

  test("multiple spawns from same instance are independent", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    const handleA = await spawnOrFail(instance, "/bin/sh", ["-c", "echo A"]);
    const handleB = await spawnOrFail(instance, "/bin/sh", ["-c", "echo B"]);

    const [outA, outB] = await Promise.all([
      new Response(handleA.stdout).text(),
      new Response(handleB.stdout).text(),
    ]);

    expect(outA.trim()).toBe("A");
    expect(outB.trim()).toBe("B");

    await Promise.all([handleA.exited, handleB.exited]);
    await instance.destroy();
  });
});

// ---------------------------------------------------------------------------
// SandboxInstance.exec — streaming callbacks
// ---------------------------------------------------------------------------
describe.skipIf(SKIP_INTEGRATION)("SandboxInstance.exec streaming", () => {
  test("onStdout receives output chunks", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    const chunks: string[] = [];
    const result = await instance.exec("/bin/echo", ["streamed"], {
      onStdout: (chunk) => chunks.push(chunk),
    });

    expect(result.stdout.trim()).toBe("streamed");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("").trim()).toBe("streamed");

    await instance.destroy();
  });

  test("onStderr receives error output chunks", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    const chunks: string[] = [];
    const result = await instance.exec("/bin/sh", ["-c", "echo err >&2"], {
      onStderr: (chunk) => chunks.push(chunk),
    });

    expect(result.stderr.trim()).toBe("err");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("").trim()).toBe("err");

    await instance.destroy();
  });

  test("AbortSignal kills exec process", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());

    const controller = new AbortController();
    // Start a long process, then abort
    setTimeout(() => controller.abort(), 50);

    const result = await instance.exec("/bin/sleep", ["60"], {
      signal: controller.signal,
    });

    // Process was killed — should have non-zero exit
    expect(result.exitCode).toBeGreaterThan(0);

    await instance.destroy();
  });
});
