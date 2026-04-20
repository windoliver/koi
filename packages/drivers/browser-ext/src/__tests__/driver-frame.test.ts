import { describe, expect, test } from "bun:test";

import {
  DriverFrameSchema,
  isDriverOriginated,
  isHostOriginated,
} from "../native-host/driver-frame.js";

describe("DriverFrameSchema — happy paths", () => {
  test.each([
    [
      "hello",
      {
        kind: "hello",
        token: "a".repeat(64),
        driverVersion: "0.1.0",
        supportedProtocols: [1],
        leaseToken: "f".repeat(32),
      },
    ],
    [
      "hello with admin",
      {
        kind: "hello",
        token: "a".repeat(64),
        driverVersion: "0.1.0",
        supportedProtocols: [1],
        leaseToken: "f".repeat(32),
        admin: { adminKey: "b".repeat(64) },
      },
    ],
    ["list_tabs", { kind: "list_tabs" }],
    [
      "attach (no reattach)",
      {
        kind: "attach",
        tabId: 42,
        leaseToken: "f".repeat(32),
        attachRequestId: "11111111-1111-4111-8111-111111111111",
      },
    ],
    [
      "attach (reattach enum)",
      {
        kind: "attach",
        tabId: 42,
        leaseToken: "f".repeat(32),
        attachRequestId: "11111111-1111-4111-8111-111111111111",
        reattach: "consent_required_if_missing",
      },
    ],
    ["detach", { kind: "detach", sessionId: "22222222-2222-4222-8222-222222222222" }],
    [
      "cdp",
      {
        kind: "cdp",
        sessionId: "22222222-2222-4222-8222-222222222222",
        method: "Page.navigate",
        params: { url: "https://example.com" },
        id: 1,
      },
    ],
    [
      "chunk",
      {
        kind: "chunk",
        sessionId: "22222222-2222-4222-8222-222222222222",
        correlationId: "r:7",
        payloadKind: "result_value",
        index: 0,
        total: 3,
        data: "aGVsbG8=",
      },
    ],
    ["bye", { kind: "bye" }],
  ] as const)("accepts valid %s frame", (_name, frame) => {
    const result = DriverFrameSchema.safeParse(frame);
    expect(result.success).toBe(true);
  });
});

describe("DriverFrameSchema — direction enforcement", () => {
  test("rejects NM-only frame types on driver channel", () => {
    const nmOnly = [
      { kind: "abandon_attach", leaseToken: "f".repeat(32) },
      { kind: "abandon_attach_ack", leaseToken: "f".repeat(32), affectedTabs: [42] },
      {
        kind: "detached",
        sessionId: "22222222-2222-4222-8222-222222222222",
        tabId: 42,
        reason: "private_origin",
      },
      { kind: "admin_clear_grants", scope: "all" },
      { kind: "admin_clear_grants_ack", clearedOrigins: [], detachedTabs: [] },
      { kind: "attach_state_probe", requestId: "rr" },
      { kind: "attach_state_probe_ack", requestId: "rr", attachedTabs: [] },
    ];
    for (const frame of nmOnly) {
      const result = DriverFrameSchema.safeParse(frame);
      expect(result.success).toBe(false);
    }
  });

  test("rejects bad reattach enum value", () => {
    const bad = {
      kind: "attach",
      tabId: 42,
      leaseToken: "f".repeat(32),
      attachRequestId: "11111111-1111-4111-8111-111111111111",
      reattach: "true",
    };
    expect(DriverFrameSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects non-UUID sessionId", () => {
    const bad = {
      kind: "cdp",
      sessionId: "not-a-uuid",
      method: "Page.navigate",
      params: {},
      id: 1,
    };
    expect(DriverFrameSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects short leaseToken", () => {
    const bad = {
      kind: "attach",
      tabId: 42,
      leaseToken: "ff",
      attachRequestId: "11111111-1111-4111-8111-111111111111",
    };
    expect(DriverFrameSchema.safeParse(bad).success).toBe(false);
  });
});

describe("isDriverOriginated / isHostOriginated", () => {
  test("hello is driver-originated", () => {
    expect(isDriverOriginated({ kind: "hello" } as never)).toBe(true);
    expect(isHostOriginated({ kind: "hello" } as never)).toBe(false);
  });
  test("hello_ack is host-originated", () => {
    expect(isHostOriginated({ kind: "hello_ack" } as never)).toBe(true);
    expect(isDriverOriginated({ kind: "hello_ack" } as never)).toBe(false);
  });
  test("cdp is driver-originated, cdp_result is host-originated", () => {
    expect(isDriverOriginated({ kind: "cdp" } as never)).toBe(true);
    expect(isHostOriginated({ kind: "cdp_result" } as never)).toBe(true);
  });
  test("session_ended is host-originated only (host → driver)", () => {
    expect(isHostOriginated({ kind: "session_ended" } as never)).toBe(true);
    expect(isDriverOriginated({ kind: "session_ended" } as never)).toBe(false);
  });
});
