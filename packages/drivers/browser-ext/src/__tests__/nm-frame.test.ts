import { describe, expect, test } from "bun:test";

import {
  isExtensionOriginated,
  isHostOriginatedNm,
  NmFrameSchema,
} from "../native-host/nm-frame.js";

describe("NmFrameSchema — happy paths", () => {
  test.each([
    ["list_tabs", { kind: "list_tabs", requestId: "33333333-3333-4333-8333-333333333333" }],
    [
      "attach",
      {
        kind: "attach",
        tabId: 42,
        leaseToken: "f".repeat(32),
        attachRequestId: "11111111-1111-4111-8111-111111111111",
      },
    ],
    [
      "detach (with tabId)",
      {
        kind: "detach",
        sessionId: "22222222-2222-4222-8222-222222222222",
        tabId: 42,
      },
    ],
    [
      "detach_ack",
      {
        kind: "detach_ack",
        sessionId: "22222222-2222-4222-8222-222222222222",
        tabId: 42,
        ok: true,
      },
    ],
    ["abandon_attach", { kind: "abandon_attach", leaseToken: "f".repeat(32) }],
    [
      "abandon_attach_ack",
      { kind: "abandon_attach_ack", leaseToken: "f".repeat(32), affectedTabs: [42] },
    ],
    [
      "admin_clear_grants",
      {
        kind: "admin_clear_grants",
        requestId: "12345678-1234-4234-8234-123456789abc",
        scope: "all",
      },
    ],
    [
      "admin_clear_grants_ack",
      {
        kind: "admin_clear_grants_ack",
        requestId: "12345678-1234-4234-8234-123456789abc",
        clearedOrigins: ["https://example.com"],
        detachedTabs: [42],
      },
    ],
    ["attach_state_probe", { kind: "attach_state_probe", requestId: "probe-1" }],
    [
      "attach_state_probe_ack",
      { kind: "attach_state_probe_ack", requestId: "probe-1", attachedTabs: [42, 43] },
    ],
    [
      "detached (priorDetachSuccess)",
      {
        kind: "detached",
        sessionId: "22222222-2222-4222-8222-222222222222",
        tabId: 42,
        reason: "navigated_away",
        priorDetachSuccess: true,
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
  ] as const)("accepts valid %s frame", (_name, frame) => {
    const result = NmFrameSchema.safeParse(frame);
    expect(result.success).toBe(true);
  });
});

describe("NmFrameSchema — driver-only frames rejected", () => {
  test.each([
    {
      kind: "hello",
      token: "x".repeat(64),
      driverVersion: "0.1.0",
      supportedProtocols: [1],
      leaseToken: "f".repeat(32),
    },
    {
      kind: "hello_ack",
      ok: true,
      role: "driver",
      hostVersion: "0.1.0",
      extensionVersion: null,
      wsEndpoint: "ws://x",
      selectedProtocol: 1,
    },
    {
      kind: "session_ended",
      sessionId: "22222222-2222-4222-8222-222222222222",
      tabId: 42,
      reason: "navigated_away",
    },
    { kind: "bye" },
  ])("rejects driver-only frame %p", (frame) => {
    expect(NmFrameSchema.safeParse(frame).success).toBe(false);
  });
});

describe("direction predicates", () => {
  test("host originates attach/detach/abandon_attach/admin_clear_grants/attach_state_probe/cdp/list_tabs", () => {
    for (const kind of [
      "list_tabs",
      "attach",
      "detach",
      "abandon_attach",
      "admin_clear_grants",
      "attach_state_probe",
      "cdp",
    ] as const) {
      expect(isHostOriginatedNm({ kind } as never)).toBe(true);
      expect(isExtensionOriginated({ kind } as never)).toBe(false);
    }
  });
  test("extension originates tabs/attach_ack/detach_ack/detached/cdp_result/cdp_event/chunk", () => {
    for (const kind of [
      "tabs",
      "attach_ack",
      "detach_ack",
      "abandon_attach_ack",
      "admin_clear_grants_ack",
      "attach_state_probe_ack",
      "detached",
      "cdp_result",
      "cdp_error",
      "cdp_event",
      "chunk",
    ] as const) {
      expect(isExtensionOriginated({ kind } as never)).toBe(true);
      expect(isHostOriginatedNm({ kind } as never)).toBe(false);
    }
  });
});
