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

  test("container.exec: honours timeoutMs by arming timer (timer fires → exitCode 124)", async () => {
    let callCount = 0;
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((_args: string[]) => {
      callCount += 1;
      if (callCount <= 2) return fakeProc({ stdout: "tid\n", stderr: "", exitCode: 0 });
      // Simulate a slow process: exited resolves quickly after kill() is called.
      // `let` justified: resolveExited is captured from Promise constructor and called by kill.
      let resolveExited: (code: number) => void = () => undefined;
      const exitedP = new Promise<number>((res) => {
        resolveExited = res;
      });
      const kill = mock(() => {
        // Simulate process being killed — resolve exited immediately.
        resolveExited(-9);
      });
      return {
        stdout: new Response(new TextEncoder().encode("")).body,
        stderr: new Response(new TextEncoder().encode("")).body,
        exited: exitedP,
        exitCode: null,
        kill,
      };
    });
    try {
      const client = createDefaultDockerClient();
      const container = await client.createContainer({
        image: "ubuntu:22.04",
        networkMode: "none",
      });
      // Set a very short timeout (5 ms) so the timer fires quickly.
      const r = await container.exec("sleep 100", { timeoutMs: 5 });
      // Timer fires → timedOut=true → exitCode 124
      expect(r.exitCode).toBe(124);
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

  // Fix 3: bounded exec returns truncated=true when output hits the byte cap
  test("container.exec: returns truncated=true when output exceeds maxOutputBytes", async () => {
    let callCount = 0;
    // Generate a string slightly larger than our test cap (64 bytes)
    const bigOutput = "x".repeat(128);
    // @ts-expect-error — test stub: returning a partial SubProcess for coverage
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((_args: string[]) => {
      callCount += 1;
      if (callCount <= 2) return fakeProc({ stdout: "trid\n", stderr: "", exitCode: 0 });
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
      expect(r.truncated).toBe(true);
      expect(r.stdout.length).toBeLessThanOrEqual(64);
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
});
