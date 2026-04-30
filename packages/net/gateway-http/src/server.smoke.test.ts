import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Gateway } from "@koi/gateway-types";
import { createGatewayServer } from "./server.js";
import type { GatewayServer } from "./types.js";

function stubGateway(): Gateway {
  return {
    ingest: () => undefined,
    pauseIngress: () => undefined,
    forceClose: () => undefined,
    activeConnections: () => 0,
  };
}

function tmpLockPath(): string {
  return join(tmpdir(), `koi-gateway-http-smoke-${crypto.randomUUID()}.lock`);
}

describe("createGatewayServer (smoke)", () => {
  let server: GatewayServer | null = null;

  afterEach(async () => {
    if (server !== null) {
      await server.stop();
      server = null;
    }
  });

  test("starts on ephemeral port, serves /healthz, stops cleanly", async () => {
    server = createGatewayServer(
      { bind: "127.0.0.1:0", lockFilePath: tmpLockPath() },
      { gateway: stubGateway() },
    );

    const startResult = await server.start();
    expect(startResult.ok).toBe(true);

    const port = server.port();
    expect(port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, draining: false });

    await server.stop();

    let postStopFailed = false;
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`);
    } catch {
      postStopFailed = true;
    }
    expect(postStopFailed).toBe(true);
    server = null;
  });

  test("rejects non-loopback bind without proxyTrust", async () => {
    const s = createGatewayServer(
      { bind: "10.0.0.1:0", lockFilePath: tmpLockPath() },
      { gateway: stubGateway() },
    );
    const result = await s.start();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_CONFIG");
    }
  });

  test("returns 404 for unknown routes", async () => {
    server = createGatewayServer(
      { bind: "127.0.0.1:0", lockFilePath: tmpLockPath() },
      { gateway: stubGateway() },
    );
    await server.start();
    const res = await fetch(`http://127.0.0.1:${server.port()}/nope`);
    expect(res.status).toBe(404);
  });
});
