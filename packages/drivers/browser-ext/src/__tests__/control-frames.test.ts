import { describe, expect, test } from "bun:test";

import {
  createWatchdog,
  NmControlFrameSchema,
  negotiateProtocol,
} from "../native-host/control-frames.js";

describe("NmControlFrameSchema", () => {
  test("accepts extension_hello", () => {
    const frame = {
      kind: "extension_hello",
      extensionId: "abcdefghijklmnop",
      extensionVersion: "0.1.0",
      installId: "a".repeat(64),
      browserSessionId: "sess-1",
      supportedProtocols: [1],
    };
    expect(NmControlFrameSchema.safeParse(frame).success).toBe(true);
  });

  test("accepts extension_hello with null installId (first-boot)", () => {
    const frame = {
      kind: "extension_hello",
      extensionId: "x",
      extensionVersion: "0.1.0",
      installId: null,
      browserSessionId: "sess-1",
      supportedProtocols: [1],
    };
    expect(NmControlFrameSchema.safeParse(frame).success).toBe(true);
  });

  test("accepts host_hello + ping + pong", () => {
    expect(
      NmControlFrameSchema.safeParse({
        kind: "host_hello",
        hostVersion: "0.1.0",
        installId: "a".repeat(64),
        selectedProtocol: 1,
      }).success,
    ).toBe(true);
    expect(NmControlFrameSchema.safeParse({ kind: "ping", seq: 1 }).success).toBe(true);
    expect(NmControlFrameSchema.safeParse({ kind: "pong", seq: 1 }).success).toBe(true);
  });

  test("rejects malformed installId", () => {
    const frame = {
      kind: "host_hello",
      hostVersion: "0.1.0",
      installId: "not-hex",
      selectedProtocol: 1,
    };
    expect(NmControlFrameSchema.safeParse(frame).success).toBe(false);
  });
});

describe("negotiateProtocol", () => {
  test("both [1] → selectedProtocol: 1", () => {
    expect(negotiateProtocol([1], [1])).toEqual({ ok: true, selectedProtocol: 1 });
  });

  test("host [1] vs ext [2] → ok: false", () => {
    expect(negotiateProtocol([2], [1])).toEqual({ ok: false });
  });

  test("picks highest shared version", () => {
    expect(negotiateProtocol([1, 2, 3], [2, 3])).toEqual({ ok: true, selectedProtocol: 3 });
  });

  test("empty intersection → failure", () => {
    expect(negotiateProtocol([1], [2])).toEqual({ ok: false });
  });
});

describe("createWatchdog", () => {
  test("sends pings every interval via setTimer", () => {
    const sent: { kind: "ping"; seq: number }[] = [];
    const timers: (() => void)[] = [];
    const wd = createWatchdog({
      intervalMs: 5000,
      maxMisses: 3,
      send: (f) => sent.push(f),
      onExpire: () => {},
      setTimer: (fn) => {
        timers.push(fn);
        return { unref: () => {}, close: () => {} };
      },
      clearTimer: () => {},
    });
    wd.start();
    timers[0]?.();
    timers[0]?.();
    expect(sent).toEqual([
      { kind: "ping", seq: 0 },
      { kind: "ping", seq: 1 },
    ]);
    // second tick: pong for seq 0 NOT received; miss counter increments
  });

  test("onPong resets miss counter", () => {
    const sent: { kind: "ping"; seq: number }[] = [];
    let expired = false;
    const timers: (() => void)[] = [];
    const wd = createWatchdog({
      intervalMs: 5000,
      maxMisses: 3,
      send: (f) => sent.push(f),
      onExpire: () => {
        expired = true;
      },
      setTimer: (fn) => {
        timers.push(fn);
        return {};
      },
      clearTimer: () => {},
    });
    wd.start();
    timers[0]?.(); // send ping seq=0
    wd.onPong(0);
    timers[0]?.(); // miss counter reset; send seq=1
    expect(sent.length).toBe(2);
    expect(expired).toBe(false);
  });

  test("expires after maxMisses ticks without pong", () => {
    let expired = false;
    const timers: (() => void)[] = [];
    const wd = createWatchdog({
      intervalMs: 5000,
      maxMisses: 3,
      send: () => {},
      onExpire: () => {
        expired = true;
      },
      setTimer: (fn) => {
        timers.push(fn);
        return {};
      },
      clearTimer: () => {},
    });
    wd.start();
    timers[0]?.(); // seq 0 sent
    timers[0]?.(); // miss 1
    timers[0]?.(); // miss 2
    timers[0]?.(); // miss 3 → expire
    expect(expired).toBe(true);
  });
});
