import { describe, expect, test } from "bun:test";
import {
  isEbadf,
  killProcess,
  readStream,
  spawnFallback,
  spawnProcess,
} from "./process-manager.js";

describe("spawnProcess", () => {
  test("spawns echo and captures stdout", async () => {
    const result = spawnProcess(
      "echo",
      ["hello world"],
      { PATH: process.env.PATH ?? "" },
      process.cwd(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const proc = result.value;
    expect(proc.pid).toBeGreaterThan(0);

    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    const stdout = await new Response(proc.stdout).text();
    expect(stdout.trim()).toBe("hello world");
  });

  test("captures non-zero exit code", async () => {
    const result = spawnProcess(
      "sh",
      ["-c", "exit 42"],
      { PATH: process.env.PATH ?? "" },
      process.cwd(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const exitCode = await result.value.exited;
    expect(exitCode).toBe(42);
  });

  test("returns error for non-existent command", () => {
    const result = spawnProcess(
      "__nonexistent_command_12345__",
      [],
      { PATH: process.env.PATH ?? "" },
      process.cwd(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("EXTERNAL");
  });
});

describe("readStream", () => {
  test("captures output correctly", async () => {
    const result = spawnProcess(
      "echo",
      ["test output"],
      { PATH: process.env.PATH ?? "" },
      process.cwd(),
    );
    if (!result.ok) throw new Error("spawn failed");

    const chunks: string[] = [];
    await readStream(result.value.stdout, (text) => chunks.push(text), 1_048_576);
    await result.value.exited;

    const output = chunks.join("");
    expect(output.trim()).toBe("test output");
  });

  test("respects maxBytes truncation", async () => {
    // Generate output larger than the limit
    const result = spawnProcess(
      "sh",
      ["-c", "dd if=/dev/zero bs=200 count=1 2>/dev/null | tr '\\0' '_'"],
      { PATH: process.env.PATH ?? "" },
      process.cwd(),
    );
    if (!result.ok) throw new Error("spawn failed");

    const chunks: string[] = [];
    await readStream(result.value.stdout, (text) => chunks.push(text), 50);
    await result.value.exited;

    const output = chunks.join("");
    expect(output).toContain("[output truncated]");
  });

  test("respects abort signal", async () => {
    const result = spawnProcess(
      "sh",
      ["-c", "sleep 10"],
      { PATH: process.env.PATH ?? "" },
      process.cwd(),
    );
    if (!result.ok) throw new Error("spawn failed");

    const controller = new AbortController();
    const chunks: string[] = [];

    // Abort immediately
    controller.abort();

    await readStream(
      result.value.stdout,
      (text) => chunks.push(text),
      1_048_576,
      controller.signal,
    );
    result.value.kill();
    await result.value.exited;
  });
});

describe("killProcess", () => {
  test("kills a running process", async () => {
    const result = spawnProcess(
      "sh",
      ["-c", "sleep 30"],
      { PATH: process.env.PATH ?? "" },
      process.cwd(),
    );
    if (!result.ok) throw new Error("spawn failed");

    const exitCode = await killProcess(result.value, { gracePeriodMs: 1000 });
    // Process was killed — exit code is non-zero (signal-based)
    expect(typeof exitCode).toBe("number");
  });

  test("sends SIGKILL after grace period", async () => {
    // Use a process that traps SIGTERM
    const result = spawnProcess(
      "sh",
      ["-c", "trap '' TERM; sleep 30"],
      { PATH: process.env.PATH ?? "" },
      process.cwd(),
    );
    if (!result.ok) throw new Error("spawn failed");

    const exitCode = await killProcess(result.value, { gracePeriodMs: 100 });
    expect(typeof exitCode).toBe("number");
  }, 10_000);

  test("kills child processes (process group + pkill tree kill)", async () => {
    // Spawn a parent sh that forks a child sleep
    const result = spawnProcess(
      "sh",
      ["-c", "sleep 30 & echo $!; wait"],
      { PATH: process.env.PATH ?? "" },
      process.cwd(),
    );
    if (!result.ok) throw new Error("spawn failed");

    // Read the child PID from stdout
    const chunks: string[] = [];
    const reader = result.value.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    if (value !== undefined) {
      chunks.push(new TextDecoder().decode(value));
    }
    const childPid = parseInt(chunks.join("").trim(), 10);
    expect(childPid).toBeGreaterThan(0);

    // Kill the process tree
    await killProcess(result.value, { gracePeriodMs: 500 });

    // Verify child is also dead (kill(pid, 0) throws if process doesn't exist)
    // Give a brief moment for cleanup
    await new Promise((r) => setTimeout(r, 100));
    let childAlive = false;
    try {
      process.kill(childPid, 0);
      childAlive = true;
    } catch {
      childAlive = false;
    }
    expect(childAlive).toBe(false);
  }, 10_000);
});

describe("isEbadf", () => {
  test("detects EBADF in error message", () => {
    expect(isEbadf(new Error("EBADF: bad file descriptor"))).toBe(true);
  });

  test("detects EBADF via error code", () => {
    const err = new Error("spawn failed");
    (err as NodeJS.ErrnoException).code = "EBADF";
    expect(isEbadf(err)).toBe(true);
  });

  test("returns false for non-EBADF error", () => {
    expect(isEbadf(new Error("ENOENT: not found"))).toBe(false);
  });

  test("returns false for non-Error values", () => {
    expect(isEbadf("EBADF")).toBe(false);
    expect(isEbadf(null)).toBe(false);
    expect(isEbadf(undefined)).toBe(false);
  });
});

describe("spawnFallback", () => {
  test("spawns process with stdin disabled", async () => {
    const result = spawnFallback(
      "echo",
      ["fallback test"],
      { PATH: process.env.PATH ?? "" },
      process.cwd(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stdout = await new Response(result.value.stdout).text();
    expect(stdout.trim()).toBe("fallback test");

    const exitCode = await result.value.exited;
    expect(exitCode).toBe(0);
  });

  test("provides no-op stdin that does not throw", () => {
    const result = spawnFallback("echo", ["hi"], { PATH: process.env.PATH ?? "" }, process.cwd());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Writing to no-op stdin returns 0 and does not throw
    expect(result.value.stdin.write("data")).toBe(0);
    result.value.stdin.end(); // should not throw
  });

  test("returns error for non-existent command", () => {
    const result = spawnFallback(
      "__nonexistent_cmd__",
      [],
      { PATH: process.env.PATH ?? "" },
      process.cwd(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("EXTERNAL");
    expect(result.error.message).toContain("EBADF retry");
  });
});
