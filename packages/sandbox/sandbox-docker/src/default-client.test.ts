/**
 * Unit tests for default-client.ts.
 *
 * These tests stub Bun.spawn so no real Docker daemon is required.
 * The subprocess stub returns a minimal fake process object that satisfies
 * the parts of the SubProcess interface used by runDockerWithTimeout.
 */

import { describe, expect, mock, spyOn, test } from "bun:test";
import { buildDockerEnv, createDefaultDockerClient } from "./default-client.js";

/** Minimal shape of a Bun subprocess used by runDockerWithTimeout. */
interface FakeProc {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly kill: (signal?: number) => void;
}

/** Build a fake Bun.spawn return value (typed as FakeProc to avoid Subprocess<> sprawl). */
function fakeProc(opts: {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}): FakeProc {
  const enc = new TextEncoder();
  return {
    stdout: new Response(enc.encode(opts.stdout)).body,
    stderr: new Response(enc.encode(opts.stderr)).body,
    exited: Promise.resolve(opts.exitCode),
    exitCode: opts.exitCode,
    kill: mock(() => undefined),
  };
}

describe("createDefaultDockerClient", () => {
  test("createContainer: calls docker create + start and returns container with id", async () => {
    const containerId = "abc123\n";
    const calls: string[][] = [];

    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: string[]) => {
      calls.push(args);
      if (args[1] === "create") return fakeProc({ stdout: containerId, stderr: "", exitCode: 0 });
      return fakeProc({ stdout: "", stderr: "", exitCode: 0 });
    });

    try {
      const client = createDefaultDockerClient();
      const container = await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
      });
      expect(container.id).toBe("abc123");
      expect(calls.length).toBe(2);
      expect(calls[0]).toContain("create");
      expect(calls[1]).toContain("start");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("createContainer: throws when docker create fails", async () => {
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((_args: string[]) =>
      fakeProc({ stdout: "", stderr: "daemon not running", exitCode: 1 }),
    );
    try {
      const client = createDefaultDockerClient();
      await expect(
        client.createContainer({ image: "ubuntu:22.04", networkMode: "none" }),
      ).rejects.toThrow("docker create failed");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("createContainer: throws when docker start fails", async () => {
    let callCount = 0;
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((_args: string[]) => {
      callCount += 1;
      if (callCount === 1) return fakeProc({ stdout: "newid\n", stderr: "", exitCode: 0 });
      return fakeProc({ stdout: "", stderr: "start error", exitCode: 1 });
    });
    try {
      const client = createDefaultDockerClient();
      await expect(
        client.createContainer({ image: "ubuntu:22.04", networkMode: "none" }),
      ).rejects.toThrow("docker start failed");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("container.exec: passes command and returns DockerExecResult", async () => {
    let callCount = 0;
    const execArgs: string[][] = [];
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: string[]) => {
      callCount += 1;
      if (callCount <= 2) {
        return fakeProc({ stdout: "cid\n", stderr: "", exitCode: 0 });
      }
      execArgs.push(args);
      return fakeProc({ stdout: "exec-output", stderr: "", exitCode: 0 });
    });
    try {
      const client = createDefaultDockerClient();
      const container = await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
      });
      const r = await container.exec("echo hello");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("exec-output");
      expect(execArgs[0]).toContain("exec");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("container.exec: honours timeoutMs via in-container timeout wrapping — exitCode 124, docker kill NOT called", async () => {
    let callCount = 0;
    const spawnedArgs: string[][] = [];
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: string[]) => {
      callCount += 1;
      spawnedArgs.push(args);
      if (callCount <= 2) return fakeProc({ stdout: "tid\n", stderr: "", exitCode: 0 });
      // 3rd call = docker exec (the actual workload).
      // In-container `timeout` returns exit code 124 when it fires.
      // The host-side grace timer (timeoutMs + 1s) also eventually fires proc.kill(9).
      // Simulate the in-container timeout: process exits with code 124 quickly.
      return fakeProc({ stdout: "", stderr: "", exitCode: 124 });
    });
    try {
      const client = createDefaultDockerClient();
      const container = await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
      });
      const r = await container.exec("sleep 100", { timeoutMs: 5 });
      // In-container timeout exits with 124 → result is exitCode 124.
      expect(r.exitCode).toBe(124);
      // docker kill --signal=KILL must NOT be called — it would kill PID 1.
      const dockerKillCall = spawnedArgs.find((a) => a[1] === "kill" && a[2] === "--signal=KILL");
      expect(dockerKillCall).toBeUndefined();
      // The exec command should contain "timeout" prefix for in-container wrapping.
      const execCall = spawnedArgs.find((a) => a[1] === "exec");
      const cmdArg = execCall?.[execCall.length - 1] ?? "";
      expect(cmdArg).toContain("timeout");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  // Fix 1 regression: child exits before deadline but produces large output.
  // Timer must be cleared when proc.exited resolves — post-exit drain time does NOT count.
  // Result must be success (exitCode 0), docker kill must NOT be called.
  test("container.exec: child exits before deadline with large output — success, docker kill NOT called", async () => {
    let callCount = 0;
    const spawnedArgs: string[][] = [];
    const largeOutput = "x".repeat(512 * 1024); // 512 KB
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: string[]) => {
      callCount += 1;
      spawnedArgs.push(args);
      if (callCount <= 2) return fakeProc({ stdout: "fastid\n", stderr: "", exitCode: 0 });
      // 3rd call = docker exec — resolves immediately (child already exited), but has large output.
      return fakeProc({ stdout: largeOutput, stderr: "", exitCode: 0 });
    });
    try {
      const client = createDefaultDockerClient();
      const container = await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
      });
      // 500 ms deadline — child exits instantly, large output drains after.
      const r = await container.exec("cat /big", { timeoutMs: 500 });
      // Child exited naturally before deadline → success, NOT timeout.
      expect(r.exitCode).toBe(0);
      // docker kill --signal=KILL must NOT have been spawned (child exited cleanly).
      const dockerKillCall = spawnedArgs.find((a) => a[1] === "kill" && a[2] === "--signal=KILL");
      expect(dockerKillCall).toBeUndefined();
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("container.exec: abort signal fires mid-flight → proc.kill(9) only, docker kill NOT called (preserves container)", async () => {
    let callCount = 0;
    const spawnedArgs: string[][] = [];
    const ac = new AbortController();
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: string[]) => {
      callCount += 1;
      spawnedArgs.push(args);
      if (callCount <= 2) return fakeProc({ stdout: "abid\n", stderr: "", exitCode: 0 });
      // 3rd call = docker exec — resolves only after abort fires.
      if (callCount === 3) {
        // `let` justified: resolveExited is assigned inside Promise constructor.
        let resolveExited: (code: number) => void = () => undefined;
        const exitedP = new Promise<number>((res) => {
          resolveExited = res;
        });
        const kill = mock(() => {
          resolveExited(-9);
        });
        // Fire abort immediately in the next microtask so the exec is mid-flight.
        Promise.resolve()
          .then(() => {
            ac.abort();
          })
          .catch((_: unknown) => undefined);
        return {
          stdout: new Response(new TextEncoder().encode("")).body,
          stderr: new Response(new TextEncoder().encode("")).body,
          exited: exitedP,
          exitCode: null,
          kill,
        };
      }
      // Any additional spawn calls would indicate an unexpected docker kill — flag them.
      return fakeProc({ stdout: "", stderr: "", exitCode: 0 });
    });
    try {
      const client = createDefaultDockerClient();
      const container = await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
      });
      const r = await container.exec("sleep 100", { signal: ac.signal });
      // Abort → exitCode 130.
      expect(r.exitCode).toBe(130);
      // docker kill --signal=KILL must NOT be called on abort — it kills PID 1.
      const dockerKillCall = spawnedArgs.find((a) => a[1] === "kill" && a[2] === "--signal=KILL");
      expect(dockerKillCall).toBeUndefined();
    } finally {
      spawnSpy.mockRestore();
    }
  });

  // Fix 1 regression: after a per-exec timeout, the container must still be usable.
  // The in-container `timeout` kills only the wrapped process — NOT PID 1 (sleep infinity).
  // A subsequent exec call on the same container object must succeed.
  test("container.exec: container still usable after per-exec timeout (in-container timeout preserves PID 1)", async () => {
    let callCount = 0;
    const spawnedArgs: string[][] = [];
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: string[]) => {
      callCount += 1;
      spawnedArgs.push(args);
      // Calls 1-2 = docker create + docker start
      if (callCount <= 2) return fakeProc({ stdout: "alive-cid\n", stderr: "", exitCode: 0 });
      // Call 3 = first exec — simulates in-container timeout exit code 124
      if (callCount === 3) return fakeProc({ stdout: "", stderr: "", exitCode: 124 });
      // Call 4 = second exec — container is still alive, succeeds normally
      return fakeProc({ stdout: "still-alive", stderr: "", exitCode: 0 });
    });
    try {
      const client = createDefaultDockerClient();
      const container = await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
      });
      // First exec times out (in-container timeout exits with 124)
      const r1 = await container.exec("sleep 100", { timeoutMs: 5 });
      expect(r1.exitCode).toBe(124);
      // docker kill must NOT have been called — container is still alive
      const killCall = spawnedArgs.find((a) => a[1] === "kill");
      expect(killCall).toBeUndefined();
      // Second exec succeeds — container is still alive
      const r2 = await container.exec("echo still-alive");
      expect(r2.exitCode).toBe(0);
      expect(r2.stdout).toBe("still-alive");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("container.stop: calls docker stop", async () => {
    let callCount = 0;
    const stopArgs: string[][] = [];
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: string[]) => {
      callCount += 1;
      if (callCount <= 2) return fakeProc({ stdout: "sid\n", stderr: "", exitCode: 0 });
      stopArgs.push(args);
      return fakeProc({ stdout: "", stderr: "", exitCode: 0 });
    });
    try {
      const client = createDefaultDockerClient();
      const container = await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
      });
      await container.stop();
      expect(stopArgs[0]).toContain("stop");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("container.remove: calls docker rm -f", async () => {
    let callCount = 0;
    const rmArgs: string[][] = [];
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: string[]) => {
      callCount += 1;
      if (callCount <= 2) return fakeProc({ stdout: "rid\n", stderr: "", exitCode: 0 });
      rmArgs.push(args);
      return fakeProc({ stdout: "", stderr: "", exitCode: 0 });
    });
    try {
      const client = createDefaultDockerClient();
      const container = await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
      });
      await container.remove();
      expect(rmArgs[0]).toContain("rm");
      expect(rmArgs[0]).toContain("-f");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("container.readFile: decodes base64 output", async () => {
    const content = "hello file";
    const b64 = Buffer.from(content).toString("base64");
    let callCount = 0;
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((_args: string[]) => {
      callCount += 1;
      if (callCount <= 2) return fakeProc({ stdout: "fid\n", stderr: "", exitCode: 0 });
      return fakeProc({ stdout: b64, stderr: "", exitCode: 0 });
    });
    try {
      const client = createDefaultDockerClient();
      const container = await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
      });
      const bytes = await container.readFile("/foo.txt");
      expect(new TextDecoder().decode(bytes)).toBe(content);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("container.readFile: throws when exec fails", async () => {
    let callCount = 0;
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((_args: string[]) => {
      callCount += 1;
      if (callCount <= 2) return fakeProc({ stdout: "eid\n", stderr: "", exitCode: 0 });
      return fakeProc({ stdout: "", stderr: "no such file", exitCode: 1 });
    });
    try {
      const client = createDefaultDockerClient();
      const container = await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
      });
      await expect(container.readFile("/missing.txt")).rejects.toThrow("readFile failed");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("container.writeFile: calls docker exec with base64-encoded content", async () => {
    let callCount = 0;
    const writeArgs: string[][] = [];
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: string[]) => {
      callCount += 1;
      if (callCount <= 2) return fakeProc({ stdout: "wid\n", stderr: "", exitCode: 0 });
      writeArgs.push(args);
      return fakeProc({ stdout: "", stderr: "", exitCode: 0 });
    });
    try {
      const client = createDefaultDockerClient();
      const container = await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
      });
      await container.writeFile("/out.txt", new TextEncoder().encode("payload"));
      expect(writeArgs[0]).toContain("exec");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("container.writeFile: throws when exec fails", async () => {
    let callCount = 0;
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((_args: string[]) => {
      callCount += 1;
      if (callCount <= 2) return fakeProc({ stdout: "xid\n", stderr: "", exitCode: 0 });
      return fakeProc({ stdout: "", stderr: "write error", exitCode: 1 });
    });
    try {
      const client = createDefaultDockerClient();
      const container = await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
      });
      await expect(
        container.writeFile("/out.txt", new TextEncoder().encode("data")),
      ).rejects.toThrow("writeFile failed");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("container.stop: throws when docker stop returns nonzero", async () => {
    let callCount = 0;
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((_args: string[]) => {
      callCount += 1;
      if (callCount <= 2) return fakeProc({ stdout: "stopfail\n", stderr: "", exitCode: 0 });
      return fakeProc({ stdout: "", stderr: "cannot stop", exitCode: 1 });
    });
    try {
      const client = createDefaultDockerClient();
      const container = await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
      });
      await expect(container.stop()).rejects.toThrow("docker stop failed");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("container.remove: throws when docker rm -f returns nonzero", async () => {
    let callCount = 0;
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((_args: string[]) => {
      callCount += 1;
      if (callCount <= 2) return fakeProc({ stdout: "rmfail\n", stderr: "", exitCode: 0 });
      return fakeProc({ stdout: "", stderr: "cannot remove", exitCode: 1 });
    });
    try {
      const client = createDefaultDockerClient();
      const container = await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
      });
      await expect(container.remove()).rejects.toThrow("docker rm -f failed");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("buildCreateArgs: passes pidsLimit, memoryMb, binds, capAdd, env to docker create", async () => {
    const createArgs: string[][] = [];
    let callCount = 0;
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: string[]) => {
      callCount += 1;
      createArgs.push(args);
      if (callCount === 1) return fakeProc({ stdout: "pid\n", stderr: "", exitCode: 0 });
      return fakeProc({ stdout: "", stderr: "", exitCode: 0 });
    });
    try {
      const client = createDefaultDockerClient();
      await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
        pidsLimit: 64,
        memoryMb: 256,
        binds: ["/tmp:/tmp:ro"],
        capAdd: ["SYS_PTRACE"],
        env: { FOO: "bar" },
      });
      const first = createArgs[0] ?? [];
      expect(first).toContain("--pids-limit");
      expect(first).toContain("64");
      expect(first).toContain("--memory");
      expect(first).toContain("256m");
      expect(first).toContain("--volume");
      expect(first).toContain("/tmp:/tmp:ro");
      expect(first).toContain("--cap-add");
      expect(first).toContain("SYS_PTRACE");
      expect(first).toContain("FOO=bar");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  // Fix 3: bounded exec — container.exec passes --workdir when cwd is set
  test("container.exec: passes --workdir when cwd option is set", async () => {
    let callCount = 0;
    const execArgs: string[][] = [];
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: string[]) => {
      callCount += 1;
      if (callCount <= 2) {
        return fakeProc({ stdout: "cwdid\n", stderr: "", exitCode: 0 });
      }
      execArgs.push(args);
      return fakeProc({ stdout: "", stderr: "", exitCode: 0 });
    });
    try {
      const client = createDefaultDockerClient();
      const container = await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
      });
      await container.exec("pwd", { cwd: "/workspace/project" });
      const first = execArgs[0] ?? [];
      expect(first).toContain("--workdir");
      expect(first).toContain("/workspace/project");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  // Fix 2 (drain-not-kill): output cap → truncated=true, original exit code preserved, no kill on cap
  test("container.exec: drain-not-kill on output cap — truncated=true, original exitCode preserved", async () => {
    let callCount = 0;
    const killCalls: string[][] = [];
    // Generate a string slightly larger than our test cap (64 bytes)
    const bigOutput = "x".repeat(128);
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: string[]) => {
      callCount += 1;
      if (callCount <= 2) return fakeProc({ stdout: "trid\n", stderr: "", exitCode: 0 });
      // Capture any docker kill calls that happen after the 3rd spawn (the exec).
      if (args[1] === "kill") {
        killCalls.push(args);
        return fakeProc({ stdout: "", stderr: "", exitCode: 0 });
      }
      // The exec process completes naturally with exitCode 0.
      return fakeProc({ stdout: bigOutput, stderr: "", exitCode: 0 });
    });
    try {
      const client = createDefaultDockerClient();
      const container = await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
      });
      // Set a small cap so the 128-byte output triggers truncation
      const r = await container.exec("cat /big", { maxOutputBytes: 64 });
      // Truncation happened but the process was NOT killed on cap — drain-not-kill.
      expect(r.truncated).toBe(true);
      expect(r.stdout.length).toBeLessThanOrEqual(64);
      // Original exit code (0) is preserved — NOT artificially 137 or -9.
      expect(r.exitCode).toBe(0);
      // No docker kill should have been spawned (cap alone does not kill).
      expect(killCalls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  // Fix 2 (socketPath): DOCKER_HOST=unix://<path> is set when socketPath configured.
  // We verify via buildDockerEnv (unit-tested below) + the factory env integration:
  // createDefaultDockerClient builds env once at factory time and passes it to every
  // Bun.spawn call. The mock captures call args via .mock.calls[n][1].env.
  test("createDefaultDockerClient: passes DOCKER_HOST env when socketPath configured", async () => {
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((_args: string[]) =>
      fakeProc({ stdout: "sockid\n", stderr: "", exitCode: 0 }),
    );
    try {
      const client = createDefaultDockerClient({ socketPath: "/custom/path/docker.sock" });
      await client.createContainer({ image: "ubuntu:22.04", networkMode: "none" });
      // Inspect env from each spawn call — it's the second argument.
      for (const callArgs of spawnSpy.mock.calls) {
        const opts = callArgs[1] as { env?: Record<string, string> } | undefined;
        expect(opts?.env?.DOCKER_HOST).toBe("unix:///custom/path/docker.sock");
      }
    } finally {
      spawnSpy.mockRestore();
    }
  });

  // Fix 2 (buildDockerEnv): no socketPath → no DOCKER_HOST
  test("buildDockerEnv: does not set DOCKER_HOST when socketPath is undefined", () => {
    const env = buildDockerEnv(undefined);
    expect(env.DOCKER_HOST).toBeUndefined();
  });

  // Fix 2 (buildDockerEnv): socketPath set → DOCKER_HOST present
  test("buildDockerEnv: sets DOCKER_HOST when socketPath is provided", () => {
    const env = buildDockerEnv("/run/docker.sock");
    expect(env.DOCKER_HOST).toBe("unix:///run/docker.sock");
  });

  // Fix 2 (read-only rootfs): readOnlyRoot=true → --read-only in docker create args
  test("buildCreateArgs: passes --read-only when readOnlyRoot is true", async () => {
    const createArgs: string[][] = [];
    let callCount = 0;
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: string[]) => {
      callCount += 1;
      createArgs.push(args);
      if (callCount === 1) return fakeProc({ stdout: "rrid\n", stderr: "", exitCode: 0 });
      return fakeProc({ stdout: "", stderr: "", exitCode: 0 });
    });
    try {
      const client = createDefaultDockerClient();
      await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
        readOnlyRoot: true,
        tmpfsMounts: ["/tmp"],
      });
      const first = createArgs[0] ?? [];
      expect(first).toContain("--read-only");
      expect(first).toContain("--tmpfs");
      expect(first).toContain("/tmp");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  // Fix 2 (read-only rootfs): readOnlyRoot not set → no --read-only in docker create args
  test("buildCreateArgs: omits --read-only when readOnlyRoot is not set", async () => {
    const createArgs: string[][] = [];
    let callCount = 0;
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((args: string[]) => {
      callCount += 1;
      createArgs.push(args);
      if (callCount === 1) return fakeProc({ stdout: "norrid\n", stderr: "", exitCode: 0 });
      return fakeProc({ stdout: "", stderr: "", exitCode: 0 });
    });
    try {
      const client = createDefaultDockerClient();
      await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
      });
      const first = createArgs[0] ?? [];
      expect(first).not.toContain("--read-only");
      expect(first).not.toContain("--tmpfs");
    } finally {
      spawnSpy.mockRestore();
    }
  });

  // Fix 3: buildDockerEnv forwards DOCKER_CONTEXT when set in process.env
  test("buildDockerEnv: forwards DOCKER_CONTEXT from process.env", () => {
    process.env.DOCKER_CONTEXT = "test-ctx";
    try {
      const env = buildDockerEnv(undefined);
      expect(env.DOCKER_CONTEXT).toBe("test-ctx");
    } finally {
      delete process.env.DOCKER_CONTEXT;
    }
  });

  // Fix 3: buildDockerEnv forwards DOCKER_CONFIG when set in process.env
  test("buildDockerEnv: forwards DOCKER_CONFIG from process.env", () => {
    process.env.DOCKER_CONFIG = "/custom/.docker";
    try {
      const env = buildDockerEnv(undefined);
      expect(env.DOCKER_CONFIG).toBe("/custom/.docker");
    } finally {
      delete process.env.DOCKER_CONFIG;
    }
  });

  // Fix 3: buildDockerEnv forwards DOCKER_TLS_VERIFY and DOCKER_CERT_PATH
  test("buildDockerEnv: forwards DOCKER_TLS_VERIFY and DOCKER_CERT_PATH", () => {
    process.env.DOCKER_TLS_VERIFY = "1";
    process.env.DOCKER_CERT_PATH = "/certs";
    try {
      const env = buildDockerEnv(undefined);
      expect(env.DOCKER_TLS_VERIFY).toBe("1");
      expect(env.DOCKER_CERT_PATH).toBe("/certs");
    } finally {
      delete process.env.DOCKER_TLS_VERIFY;
      delete process.env.DOCKER_CERT_PATH;
    }
  });

  // Fix 3: buildDockerEnv forwards DOCKER_API_VERSION and XDG_CONFIG_HOME
  test("buildDockerEnv: forwards DOCKER_API_VERSION and XDG_CONFIG_HOME", () => {
    process.env.DOCKER_API_VERSION = "1.41";
    process.env.XDG_CONFIG_HOME = "/home/user/.config";
    try {
      const env = buildDockerEnv(undefined);
      expect(env.DOCKER_API_VERSION).toBe("1.41");
      expect(env.XDG_CONFIG_HOME).toBe("/home/user/.config");
    } finally {
      delete process.env.DOCKER_API_VERSION;
      delete process.env.XDG_CONFIG_HOME;
    }
  });

  // Fix 3: socketPath overrides any DOCKER_HOST from process.env
  test("buildDockerEnv: socketPath overrides DOCKER_HOST from process.env", () => {
    process.env.DOCKER_HOST = "tcp://remote:2376";
    try {
      const env = buildDockerEnv("/run/custom.sock");
      // socketPath wins — host DOCKER_HOST must not survive
      expect(env.DOCKER_HOST).toBe("unix:///run/custom.sock");
    } finally {
      delete process.env.DOCKER_HOST;
    }
  });

  // Fix 3: vars not present in process.env are not included in the result
  test("buildDockerEnv: does not include env keys absent from process.env", () => {
    // Ensure none of the docker vars are in process.env for this test
    const dockerKeys = [
      "DOCKER_CONTEXT",
      "DOCKER_CONFIG",
      "DOCKER_TLS_VERIFY",
      "DOCKER_CERT_PATH",
      "DOCKER_API_VERSION",
      "XDG_CONFIG_HOME",
    ];
    const saved: Record<string, string | undefined> = {};
    for (const k of dockerKeys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      const env = buildDockerEnv(undefined);
      for (const k of dockerKeys) {
        expect(env[k]).toBeUndefined();
      }
    } finally {
      for (const k of dockerKeys) {
        if (saved[k] !== undefined) process.env[k] = saved[k];
      }
    }
  });
});
