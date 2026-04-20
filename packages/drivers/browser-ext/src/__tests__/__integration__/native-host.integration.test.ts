import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFrameReader } from "../../native-host/frame-reader.js";
import { createFrameWriter } from "../../native-host/frame-writer.js";

const GATE = process.env.KOI_TEST_INTEGRATION === "1";

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stat } = await import("node:fs/promises");
      await stat(path);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  return false;
}

class FrameQueue {
  private readonly pending: string[] = [];
  private readonly waiters: Array<{
    resolve: (v: string) => void;
    reject: (e: Error) => void;
  }> = [];
  private closed = false;
  private error: Error | null = null;

  constructor(reader: AsyncGenerator<string>) {
    (async (): Promise<void> => {
      try {
        for await (const frame of reader) {
          const waiter = this.waiters.shift();
          if (waiter) waiter.resolve(frame);
          else this.pending.push(frame);
        }
        this.closed = true;
        while (this.waiters.length > 0) {
          this.waiters.shift()?.reject(new Error("stream ended before frame arrived"));
        }
      } catch (err) {
        this.error = err instanceof Error ? err : new Error(String(err));
        while (this.waiters.length > 0) {
          this.waiters.shift()?.reject(this.error);
        }
      }
    })();
  }

  next(timeoutMs = 5_000): Promise<string> {
    const frame = this.pending.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    if (this.closed) return Promise.reject(new Error("stream closed"));
    if (this.error) return Promise.reject(this.error);
    return new Promise<string>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          reject(new Error(`FrameQueue.next timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });
  }
}

interface HostHarness {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly extFrames: FrameQueue;
  readonly extStdinWriter: ReturnType<typeof createFrameWriter>;
  readonly socketPath: string;
  readonly discoveryDir: string;
  readonly quarantineDir: string;
  readonly authDir: string;
}

async function startHost(baseDir: string): Promise<HostHarness> {
  const authDir = join(baseDir, "auth");
  const discoveryDir = join(baseDir, "instances");
  const quarantineDir = join(baseDir, "quarantine");
  const socketPath = join(baseDir, "host.sock");
  await mkdir(authDir, { recursive: true, mode: 0o700 });

  const token = "1".repeat(64);
  const adminKey = "2".repeat(64);
  const installId = "a".repeat(64);
  await writeFile(join(authDir, "token"), token, { mode: 0o600 });
  await chmod(join(authDir, "token"), 0o600);
  await writeFile(join(authDir, "admin.key"), adminKey, { mode: 0o600 });
  await chmod(join(authDir, "admin.key"), 0o600);
  await writeFile(join(authDir, "installId"), `${installId}\n`, { mode: 0o600 });
  await chmod(join(authDir, "installId"), 0o600);

  const launcher = join(import.meta.dir, "launch-host.mjs");
  const proc = spawn("node", [launcher], {
    env: {
      ...process.env,
      KOI_BE_SOCKET: socketPath,
      KOI_BE_DISCOVERY: discoveryDir,
      KOI_BE_QUARANTINE: quarantineDir,
      KOI_BE_AUTH: authDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stderr.setEncoding("utf-8");
  proc.stderr.on("data", (d: string) => {
    // Surface subprocess stderr to make failures debuggable.
    if (d.trim().length > 0) console.error(`[host-stderr] ${d.trim()}`);
  });

  const extFrames = new FrameQueue(createFrameReader(proc.stdout));
  const extStdinWriter = createFrameWriter(proc.stdin);

  return { proc, extFrames, extStdinWriter, socketPath, discoveryDir, quarantineDir, authDir };
}

function shutdownHarness(h: HostHarness): Promise<void> {
  h.proc.stdin.end();
  return new Promise<void>((resolve) => {
    const kill = setTimeout(() => {
      h.proc.kill("SIGTERM");
    }, 2_000);
    h.proc.on("exit", () => {
      clearTimeout(kill);
      resolve();
    });
  });
}

describe.skipIf(!GATE)("native-host integration — happy path", () => {
  let dir: string;
  let harness: HostHarness | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "koi-be-int-"));
  });

  afterEach(async () => {
    if (harness) {
      await shutdownHarness(harness);
      harness = null;
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("spawn host → extension_hello → host_hello → discovery publishes → driver hello → bye", async () => {
    harness = await startHost(dir);

    // 1. Extension side: send extension_hello over stdin.
    await harness.extStdinWriter.write(
      JSON.stringify({
        kind: "extension_hello",
        extensionId: "fake-ext-id",
        extensionVersion: "0.1.0",
        installId: "a".repeat(64),
        browserSessionId: "test-session",
        supportedProtocols: [1],
      }),
    );

    // 2. Expect host_hello back on stdout.
    const hostHelloRaw = await harness.extFrames.next();
    const hostHello = JSON.parse(hostHelloRaw) as {
      kind: string;
      installId: string;
      selectedProtocol: number;
    };
    expect(hostHello.kind).toBe("host_hello");
    expect(hostHello.installId).toBe("a".repeat(64));
    expect(hostHello.selectedProtocol).toBe(1);

    // 3. Respond to attach_state_probe with empty attachedTabs.
    //    The host awaits this ack before publishing discovery file.
    const probeRaw = await harness.extFrames.next();
    const probe = JSON.parse(probeRaw) as { kind: string; requestId: string };
    expect(probe.kind).toBe("attach_state_probe");
    await harness.extStdinWriter.write(
      JSON.stringify({
        kind: "attach_state_probe_ack",
        requestId: probe.requestId,
        attachedTabs: [],
      }),
    );

    // 4. Discovery file should appear after accept() loop starts.
    //    Wait up to 3s (boot probe allows for optional second probe at +2s).
    const discoveryFile = join(harness.discoveryDir, `${harness.proc.pid ?? 0}.json`);
    const discovered = await waitForFile(discoveryFile, 3_500);
    expect(discovered).toBe(true);

    // 5. Driver side: connect over the Unix socket and exchange hello.
    const active = harness;
    const socket: Socket = await new Promise((resolve, reject) => {
      const s = createConnection(active.socketPath);
      s.on("connect", () => resolve(s));
      s.on("error", reject);
    });

    const drvFrames = new FrameQueue(createFrameReader(socket));
    const drvWriter = createFrameWriter(socket);

    await drvWriter.write(
      JSON.stringify({
        kind: "hello",
        token: "1".repeat(64),
        driverVersion: "0.1.0",
        supportedProtocols: [1],
        leaseToken: "f".repeat(32),
      }),
    );
    const helloAckRaw = await drvFrames.next();
    const helloAck = JSON.parse(helloAckRaw) as {
      kind: string;
      ok: boolean;
      role: string;
    };
    expect(helloAck.kind).toBe("hello_ack");
    expect(helloAck.ok).toBe(true);
    expect(helloAck.role).toBe("driver");

    // 6. Bye closes the driver connection.
    await drvWriter.write(JSON.stringify({ kind: "bye" }));
    drvWriter.close();
    socket.end();

    // 7. Shutdown cleanly.
    await shutdownHarness(harness);
    harness = null;
  }, 15_000);
});
