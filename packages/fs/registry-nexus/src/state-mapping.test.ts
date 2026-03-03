/**
 * Tests for Koi ↔ Nexus bidirectional state mapping.
 */

import { describe, expect, test } from "bun:test";
import type { AgentStatus, ProcessState } from "@koi/core";
import {
  decodeKoiStatus,
  encodeKoiStatus,
  KOI_STATUS_KEY,
  KOI_TERMINATED_KEY,
  mapKoiToNexus,
  mapNexusToKoi,
} from "./state-mapping.js";

// ---------------------------------------------------------------------------
// Koi → Nexus
// ---------------------------------------------------------------------------

describe("mapKoiToNexus", () => {
  test("created → CONNECTED", () => {
    expect(mapKoiToNexus("created")).toBe("CONNECTED");
  });

  test("running → CONNECTED", () => {
    expect(mapKoiToNexus("running")).toBe("CONNECTED");
  });

  test("waiting → IDLE", () => {
    expect(mapKoiToNexus("waiting")).toBe("IDLE");
  });

  test("suspended → SUSPENDED", () => {
    expect(mapKoiToNexus("suspended")).toBe("SUSPENDED");
  });

  test("terminated → SUSPENDED", () => {
    expect(mapKoiToNexus("terminated")).toBe("SUSPENDED");
  });
});

// ---------------------------------------------------------------------------
// Nexus → Koi
// ---------------------------------------------------------------------------

describe("mapNexusToKoi", () => {
  test("UNKNOWN → created", () => {
    expect(mapNexusToKoi("UNKNOWN")).toBe("created");
  });

  test("CONNECTED → running", () => {
    expect(mapNexusToKoi("CONNECTED")).toBe("running");
  });

  test("IDLE → waiting", () => {
    expect(mapNexusToKoi("IDLE")).toBe("waiting");
  });

  test("SUSPENDED → suspended", () => {
    expect(mapNexusToKoi("SUSPENDED")).toBe("suspended");
  });

  test("SUSPENDED with terminated metadata → terminated", () => {
    expect(mapNexusToKoi("SUSPENDED", { [KOI_TERMINATED_KEY]: true })).toBe("terminated");
  });

  test("SUSPENDED without terminated metadata → suspended", () => {
    expect(mapNexusToKoi("SUSPENDED", {})).toBe("suspended");
  });

  test("unknown Nexus state → created (fallback)", () => {
    expect(mapNexusToKoi("SOME_FUTURE_STATE")).toBe("created");
  });
});

// ---------------------------------------------------------------------------
// Round-trip: encode + decode
// ---------------------------------------------------------------------------

describe("encodeKoiStatus + decodeKoiStatus", () => {
  test("round-trip for running status", () => {
    const status: AgentStatus = {
      phase: "running",
      generation: 3,
      conditions: ["Ready", "Healthy"],
      lastTransitionAt: 1706140800000,
      reason: { kind: "assembly_complete" },
    };

    const metadata = encodeKoiStatus(status);
    const decoded = decodeKoiStatus(metadata);

    expect(decoded).toBeDefined();
    expect(decoded?.phase).toBe("running");
    expect(decoded?.generation).toBe(3);
    expect(decoded?.conditions).toEqual(["Ready", "Healthy"]);
    expect(decoded?.lastTransitionAt).toBe(1706140800000);
    expect(decoded?.reason).toEqual({ kind: "assembly_complete" });
  });

  test("round-trip for terminated status includes terminated flag", () => {
    const status: AgentStatus = {
      phase: "terminated",
      generation: 5,
      conditions: [],
      lastTransitionAt: 1706140800000,
      reason: { kind: "completed" },
    };

    const metadata = encodeKoiStatus(status);

    // Check terminated flag is set
    expect(metadata[KOI_TERMINATED_KEY]).toBe(true);

    const decoded = decodeKoiStatus(metadata);
    expect(decoded?.phase).toBe("terminated");
  });

  test("round-trip for created status without reason", () => {
    const status: AgentStatus = {
      phase: "created",
      generation: 0,
      conditions: [],
      lastTransitionAt: 1706140800000,
    };

    const metadata = encodeKoiStatus(status);
    const decoded = decodeKoiStatus(metadata);

    expect(decoded).toBeDefined();
    expect(decoded?.phase).toBe("created");
    expect(decoded?.generation).toBe(0);
    expect(decoded?.reason).toBeUndefined();
  });

  test("non-terminated status does not set terminated flag", () => {
    const status: AgentStatus = {
      phase: "running",
      generation: 1,
      conditions: [],
      lastTransitionAt: Date.now(),
    };

    const metadata = encodeKoiStatus(status);
    expect(metadata[KOI_TERMINATED_KEY]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// decodeKoiStatus edge cases
// ---------------------------------------------------------------------------

describe("decodeKoiStatus edge cases", () => {
  test("returns undefined for missing koi:status key", () => {
    expect(decodeKoiStatus({})).toBeUndefined();
  });

  test("returns undefined for non-object koi:status", () => {
    expect(decodeKoiStatus({ [KOI_STATUS_KEY]: "invalid" })).toBeUndefined();
  });

  test("returns undefined for null koi:status", () => {
    expect(decodeKoiStatus({ [KOI_STATUS_KEY]: null })).toBeUndefined();
  });

  test("returns undefined for missing phase", () => {
    expect(
      decodeKoiStatus({
        [KOI_STATUS_KEY]: { generation: 0, conditions: [], lastTransitionAt: 0 },
      }),
    ).toBeUndefined();
  });

  test("returns undefined for non-number generation", () => {
    expect(
      decodeKoiStatus({
        [KOI_STATUS_KEY]: {
          phase: "running",
          generation: "1",
          conditions: [],
          lastTransitionAt: 0,
        },
      }),
    ).toBeUndefined();
  });

  test("returns undefined for non-array conditions", () => {
    expect(
      decodeKoiStatus({
        [KOI_STATUS_KEY]: {
          phase: "running",
          generation: 1,
          conditions: "Ready",
          lastTransitionAt: 0,
        },
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// All ProcessState round-trips
// ---------------------------------------------------------------------------

describe("all ProcessState round-trips", () => {
  const states: readonly ProcessState[] = [
    "created",
    "running",
    "waiting",
    "suspended",
    "terminated",
  ];

  for (const phase of states) {
    test(`round-trip for ${phase}`, () => {
      const status: AgentStatus = {
        phase,
        generation: 1,
        conditions: [],
        lastTransitionAt: Date.now(),
      };

      const metadata = encodeKoiStatus(status);
      const decoded = decodeKoiStatus(metadata);

      expect(decoded?.phase).toBe(phase);
    });
  }
});
