import { describe, expect, test } from "bun:test";
import type { AgentStatus } from "@koi/core";
import {
  decodeKoiStatus,
  encodeKoiStatus,
  KOI_STATUS_KEY,
  KOI_TERMINATED_KEY,
  mapKoiToNexus,
  mapNexusToKoi,
} from "./state-mapping.js";

describe("mapKoiToNexus", () => {
  test("created and running map to CONNECTED", () => {
    expect(mapKoiToNexus("created")).toBe("CONNECTED");
    expect(mapKoiToNexus("running")).toBe("CONNECTED");
  });

  test("waiting and idle map to IDLE", () => {
    expect(mapKoiToNexus("waiting")).toBe("IDLE");
    expect(mapKoiToNexus("idle")).toBe("IDLE");
  });

  test("suspended and terminated map to SUSPENDED", () => {
    expect(mapKoiToNexus("suspended")).toBe("SUSPENDED");
    expect(mapKoiToNexus("terminated")).toBe("SUSPENDED");
  });
});

describe("mapNexusToKoi", () => {
  test("UNKNOWN maps to created", () => {
    expect(mapNexusToKoi("UNKNOWN")).toBe("created");
  });

  test("CONNECTED maps to running", () => {
    expect(mapNexusToKoi("CONNECTED")).toBe("running");
  });

  test("IDLE maps to waiting", () => {
    expect(mapNexusToKoi("IDLE")).toBe("waiting");
  });

  test("SUSPENDED maps to suspended by default", () => {
    expect(mapNexusToKoi("SUSPENDED")).toBe("suspended");
  });

  test("SUSPENDED + koi:terminated maps to terminated", () => {
    expect(mapNexusToKoi("SUSPENDED", { [KOI_TERMINATED_KEY]: true })).toBe("terminated");
  });

  test("unknown state throws to fail closed on schema drift", () => {
    expect(() => mapNexusToKoi("ZZZ")).toThrow(/Unknown Nexus AgentState/);
  });
});

describe("encode/decode AgentStatus round-trip", () => {
  test("encodes status under koi:status key", () => {
    const status: AgentStatus = {
      phase: "running",
      generation: 5,
      conditions: ["Ready"],
      lastTransitionAt: 1_700_000_000_000,
    };
    const meta = encodeKoiStatus(status);
    expect(meta[KOI_STATUS_KEY]).toBeDefined();
    expect(decodeKoiStatus(meta)).toEqual(status);
  });

  test("encodes terminated flag separately", () => {
    const status: AgentStatus = {
      phase: "terminated",
      generation: 1,
      conditions: [],
      lastTransitionAt: 1_700_000_000_000,
    };
    const meta = encodeKoiStatus(status);
    expect(meta[KOI_TERMINATED_KEY]).toBe(true);
  });

  test("preserves transition reason", () => {
    const status: AgentStatus = {
      phase: "suspended",
      generation: 3,
      conditions: [],
      reason: { kind: "signal_stop" },
      lastTransitionAt: 1_700_000_000_000,
    };
    const meta = encodeKoiStatus(status);
    const decoded = decodeKoiStatus(meta);
    expect(decoded?.reason).toEqual({ kind: "signal_stop" });
  });

  test("returns undefined for malformed metadata", () => {
    expect(decodeKoiStatus({})).toBeUndefined();
    expect(decodeKoiStatus({ [KOI_STATUS_KEY]: "not-an-object" })).toBeUndefined();
    expect(decodeKoiStatus({ [KOI_STATUS_KEY]: { phase: "running" } })).toBeUndefined();
  });
});
