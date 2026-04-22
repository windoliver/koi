import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createFrameReader } from "../../native-host/frame-reader.js";
import { createFrameWriter } from "../../native-host/frame-writer.js";

export const HARNESS_TOKEN: string = "1".repeat(64);
export const HARNESS_ADMIN_KEY: string = "2".repeat(64);
export const HARNESS_INSTALL_ID: string = "a".repeat(64);

export async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  return false;
}

export class FrameQueue {
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

  async nextMatching(
    predicate: (frame: { kind?: string }) => boolean,
    timeoutMs = 5_000,
  ): Promise<{ kind?: string; [k: string]: unknown }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = await this.next(Math.max(100, deadline - Date.now()));
      const parsed = JSON.parse(frame) as { kind?: string; [k: string]: unknown };
      if (predicate(parsed)) return parsed;
    }
    throw new Error(`nextMatching timed out after ${timeoutMs}ms`);
  }
}

export interface HostHarness {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly extFrames: FrameQueue;
  readonly extStdin: ReturnType<typeof createFrameWriter>;
  readonly socketPath: string;
  readonly discoveryDir: string;
  readonly quarantineDir: string;
  readonly authDir: string;
}

export interface HostHarnessOptions {
  readonly baseDir: string;
  /** Reuse an auth dir (for restart-after-crash tests). If set, auth files aren't rewritten. */
  readonly reuseAuth?: boolean;
  /** Reuse a discovery dir + quarantine dir. Defaults true so crash-restart tests can share state. */
  readonly discoveryDir?: string;
  readonly quarantineDir?: string;
  readonly socketPath?: string;
}

export async function startHost(opts: HostHarnessOptions): Promise<HostHarness> {
  const authDir = join(opts.baseDir, "auth");
  const discoveryDir = opts.discoveryDir ?? join(opts.baseDir, "instances");
  const quarantineDir = opts.quarantineDir ?? join(opts.baseDir, "quarantine");
  const socketPath = opts.socketPath ?? join(opts.baseDir, "host.sock");
  await mkdir(authDir, { recursive: true, mode: 0o700 });

  if (!opts.reuseAuth) {
    await writeFile(join(authDir, "token"), HARNESS_TOKEN, { mode: 0o600 });
    await chmod(join(authDir, "token"), 0o600);
    await writeFile(join(authDir, "admin.key"), HARNESS_ADMIN_KEY, { mode: 0o600 });
    await chmod(join(authDir, "admin.key"), 0o600);
    await writeFile(join(authDir, "installId"), `${HARNESS_INSTALL_ID}\n`, { mode: 0o600 });
    await chmod(join(authDir, "installId"), 0o600);
  }

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
    if (d.trim().length > 0 && process.env.KOI_TEST_VERBOSE === "1") {
      console.error(`[host-stderr] ${d.trim()}`);
    }
  });

  const extFrames = new FrameQueue(createFrameReader(proc.stdout));
  const extStdin = createFrameWriter(proc.stdin);

  return { proc, extFrames, extStdin, socketPath, discoveryDir, quarantineDir, authDir };
}

export function shutdownHarness(h: HostHarness, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (h.proc.exitCode !== null) return Promise.resolve();
  h.proc.stdin.end();
  return new Promise<void>((resolve) => {
    const kill = setTimeout(() => {
      try {
        h.proc.kill(signal);
      } catch {}
    }, 1_500);
    h.proc.on("exit", () => {
      clearTimeout(kill);
      resolve();
    });
  });
}

/**
 * Walks the standard boot handshake:
 *   1. send extension_hello
 *   2. receive host_hello
 *   3. receive attach_state_probe; reply with empty ack
 *   4. wait for discovery file publish
 *
 * Returns once the host's socket is ready for drivers. Throws on timeout.
 */
export async function bootHost(h: HostHarness): Promise<void> {
  const harnessInstanceUuid = "11111111-1111-4111-8111-111111111111";
  const harnessBrowserSessionUuid = "22222222-2222-4222-8222-222222222222";
  await h.extStdin.write(
    JSON.stringify({
      kind: "extension_hello",
      extensionId: "integration-test-ext",
      extensionVersion: "0.1.0",
      installId: HARNESS_INSTALL_ID,
      browserSessionId: harnessBrowserSessionUuid,
      supportedProtocols: [1],
      identity: {
        instanceId: harnessInstanceUuid,
        browserSessionId: harnessBrowserSessionUuid,
        browserHint: "chrome",
        name: "koi-browser-ext-test",
      },
      epoch: 1,
      seq: 1,
    }),
  );

  const hostHello = await h.extFrames.nextMatching((f) => f.kind === "host_hello");
  if ((hostHello as { installId?: string }).installId !== HARNESS_INSTALL_ID) {
    throw new Error("host_hello installId mismatch");
  }

  const probe = await h.extFrames.nextMatching((f) => f.kind === "attach_state_probe");
  await h.extStdin.write(
    JSON.stringify({
      kind: "attach_state_probe_ack",
      requestId: (probe as { requestId: string }).requestId,
      attachedTabs: [],
    }),
  );

  const discoveryFile = join(h.discoveryDir, `${h.proc.pid ?? 0}.json`);
  if (!(await waitForFile(discoveryFile, 3_500))) {
    throw new Error("discovery file did not publish");
  }
}

export async function driverHello(
  socket: import("node:net").Socket,
  leaseToken?: string,
): Promise<{
  reader: FrameQueue;
  writer: ReturnType<typeof createFrameWriter>;
  leaseToken: string;
}> {
  const reader = new FrameQueue(createFrameReader(socket));
  const writer = createFrameWriter(socket);
  // Random lease per connection — host rejects colliding leases across
  // concurrent clients (each driver session must have a distinct lease).
  const lease =
    leaseToken ??
    Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  await writer.write(
    JSON.stringify({
      kind: "hello",
      token: HARNESS_TOKEN,
      driverVersion: "0.1.0",
      supportedProtocols: [1],
      leaseToken: lease,
    }),
  );
  const ack = await reader.nextMatching((f) => f.kind === "hello_ack");
  if ((ack as { ok?: boolean }).ok !== true) {
    throw new Error(`hello_ack ok=false: ${JSON.stringify(ack)}`);
  }
  return { reader, writer, leaseToken: lease };
}
