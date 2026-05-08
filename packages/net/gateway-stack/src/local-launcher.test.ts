import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

interface MockStack {
  readonly healthHandler: (req: Request) => Promise<Response>;
  readonly start: (port: number) => Promise<void>;
  readonly stop: () => Promise<void>;
}

interface MockDeps {
  readonly createGatewayStackCalls: Array<{
    readonly config: unknown;
    readonly deps: {
      readonly auth: { readonly authenticate: (frame: unknown) => Promise<unknown> };
    };
  }>;
  readonly createHttpTransportCalls: Array<{ readonly apiKey: string; readonly url: string }>;
  readonly serveCalls: Array<{ readonly hostname: string; readonly port: number }>;
  readonly transportCloseCalls: string[];
  readonly stackStartCalls: number[];
  readonly stackStopSignals: string[];
}

function setupMocks() {
  const createGatewayStackCalls: MockDeps["createGatewayStackCalls"] = [];
  const createHttpTransportCalls: MockDeps["createHttpTransportCalls"] = [];
  const serveCalls: MockDeps["serveCalls"] = [];
  const transportCloseCalls: string[] = [];
  const stackStartCalls: number[] = [];
  const stackStopSignals: string[] = [];

  const stack: MockStack = {
    healthHandler: async () =>
      new Response(JSON.stringify({ status: "ok" }), {
        headers: { "content-type": "application/json" },
      }),
    start: async (port) => {
      stackStartCalls.push(port);
    },
    stop: async () => {
      stackStopSignals.push("stop");
    },
  };

  const transport = {
    port: () => 19500,
  };

  const nexusTransport = {
    close: () => {
      transportCloseCalls.push("close");
    },
  };

  const originalServe = Bun.serve;

  mock.module("@koi/gateway", () => ({
    createBunTransport: () => transport,
  }));
  mock.module("@koi/nexus-client", () => ({
    createHttpTransport: ({ apiKey, url }: { readonly apiKey: string; readonly url: string }) => {
      createHttpTransportCalls.push({ apiKey, url });
      return nexusTransport;
    },
  }));
  mock.module("./create-gateway-stack.js", () => ({
    createGatewayStack: (
      config: unknown,
      deps: { readonly auth: { readonly authenticate: (frame: unknown) => Promise<unknown> } },
    ) => {
      createGatewayStackCalls.push({ config, deps });
      return stack;
    },
  }));

  Bun.serve = (({ hostname, port }: { readonly hostname?: string; readonly port: number }) => {
    serveCalls.push({ hostname: hostname ?? "127.0.0.1", port });
    return {
      port,
      stop: () => {
        stackStopSignals.push("health-stop");
      },
    };
  }) as unknown as typeof Bun.serve;

  return {
    deps: {
      createGatewayStackCalls,
      createHttpTransportCalls,
      serveCalls,
      stackStartCalls,
      stackStopSignals,
      transportCloseCalls,
    } satisfies MockDeps,
    restore: () => {
      mock.restore();
      Bun.serve = originalServe;
    },
  };
}

describe("createLocalGatewayLauncher", () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
  });

  test("rejects nexusUrl without nexusApiKey", async () => {
    const { restore } = setupMocks();
    const { createLocalGatewayLauncher } = await import("./local-launcher.js");
    const launcher = createLocalGatewayLauncher();

    await expect(
      launcher.start({
        port: 19500,
        hostname: "127.0.0.1",
        nexusUrl: "http://127.0.0.1:4515",
      }),
    ).rejects.toThrow(/NEXUS_API_KEY/i);

    restore();
  });

  test("rejects nexusApiKey without nexusUrl", async () => {
    const { restore } = setupMocks();
    const { createLocalGatewayLauncher } = await import("./local-launcher.js");
    const launcher = createLocalGatewayLauncher();

    await expect(
      launcher.start({
        port: 19500,
        nexusApiKey: "secret",
      }),
    ).rejects.toThrow(/NEXUS_URL/i);

    restore();
  });

  test("returns ws + health addresses for loopback startup and supports stop", async () => {
    const { deps, restore } = setupMocks();
    const { createLocalGatewayLauncher } = await import("./local-launcher.js");
    const launcher = createLocalGatewayLauncher();

    const started = await launcher.start({
      port: 19500,
      nexusUrl: "http://127.0.0.1:4515",
      nexusApiKey: "secret",
    });

    expect(started.started).toEqual({
      kind: "gateway_up_started",
      instanceId: `gw-${process.pid}`,
      ws: "ws://127.0.0.1:19500",
      health: "http://127.0.0.1:19501/health",
      nexus: "http://127.0.0.1:4515",
    });
    expect(deps.stackStartCalls).toEqual([19500]);
    expect(deps.serveCalls).toEqual([{ hostname: "127.0.0.1", port: 19501 }]);
    expect(deps.createHttpTransportCalls).toEqual([
      { apiKey: "secret", url: "http://127.0.0.1:4515" },
    ]);
    await expect(
      deps.createGatewayStackCalls[0]?.deps.auth.authenticate({
        client: { id: "agent-a" },
      }),
    ).resolves.toEqual({
      ok: true,
      sessionId: "sess-6167656e742d61",
      agentId: "agent-a",
      metadata: { unsafeDevAuth: true },
    });

    await expect(started.stop("test")).resolves.toEqual({
      kind: "gateway_up_stopped",
      signal: "test",
    });
    expect(deps.stackStopSignals).toEqual(["health-stop", "stop"]);
    expect(deps.transportCloseCalls).toEqual(["close"]);

    restore();
  });
});
