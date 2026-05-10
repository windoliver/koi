/**
 * Layer-2 e2e: real two-process flow over real HTTP transport.
 *
 * Spawns:
 *   1. An in-test Bun.serve daemon implementing the Nexus JSON-RPC surface
 *      (ipc.send, ipc.list) with a persisted in-memory mailbox.
 *   2. A child Bun process running the coordinator (fixtures/coordinator-script.ts).
 *   3. A child Bun process running the worker (fixtures/worker-script.ts).
 *
 * Asserts the worker's stdout decision matches the coordinator's verdict.
 * Catches HTTP wire-format, serialization, and cross-process lifecycle issues
 * that single-process integration tests miss.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type Subprocess, spawn } from "bun";

interface Envelope {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly correlationId?: string | undefined;
  readonly createdAt: string;
  readonly ttlSeconds?: number | undefined;
  readonly type: string;
  readonly payload: unknown;
  readonly metadata?: Record<string, unknown> | undefined;
}

interface DaemonHandle {
  readonly url: string;
  readonly stop: () => void;
  readonly inbox: Map<string, Envelope[]>;
}

function startDaemon(): DaemonHandle {
  const inbox = new Map<string, Envelope[]>();
  let nextId = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req: Request) {
      const path = new URL(req.url).pathname;
      const match = path.match(/^\/api\/nfs\/(.+)$/);
      if (match === null || req.method !== "POST")
        return new Response("not found", { status: 404 });
      const method = decodeURIComponent(match[1] ?? "");
      const body = (await req.json()) as { id: number; params: Record<string, unknown> };
      const params = body.params ?? {};

      if (method === "ipc.send") {
        nextId += 1;
        const env: Envelope = {
          id: `env-${nextId}`,
          from: String(params.from),
          to: String(params.to),
          kind: String(params.kind),
          correlationId: params.correlationId as string | undefined,
          createdAt: new Date().toISOString(),
          ttlSeconds: params.ttlSeconds as number | undefined,
          type: String(params.type),
          payload: params.payload,
          metadata: params.metadata as Record<string, unknown> | undefined,
        };
        const list = inbox.get(env.to) ?? [];
        list.push(env);
        inbox.set(env.to, list);
        return Response.json({ jsonrpc: "2.0", id: body.id, result: env });
      }
      if (method === "ipc.list") {
        const agentId = String(params.agentId);
        const limit = Number(params.limit ?? 50);
        const messages = (inbox.get(agentId) ?? []).slice(0, limit);
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { messages } });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: `method not found: ${method}` },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    inbox,
    stop: () => {
      server.stop(true);
    },
  };
}

const WORKER_SCRIPT = resolve(import.meta.dir, "fixtures/worker-script.ts");
const COORDINATOR_SCRIPT = resolve(import.meta.dir, "fixtures/coordinator-script.ts");

async function readToString(
  stream: ReadableStream<Uint8Array> | null | undefined | number,
): Promise<string> {
  if (typeof stream === "number" || stream === null || stream === undefined) return "";
  if (stream === null || stream === undefined) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

async function waitForLine(
  stream: ReadableStream<Uint8Array> | null | undefined | number,
  needle: string,
  timeoutMs = 5_000,
): Promise<void> {
  if (typeof stream === "number" || stream === null || stream === undefined)
    throw new Error("no stdout");
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buf = "";
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) =>
        setTimeout(() => r({ value: undefined, done: true }), Math.max(50, deadline - Date.now())),
      ),
    ]);
    if (done) break;
    if (value !== undefined) buf += decoder.decode(value);
    if (buf.includes(needle)) {
      reader.releaseLock();
      return;
    }
  }
  reader.releaseLock();
  throw new Error(`timeout waiting for "${needle}"; got: ${buf.slice(0, 500)}`);
}

let daemon: DaemonHandle;
let coord: Subprocess | null = null;
let worker: Subprocess | null = null;

beforeEach(() => {
  daemon = startDaemon();
});

afterEach(() => {
  if (worker !== null && !worker.killed) worker.kill("SIGKILL");
  if (coord !== null && !coord.killed) coord.kill("SIGKILL");
  worker = null;
  coord = null;
  daemon.stop();
});

describe("permission-escalation-nexus two-process e2e", () => {
  test("happy approve: real worker proc + real coord proc + real HTTP transport", async () => {
    coord = spawn({
      cmd: ["bun", "run", COORDINATOR_SCRIPT],
      env: { ...process.env, NEXUS_URL: daemon.url, VERDICT: "approve" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForLine(coord.stdout, "ready");

    worker = spawn({
      cmd: ["bun", "run", WORKER_SCRIPT],
      env: {
        ...process.env,
        NEXUS_URL: daemon.url,
        REQUEST_ID: "req-l2-approve",
        PURPOSE: "patch a file",
        TTL_MS: "10000",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await worker.exited;
    const out = await readToString(worker.stdout);
    const errStr = await readToString(worker.stderr);
    expect(exitCode).toBe(0);
    const decision = JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
    expect(decision).toEqual({ decision: "approved", grantedGrants: ["fs:write"] });
    expect(errStr).toBe("");
  }, 15_000);

  test("denial: coordinator denies; worker observes rejected with reason", async () => {
    coord = spawn({
      cmd: ["bun", "run", COORDINATOR_SCRIPT],
      env: { ...process.env, NEXUS_URL: daemon.url, VERDICT: "policy-block" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForLine(coord.stdout, "ready");

    worker = spawn({
      cmd: ["bun", "run", WORKER_SCRIPT],
      env: {
        ...process.env,
        NEXUS_URL: daemon.url,
        REQUEST_ID: "req-l2-deny",
        PURPOSE: "ship to prod",
        TTL_MS: "10000",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await worker.exited;
    const out = await readToString(worker.stdout);
    expect(exitCode).toBe(0);
    const decision = JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
    expect(decision).toEqual({
      decision: "rejected",
      reason: "coordinator denied (policy-block)",
    });
  }, 15_000);

  test("worker times out cleanly when no coordinator is running", async () => {
    // No coord spawned. Worker uses short TTL; expect "expired" decision.
    worker = spawn({
      cmd: ["bun", "run", WORKER_SCRIPT],
      env: {
        ...process.env,
        NEXUS_URL: daemon.url,
        REQUEST_ID: "req-l2-timeout",
        PURPOSE: "no one home",
        TTL_MS: "500",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await worker.exited;
    const out = await readToString(worker.stdout);
    expect(exitCode).toBe(0);
    const decision = JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
    expect(decision.decision).toBe("expired");
  }, 10_000);

  test("daemon down mid-flight: worker observes a rejected/expired decision, never approved", async () => {
    // Bring up daemon, start worker, kill daemon mid-poll. No coord running, so
    // worker is in its polling loop hitting the daemon. Killing the daemon causes
    // subsequent ipc.list/ipc.send calls to fail; worker must fail closed.
    worker = spawn({
      cmd: ["bun", "run", WORKER_SCRIPT],
      env: {
        ...process.env,
        NEXUS_URL: daemon.url,
        REQUEST_ID: "req-l2-daemon-down",
        PURPOSE: "daemon will die",
        TTL_MS: "3000",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    // Let the worker start and issue at least one HTTP call.
    await Bun.sleep(200);
    daemon.stop();
    const exitCode = await worker.exited;
    const out = await readToString(worker.stdout);
    expect(exitCode).toBe(0);
    const decision = JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
    // Whatever happens, the worker MUST NOT silently approve.
    expect(decision.decision === "rejected" || decision.decision === "expired").toBe(true);
  }, 15_000);
});
