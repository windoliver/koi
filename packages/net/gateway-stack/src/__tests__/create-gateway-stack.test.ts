import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { GatewayAuthenticator, Transport, TransportHandler } from "@koi/gateway";
import type { CanvasAuthenticator } from "@koi/gateway-canvas";
import type { NexusTransport } from "@koi/nexus-client";
import { createGatewayStack } from "../create-gateway-stack.js";

// ---------------------------------------------------------------------------
// Minimal stubs — keep the test surface independent of L2 internals.
// ---------------------------------------------------------------------------

function makeAuth(): GatewayAuthenticator {
  return {
    authenticate: async () => ({
      ok: true,
      sessionId: "s",
      agentId: "a",
      metadata: {},
    }),
  };
}

function makeTransport(): Transport & { readonly stop: () => void } {
  let handler: TransportHandler | undefined;
  return {
    listen: async (_port, h) => {
      handler = h;
    },
    close: () => {
      handler = undefined;
    },
    connections: () => 0,
    stop: () => {
      handler = undefined;
    },
  };
}

function makeNexusTransport(behavior: "ok" | "fail" = "ok"): NexusTransport {
  return {
    kind: "http",
    call: async <T>(): Promise<Result<T, KoiError>> =>
      behavior === "ok"
        ? { ok: true, value: undefined as T }
        : {
            ok: false,
            error: { code: "EXTERNAL", message: "down", retryable: RETRYABLE_DEFAULTS.EXTERNAL },
          },
    close: () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createGatewayStack", () => {
  test("standalone (no canvas/webhook/nexus) starts and stops", async () => {
    const stack = createGatewayStack({}, { transport: makeTransport(), auth: makeAuth() });
    expect(stack.canvas).toBeUndefined();
    expect(stack.webhook).toBeUndefined();
    expect(stack.nexus).toBeUndefined();

    await stack.start(0);
    const h = await stack.health();
    expect(h.status).toBe("ok");
    expect(h.components.gateway).toBe(true);
    expect(h.components.canvas).toBe(false);
    expect(h.components.webhook).toBe(false);
    expect(h.components.nexus).toBe(false);
    expect(h.nexus).toBeUndefined();
    await stack.stop();
  });

  test("nexusTransport opt-in wires nexus session store", async () => {
    const stack = createGatewayStack(
      { nexus: { instanceId: "gw-1" } },
      { transport: makeTransport(), auth: makeAuth(), nexusTransport: makeNexusTransport("ok") },
    );
    expect(stack.nexus).toBeDefined();
    await stack.start(0);
    const h = await stack.health();
    expect(h.status).toBe("ok");
    expect(h.nexus?.mode).toBe("healthy");
    expect(h.components.nexus).toBe(true);
    await stack.stop();
  });

  test("missing nexusTransport leaves stack on in-memory store even when config.nexus is set", async () => {
    const stack = createGatewayStack(
      { nexus: { instanceId: "gw-1" } },
      { transport: makeTransport(), auth: makeAuth() },
    );
    expect(stack.nexus).toBeUndefined();
    const h = await stack.health();
    expect(h.components.nexus).toBe(false);
    await stack.stop();
  });

  test("invalid nexus config throws synchronously", () => {
    expect(() =>
      createGatewayStack(
        { nexus: { basePath: "" } },
        {
          transport: makeTransport(),
          auth: makeAuth(),
          nexusTransport: makeNexusTransport("ok"),
        },
      ),
    ).toThrow(/Invalid gateway-nexus config/);
  });

  test("health reports degraded once nexus failures cross threshold", async () => {
    const stack = createGatewayStack(
      { nexus: { degradation: { failureThreshold: 1 } } },
      {
        transport: makeTransport(),
        auth: makeAuth(),
        nexusTransport: makeNexusTransport("fail"),
      },
    );
    if (stack.nexus === undefined) throw new Error("nexus handle missing");
    // Trigger one failed read so the degradation state flips.
    await stack.nexus.store.get("missing");
    const h = await stack.health();
    expect(h.status).toBe("degraded");
    expect(h.nexus?.mode).toBe("degraded");

    const res = await stack.healthHandler(new Request("http://x/health"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("degraded");

    await stack.stop();
  });

  test("healthHandler returns 200 + JSON when healthy", async () => {
    const stack = createGatewayStack({}, { transport: makeTransport(), auth: makeAuth() });
    const res = await stack.healthHandler(new Request("http://x/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
    await stack.stop();
  });

  test("canvas wires when both config.canvas and deps.canvasAuth are provided", async () => {
    const canvasAuth: CanvasAuthenticator = async () => ({
      ok: true,
      value: { agentId: "a" },
    });
    const stack = createGatewayStack(
      { canvas: { port: 0 } },
      { transport: makeTransport(), auth: makeAuth(), canvasAuth },
    );
    expect(stack.canvas).toBeDefined();
    const h = await stack.health();
    expect(h.components.canvas).toBe(true);
    await stack.stop();
  });

  test("canvas stays disabled when canvasAuth missing even if config.canvas set", async () => {
    const stack = createGatewayStack(
      { canvas: { port: 0 } },
      { transport: makeTransport(), auth: makeAuth() },
    );
    expect(stack.canvas).toBeUndefined();
    const h = await stack.health();
    expect(h.components.canvas).toBe(false);
    await stack.stop();
  });

  test("honors caller-supplied deps.store when no nexusTransport (round-6 fix 2)", async () => {
    // Custom persistent SessionStore must NOT be silently dropped when the
    // caller wires it via deps.store with no nexusTransport. (Previously
    // the stack silently used the in-memory default in this case.)
    const calls: string[] = [];
    const customStore: import("@koi/gateway").SessionStore = {
      get: (id) => {
        calls.push(`get:${id}`);
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: "x", retryable: RETRYABLE_DEFAULTS.NOT_FOUND },
        };
      },
      set: () => {
        calls.push("set");
        return { ok: true, value: undefined };
      },
      delete: () => {
        calls.push("delete");
        return { ok: true, value: true };
      },
      has: () => ({ ok: true, value: false }),
      size: () => 0,
      entries: () => [][Symbol.iterator]() as IterableIterator<readonly [string, never]>,
    };
    const stack = createGatewayStack(
      {},
      { transport: makeTransport(), auth: makeAuth(), store: customStore },
    );
    await stack.start(0);
    // sessions() returns the wired store, so calling .get on it must hit the custom store.
    stack.gateway.sessions().get("anything");
    await stack.stop();
    expect(calls.some((c) => c.startsWith("get:"))).toBe(true);
  });

  test("rejects ambiguous deps.store + deps.nexusTransport combo", () => {
    expect(() =>
      createGatewayStack(
        {},
        {
          transport: makeTransport(),
          auth: makeAuth(),
          nexusTransport: makeNexusTransport("ok"),
          // biome-ignore lint/suspicious/noExplicitAny: minimal stub for negative test
          store: {} as any,
        },
      ),
    ).toThrow(/mutually exclusive/i);
  });

  test("nexus-backed stop does NOT issue delete calls (HA records preserved)", async () => {
    const calls: string[] = [];
    const nexusTransport: NexusTransport = {
      kind: "http",
      call: async <T>(method: string): Promise<Result<T, KoiError>> => {
        calls.push(method);
        return { ok: true, value: undefined as T };
      },
      close: () => {},
    };
    const stack = createGatewayStack(
      { nexus: { instanceId: "gw-preserve" } },
      { transport: makeTransport(), auth: makeAuth(), nexusTransport },
    );
    await stack.start(0);
    await stack.stop();
    // A SIGTERM/rolling restart must not erase Nexus session records meant for
    // reconnect. The stack wires preserveSessionsOnStop=true on the gateway
    // when a Nexus session store is present.
    expect(calls.includes("delete")).toBe(false);
  });

  test("webhook wires (uses default no-op dispatcher when none injected)", async () => {
    const stack = createGatewayStack(
      {
        webhook: {
          port: 0,
          pathPrefix: "/webhook",
          allowUnauthenticated: true,
        },
      },
      { transport: makeTransport(), auth: makeAuth() },
    );
    expect(stack.webhook).toBeDefined();
    const h = await stack.health();
    expect(h.components.webhook).toBe(true);
    await stack.stop();
  });
});
