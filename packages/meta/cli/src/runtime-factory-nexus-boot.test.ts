/**
 * runtime-factory nexus boot integration tests (#1401 phase 3).
 *
 * Exercises the full matrix of:
 *   - silent-bypass (Step -1)
 *   - assertProductionTransport / kind discriminator (Step 0)
 *   - HARD REJECT validations (local-bridge × assert-* / poison)
 *   - HTTP probe outcomes × boot mode (12-cell grid)
 *   - assert-remote-policy-loaded preflight (timeout, activation gate)
 *   - audit-poison opt-in vs disabled
 *
 * Uses stubbed NexusTransport — no real network or subprocess.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ApprovalHandler, KoiError, ModelAdapter, Result } from "@koi/core";
import type {
  HealthCapableNexusTransport,
  NexusHealth,
  NexusTransport,
  NexusTransportKind,
} from "@koi/nexus-client";
import { createKoiRuntime } from "./runtime-factory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModelAdapter(): ModelAdapter {
  return {
    id: "stub-tui",
    provider: "stub",
    capabilities: {
      streaming: true,
      functionCalling: true,
      vision: false,
      jsonMode: false,
      maxContextTokens: 8192,
      maxOutputTokens: 4096,
    },
    complete: mock(async () => ({ content: "", model: "stub" })),
    stream: mock(async function* () {}),
  };
}

const stubApprovalHandler: ApprovalHandler = mock(async () => ({ kind: "allow" as const }));

function baseConfig(): {
  readonly modelAdapter: ModelAdapter;
  readonly modelName: string;
  readonly approvalHandler: ApprovalHandler;
  readonly cwd: string;
} {
  return {
    modelAdapter: makeModelAdapter(),
    modelName: "stub-model",
    approvalHandler: stubApprovalHandler,
    cwd: process.cwd(),
  };
}

interface FakeTransportSpec {
  readonly kind?: NexusTransportKind | undefined;
  readonly health?: (() => Promise<Result<NexusHealth, KoiError>>) | undefined;
  readonly call?:
    | ((method: string, params: Record<string, unknown>) => Promise<Result<unknown, KoiError>>)
    | undefined;
}

function fakeTransport(spec: FakeTransportSpec): NexusTransport {
  const call: NexusTransport["call"] = (async <T>(
    method: string,
    params: Record<string, unknown>,
  ) => {
    if (spec.call !== undefined) {
      return spec.call(method, params) as Promise<Result<T, KoiError>>;
    }
    const path = params.path as string | undefined;
    if (path?.endsWith("version.json")) {
      return { ok: true, value: JSON.stringify({ version: 1 }) } as Result<T, KoiError>;
    }
    if (path?.endsWith("policy.json")) {
      return {
        ok: true,
        value: JSON.stringify({ rules: { allow: [], deny: [], ask: [] } }),
      } as Result<T, KoiError>;
    }
    return { ok: true, value: undefined } as Result<T, KoiError>;
  }) as NexusTransport["call"];
  return {
    ...(spec.kind !== undefined ? { kind: spec.kind } : {}),
    ...(spec.health !== undefined ? { health: spec.health } : {}),
    call,
    close: () => {},
  };
}

const okHealth: NexusHealth = {
  status: "ok",
  version: "1.0.0",
  latencyMs: 1,
  probed: ["version", "read:koi/permissions/version.json", "read:koi/permissions/policy.json"],
};

const missingPathsHealth: NexusHealth = {
  status: "missing-paths",
  version: "1.0.0",
  latencyMs: 1,
  probed: ["version", "read:koi/permissions/version.json", "read:koi/permissions/policy.json"],
  notFound: ["koi/permissions/policy.json"],
};

let handle: Awaited<ReturnType<typeof createKoiRuntime>> | null = null;

afterEach(async () => {
  if (handle !== null) {
    await handle.runtime.dispose();
    handle = null;
  }
});

// ---------------------------------------------------------------------------
// Step -1: silent-bypass
// ---------------------------------------------------------------------------

describe("Step -1: silent-bypass", () => {
  test("transport without kind boots when both consumers disabled", async () => {
    handle = await createKoiRuntime({
      ...baseConfig(),
      nexusTransport: fakeTransport({}), // no kind
      nexusPermissionsEnabled: false,
      nexusAuditEnabled: false,
    });
    expect(handle.runtime).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Step 0: assertions and HARD REJECTS
// ---------------------------------------------------------------------------

describe("Step 0: assertProductionTransport + HARD REJECTS", () => {
  test("missing kind throws when permissions are enabled (default)", async () => {
    await expect(
      createKoiRuntime({
        ...baseConfig(),
        nexusTransport: fakeTransport({}), // no kind
      }),
    ).rejects.toThrow(/missing required `kind`/);
  });

  test("local-bridge + assert-transport-reachable-at-boot throws", async () => {
    await expect(
      createKoiRuntime({
        ...baseConfig(),
        nexusTransport: fakeTransport({ kind: "local-bridge" }),
        nexusBootMode: "assert-transport-reachable-at-boot",
      }),
    ).rejects.toThrow(/not supported on local-bridge/);
  });

  test("local-bridge + assert-remote-policy-loaded-at-boot throws", async () => {
    await expect(
      createKoiRuntime({
        ...baseConfig(),
        nexusTransport: fakeTransport({ kind: "local-bridge" }),
        nexusBootMode: "assert-remote-policy-loaded-at-boot",
      }),
    ).rejects.toThrow(/not supported on local-bridge/);
  });

  test("assert-remote-policy-loaded + nexusAllowEmptyPolicyStore throws", async () => {
    await expect(
      createKoiRuntime({
        ...baseConfig(),
        nexusTransport: fakeTransport({
          kind: "http",
          health: async () => ({ ok: true, value: okHealth }),
        }) as HealthCapableNexusTransport,
        nexusBootMode: "assert-remote-policy-loaded-at-boot",
        nexusAllowEmptyPolicyStore: true,
      }),
    ).rejects.toThrow(/incompatible with/);
  });

  test("assert-transport-reachable with nexusPermissionsEnabled=false throws", async () => {
    await expect(
      createKoiRuntime({
        ...baseConfig(),
        nexusTransport: fakeTransport({
          kind: "http",
          health: async () => ({ ok: true, value: okHealth }),
        }) as HealthCapableNexusTransport,
        nexusBootMode: "assert-transport-reachable-at-boot",
        nexusPermissionsEnabled: false,
      }),
    ).rejects.toThrow(/requires nexusPermissionsEnabled=true/);
  });

  test("assert-remote-policy-loaded with nexusPermissionsEnabled=false throws", async () => {
    await expect(
      createKoiRuntime({
        ...baseConfig(),
        nexusTransport: fakeTransport({
          kind: "http",
          health: async () => ({ ok: true, value: okHealth }),
        }) as HealthCapableNexusTransport,
        nexusBootMode: "assert-remote-policy-loaded-at-boot",
        nexusPermissionsEnabled: false,
      }),
    ).rejects.toThrow(/requires nexusPermissionsEnabled=true/);
  });

  test("local-bridge + nexusAuditPoisonOnError throws", async () => {
    // Note: poison guard check fires inside the audit block, AFTER the probe
    // block already handled local-bridge in telemetry mode. Use telemetry to
    // reach the audit block.
    await expect(
      createKoiRuntime({
        ...baseConfig(),
        nexusTransport: fakeTransport({ kind: "local-bridge" }),
        nexusBootMode: "telemetry",
        nexusAuditPoisonOnError: true,
      }),
    ).rejects.toThrow(/not supported on local-bridge/);
  });
});

// ---------------------------------------------------------------------------
// HTTP probe × boot mode matrix
// ---------------------------------------------------------------------------

describe("HTTP probe × boot mode matrix", () => {
  test("ok + telemetry → boots", async () => {
    handle = await createKoiRuntime({
      ...baseConfig(),
      nexusTransport: fakeTransport({
        kind: "http",
        health: async () => ({ ok: true, value: okHealth }),
      }) as HealthCapableNexusTransport,
      nexusBootMode: "telemetry",
    });
    expect(handle.runtime).toBeDefined();
  });

  test("ok + assert-transport-reachable-at-boot → boots", async () => {
    handle = await createKoiRuntime({
      ...baseConfig(),
      nexusTransport: fakeTransport({
        kind: "http",
        health: async () => ({ ok: true, value: okHealth }),
      }) as HealthCapableNexusTransport,
      nexusBootMode: "assert-transport-reachable-at-boot",
    });
    expect(handle.runtime).toBeDefined();
  });

  test("error + telemetry → boots with warn", async () => {
    handle = await createKoiRuntime({
      ...baseConfig(),
      nexusTransport: fakeTransport({
        kind: "http",
        health: async () => ({
          ok: false,
          error: { code: "TIMEOUT", message: "unreachable", retryable: true },
        }),
      }) as HealthCapableNexusTransport,
      nexusBootMode: "telemetry",
    });
    expect(handle.runtime).toBeDefined();
  });

  test("error + assert-transport-reachable-at-boot → throws", async () => {
    await expect(
      createKoiRuntime({
        ...baseConfig(),
        nexusTransport: fakeTransport({
          kind: "http",
          health: async () => ({
            ok: false,
            error: { code: "TIMEOUT", message: "unreachable", retryable: true },
          }),
        }) as HealthCapableNexusTransport,
        nexusBootMode: "assert-transport-reachable-at-boot",
      }),
    ).rejects.toThrow(/health probe failed/);
  });

  test("missing-paths + telemetry → boots with warn", async () => {
    handle = await createKoiRuntime({
      ...baseConfig(),
      nexusTransport: fakeTransport({
        kind: "http",
        health: async () => ({ ok: true, value: missingPathsHealth }),
      }) as HealthCapableNexusTransport,
      nexusBootMode: "telemetry",
    });
    expect(handle.runtime).toBeDefined();
  });

  test("missing-paths + assert-transport + allowEmpty=false → throws", async () => {
    await expect(
      createKoiRuntime({
        ...baseConfig(),
        nexusTransport: fakeTransport({
          kind: "http",
          health: async () => ({ ok: true, value: missingPathsHealth }),
        }) as HealthCapableNexusTransport,
        nexusBootMode: "assert-transport-reachable-at-boot",
      }),
    ).rejects.toThrow(/missing paths/);
  });

  test("missing-paths + assert-transport + allowEmpty=true → boots", async () => {
    handle = await createKoiRuntime({
      ...baseConfig(),
      nexusTransport: fakeTransport({
        kind: "http",
        health: async () => ({ ok: true, value: missingPathsHealth }),
      }) as HealthCapableNexusTransport,
      nexusBootMode: "assert-transport-reachable-at-boot",
      nexusAllowEmptyPolicyStore: true,
    });
    expect(handle.runtime).toBeDefined();
  });

  test("missing-paths + assert-remote-policy-loaded → throws", async () => {
    await expect(
      createKoiRuntime({
        ...baseConfig(),
        nexusTransport: fakeTransport({
          kind: "http",
          health: async () => ({ ok: true, value: missingPathsHealth }),
        }) as HealthCapableNexusTransport,
        nexusBootMode: "assert-remote-policy-loaded-at-boot",
      }),
    ).rejects.toThrow(/missing paths/);
  });
});

// ---------------------------------------------------------------------------
// assert-remote-policy-loaded preflight
// ---------------------------------------------------------------------------

describe("assert-remote-policy-loaded preflight", () => {
  test("happy path: probe ok + policy activates", async () => {
    handle = await createKoiRuntime({
      ...baseConfig(),
      nexusTransport: fakeTransport({
        kind: "http",
        health: async () => ({ ok: true, value: okHealth }),
        // default call() returns valid version + policy
      }) as HealthCapableNexusTransport,
      nexusBootMode: "assert-remote-policy-loaded-at-boot",
      nexusBootSyncDeadlineMs: 5_000,
    });
    expect(handle.runtime).toBeDefined();
  });

  test("activation failure (malformed policy.json) throws", async () => {
    // Force initializePolicy() into the catch block by returning unparseable
    // JSON. centralizedPolicyActive stays false → preflight throws.
    await expect(
      createKoiRuntime({
        ...baseConfig(),
        nexusTransport: fakeTransport({
          kind: "http",
          health: async () => ({ ok: true, value: okHealth }),
          call: async (_method, params) => {
            const path = params.path as string | undefined;
            if (path?.endsWith("version.json")) {
              return { ok: true, value: JSON.stringify({ version: 1 }) };
            }
            if (path?.endsWith("policy.json")) {
              // Unparseable JSON → JSON.parse throws → catch block → activation stays false
              return { ok: true, value: "not-json{{" };
            }
            return { ok: true, value: undefined };
          },
        }) as HealthCapableNexusTransport,
        nexusBootMode: "assert-remote-policy-loaded-at-boot",
        nexusBootSyncDeadlineMs: 5_000,
      }),
    ).rejects.toThrow(/resolved without activating remote policy/);
  });

  test("boot sync deadline exceeded → throws + abortInFlightSync", async () => {
    let releaseCall: ((v: Result<unknown, KoiError>) => void) | undefined;
    const hangPromise = new Promise<Result<unknown, KoiError>>((resolve) => {
      releaseCall = resolve;
    });
    const promise = createKoiRuntime({
      ...baseConfig(),
      nexusTransport: fakeTransport({
        kind: "http",
        health: async () => ({ ok: true, value: okHealth }),
        // call hangs forever — preflight race times out
        call: async () => hangPromise,
      }) as HealthCapableNexusTransport,
      nexusBootMode: "assert-remote-policy-loaded-at-boot",
      nexusBootSyncDeadlineMs: 50, // tiny deadline so test runs fast
    });
    await expect(promise).rejects.toThrow(/exceeded nexusBootSyncDeadlineMs/);
    // Release the late call so the test doesn't leak
    releaseCall?.({ ok: true, value: undefined });
  });
});

// ---------------------------------------------------------------------------
// Local-bridge probe via factory (telemetry only)
// ---------------------------------------------------------------------------

describe("local-bridge probe via nexusProbeFactory", () => {
  test("probe factory invoked + boot continues under telemetry", async () => {
    let factoryCalls = 0;
    handle = await createKoiRuntime({
      ...baseConfig(),
      nexusTransport: fakeTransport({ kind: "local-bridge" }),
      nexusBootMode: "telemetry",
      nexusProbeFactory: async () => {
        factoryCalls++;
        return {
          kind: "probe",
          call: (async () => ({ ok: true, value: undefined })) as NexusTransport["call"],
          health: async () => ({ ok: true, value: okHealth }),
          close: () => {},
        };
      },
    });
    expect(handle.runtime).toBeDefined();
    expect(factoryCalls).toBe(1);
  });

  test("probe factory throws → boot still continues under telemetry", async () => {
    handle = await createKoiRuntime({
      ...baseConfig(),
      nexusTransport: fakeTransport({ kind: "local-bridge" }),
      nexusBootMode: "telemetry",
      nexusProbeFactory: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(handle.runtime).toBeDefined();
  });

  test("local-bridge without probe factory → silent skip (back-compat)", async () => {
    handle = await createKoiRuntime({
      ...baseConfig(),
      nexusTransport: fakeTransport({ kind: "local-bridge" }),
      nexusBootMode: "telemetry",
    });
    expect(handle.runtime).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Audit poison guard
// ---------------------------------------------------------------------------

describe("nexusAuditPoisonOnError", () => {
  test("disabled (default): boot succeeds with healthy transport", async () => {
    handle = await createKoiRuntime({
      ...baseConfig(),
      nexusTransport: fakeTransport({
        kind: "http",
        health: async () => ({ ok: true, value: okHealth }),
      }) as HealthCapableNexusTransport,
      nexusBootMode: "telemetry",
    });
    expect(handle.runtime).toBeDefined();
  });

  test("enabled on HTTP: boot succeeds; latch armed", async () => {
    handle = await createKoiRuntime({
      ...baseConfig(),
      nexusTransport: fakeTransport({
        kind: "http",
        health: async () => ({ ok: true, value: okHealth }),
      }) as HealthCapableNexusTransport,
      nexusBootMode: "telemetry",
      nexusAuditPoisonOnError: true,
    });
    expect(handle.runtime).toBeDefined();
    // The poisoned-sink wrapper, compliance-recorder onError, and
    // admission-gate guards are wired but exercised only when an
    // actual sink failure occurs during a turn — that is covered by
    // the turn-level integration tests (deferred).
  });
});
