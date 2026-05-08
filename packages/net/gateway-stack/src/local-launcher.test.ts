import { describe, expect, test } from "bun:test";
import {
  createLocalGatewayLauncher,
  type LocalGatewayLauncherInternals,
} from "./local-launcher.js";

interface TestHarness {
  readonly internals: LocalGatewayLauncherInternals;
  readonly serveCalls: Array<{ readonly hostname: string; readonly port: number }>;
  readonly stackStartCalls: number[];
  readonly stackStopSignals: string[];
  readonly transportCloseCalls: () => number;
  readonly nexusCloseCalls: string[];
  readonly fetchHealth: () => Promise<Response>;
  readonly resolveStart: () => void;
  readonly createHttpTransportCalls: Array<{ readonly apiKey: string; readonly url: string }>;
  readonly authenticate: (frame: unknown) => Promise<unknown>;
}

interface HarnessOptions {
  readonly deferStart?: boolean;
  readonly serveThrows?: Error;
}

function makeHarness(opts: HarnessOptions = {}): TestHarness {
  const serveCalls: TestHarness["serveCalls"] = [];
  const stackStartCalls: number[] = [];
  const stackStopSignals: string[] = [];
  const nexusCloseCalls: string[] = [];
  const createHttpTransportCalls: TestHarness["createHttpTransportCalls"] = [];
  let transportCloses = 0;
  let serveFetch: ((req: Request) => Response | Promise<Response>) | undefined;
  let resolveStart: () => void = () => {};
  const startGate = opts.deferStart
    ? new Promise<void>((resolve) => {
        resolveStart = resolve;
      })
    : Promise.resolve();
  let authFn: (frame: unknown) => Promise<unknown> = async () => ({ ok: false });

  const stack = {
    healthHandler: async () =>
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    start: async (port: number) => {
      stackStartCalls.push(port);
      await startGate;
    },
    stop: async () => {
      stackStopSignals.push("stop");
    },
  };

  const transport = {
    port: () => 19500,
    close: () => {
      transportCloses += 1;
    },
  };

  const nexusTransport = {
    close: () => {
      nexusCloseCalls.push("close");
    },
  };

  const internals = {
    createBunTransport: (() => transport) as LocalGatewayLauncherInternals["createBunTransport"],
    createHttpTransport: (({ apiKey, url }: { readonly apiKey: string; readonly url: string }) => {
      createHttpTransportCalls.push({ apiKey, url });
      return nexusTransport;
    }) as LocalGatewayLauncherInternals["createHttpTransport"],
    createGatewayStack: ((
      _config: unknown,
      deps: { readonly auth: { readonly authenticate: (f: unknown) => Promise<unknown> } },
    ) => {
      authFn = deps.auth.authenticate;
      return stack;
    }) as unknown as LocalGatewayLauncherInternals["createGatewayStack"],
    serve: (({
      hostname,
      port,
      fetch,
    }: {
      readonly hostname?: string;
      readonly port: number;
      readonly fetch: (req: Request) => Response | Promise<Response>;
    }) => {
      serveCalls.push({ hostname: hostname ?? "127.0.0.1", port });
      if (opts.serveThrows !== undefined) {
        throw opts.serveThrows;
      }
      serveFetch = fetch;
      return {
        port,
        stop: () => {
          stackStopSignals.push("health-stop");
        },
      };
    }) as unknown as LocalGatewayLauncherInternals["serve"],
  } satisfies LocalGatewayLauncherInternals;

  return {
    internals,
    serveCalls,
    stackStartCalls,
    stackStopSignals,
    nexusCloseCalls,
    createHttpTransportCalls,
    transportCloseCalls: () => transportCloses,
    fetchHealth: async () => {
      if (serveFetch === undefined) throw new Error("serve not invoked");
      return await serveFetch(new Request("http://127.0.0.1/health"));
    },
    resolveStart: () => resolveStart(),
    authenticate: (frame) => authFn(frame),
  };
}

describe("createLocalGatewayLauncher", () => {
  test("rejects nexusUrl without nexusApiKey", async () => {
    const h = makeHarness();
    await expect(
      createLocalGatewayLauncher(h.internals).start({
        port: 19500,
        nexusUrl: "http://127.0.0.1:4515",
      }),
    ).rejects.toThrow(/NEXUS_API_KEY/i);
  });

  test("rejects nexusApiKey without nexusUrl", async () => {
    const h = makeHarness();
    await expect(
      createLocalGatewayLauncher(h.internals).start({
        port: 19500,
        nexusApiKey: "secret",
      }),
    ).rejects.toThrow(/NEXUS_URL/i);
  });

  test("returns ws + health addresses for loopback startup and supports stop", async () => {
    const h = makeHarness();
    const handle = await createLocalGatewayLauncher(h.internals).start({
      port: 19500,
      nexusUrl: "http://127.0.0.1:4515",
      nexusApiKey: "secret",
    });

    expect(handle.started).toEqual({
      kind: "gateway_up_started",
      instanceId: `gw-${process.pid}`,
      ws: "ws://127.0.0.1:19500",
      health: "http://127.0.0.1:19501/health",
      nexus: "http://127.0.0.1:4515",
    });
    expect(h.stackStartCalls).toEqual([19500]);
    expect(h.serveCalls).toEqual([{ hostname: "127.0.0.1", port: 19501 }]);
    expect(h.createHttpTransportCalls).toEqual([
      { apiKey: "secret", url: "http://127.0.0.1:4515" },
    ]);
    await expect(h.authenticate({ client: { id: "agent-a" } })).resolves.toEqual({
      ok: true,
      sessionId: "sess-6167656e742d61",
      agentId: "agent-a",
      metadata: { unsafeDevAuth: true },
    });

    await expect(handle.stop("test")).resolves.toEqual({
      kind: "gateway_up_stopped",
      signal: "test",
    });
    expect(h.stackStopSignals).toEqual(["health-stop", "stop"]);
    expect(h.nexusCloseCalls).toEqual(["close"]);
  });

  test("rejects port 65535 (health server reserves port+1)", async () => {
    const h = makeHarness();
    await expect(createLocalGatewayLauncher(h.internals).start({ port: 65535 })).rejects.toThrow(
      /65534/,
    );
  });

  test("rejects port 0", async () => {
    const h = makeHarness();
    await expect(createLocalGatewayLauncher(h.internals).start({ port: 0 })).rejects.toThrow(
      /integer/,
    );
  });

  test("/health returns 503 starting JSON before stack.start resolves", async () => {
    const h = makeHarness({ deferStart: true });
    const startPromise = createLocalGatewayLauncher(h.internals).start({ port: 19500 });
    await new Promise<void>((r) => setTimeout(r, 0));

    const res = await h.fetchHealth();
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ status: "starting" });

    h.resolveStart();
    await startPromise;

    const after = await h.fetchHealth();
    expect(after.status).toBe(200);
  });

  test("rolls back gateway transport when health-server bind fails", async () => {
    const bindError = new Error("EADDRINUSE: 19501 in use");
    const h = makeHarness({ serveThrows: bindError });

    await expect(
      createLocalGatewayLauncher(h.internals).start({
        port: 19500,
        nexusUrl: "http://127.0.0.1:4515",
        nexusApiKey: "secret",
      }),
    ).rejects.toBe(bindError);

    expect(h.stackStartCalls).toEqual([]);
    expect(h.stackStopSignals).toContain("stop");
    expect(h.transportCloseCalls()).toBe(1);
    expect(h.nexusCloseCalls).toEqual(["close"]);
  });
});
