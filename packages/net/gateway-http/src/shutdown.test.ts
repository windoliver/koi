import { describe, expect, mock, test } from "bun:test";
import type { Gateway, GatewayFrame, Session } from "@koi/gateway-types";
import { createShutdownController, type ShutdownDeps } from "./shutdown.js";

interface FakeClock {
  readonly now: () => number;
  readonly advance: (ms: number) => void;
}

function makeClock(start = 0): FakeClock {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

interface FakeGateway {
  readonly gateway: Gateway;
  readonly pauseCalls: () => number;
  readonly forceCalls: () => number;
  readonly setActiveConnections: (n: number) => void;
}

function makeGateway(opts: { activeConnections?: number } = {}): FakeGateway {
  let pauseCalls = 0;
  let forceCalls = 0;
  let active = opts.activeConnections ?? 0;
  const gateway: Gateway = {
    ingest: (_s: Session, _f: GatewayFrame) => undefined,
    pauseIngress: () => {
      pauseCalls += 1;
    },
    forceClose: () => {
      forceCalls += 1;
    },
    activeConnections: () => active,
  };
  return {
    gateway,
    pauseCalls: () => pauseCalls,
    forceCalls: () => forceCalls,
    setActiveConnections: (n: number) => {
      active = n;
    },
  };
}

function buildDeps(overrides: Partial<ShutdownDeps>): ShutdownDeps {
  const fg = overrides.gateway ? undefined : makeGateway();
  const clock = overrides.clock ?? makeClock().now;
  const stopListener = overrides.stopListener ?? mock(() => {});
  return {
    gateway: overrides.gateway ?? (fg as FakeGateway).gateway,
    getInFlight: overrides.getInFlight ?? (() => 0),
    graceMs: overrides.graceMs ?? 1000,
    clock,
    pollIntervalMs: overrides.pollIntervalMs ?? 1,
    stopListener,
  };
}

describe("createShutdownController", () => {
  test("immediate drain resolves with state=closed", async () => {
    const fg = makeGateway();
    const stopListener = mock((_force: boolean) => {});
    const ctrl = createShutdownController(
      buildDeps({
        gateway: fg.gateway,
        getInFlight: () => 0,
        stopListener,
      }),
    );

    expect(ctrl.state()).toBe("running");
    expect(ctrl.isDraining()).toBe(false);

    await ctrl.start();

    expect(ctrl.state()).toBe("closed");
    expect(fg.pauseCalls()).toBe(1);
    expect(fg.forceCalls()).toBe(0);
    expect(stopListener).toHaveBeenCalledTimes(1);
    expect(stopListener).toHaveBeenCalledWith(true);
  });

  test("HTTP drain waits until in-flight reaches 0", async () => {
    const fg = makeGateway();
    let inFlight = 3;
    const ctrl = createShutdownController(
      buildDeps({
        gateway: fg.gateway,
        getInFlight: () => inFlight,
        graceMs: 5000,
        pollIntervalMs: 1,
      }),
    );

    const done = ctrl.start();
    // give it a few event-loop ticks; should still be draining-http
    await Bun.sleep(5);
    expect(ctrl.state()).toBe("draining-http");

    inFlight = 1;
    await Bun.sleep(5);
    expect(ctrl.state()).toBe("draining-http");

    inFlight = 0;
    await done;
    expect(ctrl.state()).toBe("closed");
  });

  test("WS drain waits until activeConnections reaches 0", async () => {
    const fg = makeGateway({ activeConnections: 5 });
    const ctrl = createShutdownController(
      buildDeps({
        gateway: fg.gateway,
        getInFlight: () => 0,
        graceMs: 5000,
        pollIntervalMs: 1,
      }),
    );

    const done = ctrl.start();
    await Bun.sleep(5);
    expect(ctrl.state()).toBe("draining-ws");

    fg.setActiveConnections(0);
    await done;
    expect(ctrl.state()).toBe("closed");
    expect(fg.forceCalls()).toBe(0);
  });

  test("grace expiry triggers force-close", async () => {
    const fg = makeGateway({ activeConnections: 2 });
    const clock = makeClock();
    const stopListener = mock((_force: boolean) => {});
    const ctrl = createShutdownController(
      buildDeps({
        gateway: fg.gateway,
        getInFlight: () => 1, // never drains
        graceMs: 50,
        clock: clock.now,
        pollIntervalMs: 1,
        stopListener,
      }),
    );

    const done = ctrl.start();
    // simulate clock moving past graceMs while polling
    const ticker = setInterval(() => clock.advance(20), 2);
    await done;
    clearInterval(ticker);

    expect(ctrl.state()).toBe("force-closed");
    expect(fg.forceCalls()).toBe(1);
    expect(stopListener).toHaveBeenCalledTimes(1);
    expect(stopListener).toHaveBeenCalledWith(true);
  });

  test("pauseIngress is called BEFORE waiting for HTTP drain", async () => {
    const fg = makeGateway();
    const order: string[] = [];
    const wrappedGateway: Gateway = {
      ingest: fg.gateway.ingest,
      pauseIngress: () => {
        order.push("pauseIngress");
      },
      forceClose: fg.gateway.forceClose,
      activeConnections: fg.gateway.activeConnections,
    };

    let inFlight = 2;
    const ctrl = createShutdownController(
      buildDeps({
        gateway: wrappedGateway,
        getInFlight: () => {
          order.push(`getInFlight=${inFlight}`);
          return inFlight;
        },
        graceMs: 5000,
        pollIntervalMs: 1,
      }),
    );

    const done = ctrl.start();
    await Bun.sleep(5);
    inFlight = 0;
    await done;

    // pauseIngress must come before any getInFlight call
    const firstPause = order.indexOf("pauseIngress");
    const firstGetInFlight = order.findIndex((s) => s.startsWith("getInFlight"));
    expect(firstPause).toBeGreaterThanOrEqual(0);
    expect(firstGetInFlight).toBeGreaterThan(firstPause);
  });

  test("idempotent: calling start() twice returns same promise", async () => {
    const fg = makeGateway();
    const stopListener = mock((_force: boolean) => {});
    const ctrl = createShutdownController(
      buildDeps({
        gateway: fg.gateway,
        getInFlight: () => 0,
        stopListener,
      }),
    );

    const p1 = ctrl.start();
    const p2 = ctrl.start();
    expect(p1).toBe(p2);
    await p1;

    // call again after completion — should still return same promise
    const p3 = ctrl.start();
    await p3;

    expect(fg.pauseCalls()).toBe(1);
    expect(fg.forceCalls()).toBe(0);
    expect(stopListener).toHaveBeenCalledTimes(1);
  });

  test("isDraining flips synchronously when start() is invoked", () => {
    const fg = makeGateway();
    const ctrl = createShutdownController(
      buildDeps({
        gateway: fg.gateway,
        getInFlight: () => 0,
      }),
    );

    expect(ctrl.isDraining()).toBe(false);
    const p = ctrl.start();
    expect(ctrl.isDraining()).toBe(true);
    return p;
  });
});
