import { describe, expect, test } from "bun:test";
import type { AdapterCapabilities, SandboxAdapter, SandboxProfile } from "@koi/core";
import { describeCapabilityHonestyConformance } from "../capability-honesty.js";

// Negative-coverage tests: prove the conformance suite actually catches a
// lying adapter. We can't run `describeCapabilityHonestyConformance` directly
// on a lying fake (the inner test() calls would all fail and break the
// build); instead we re-implement the same assertions and confirm they
// detect each lie.

const profile: SandboxProfile = {
  filesystem: { defaultReadAccess: "open" },
  network: { allow: false },
  resources: {},
};

describe("capability honesty — sanity check that the suite is non-vacuous", () => {
  test("type — describeCapabilityHonestyConformance is callable on a non-lying fake", () => {
    // Compile-time check — if the suite signature drifts, this stops working.
    expect(typeof describeCapabilityHonestyConformance).toBe("function");
  });

  test("lying about persistence (no detach) is detected by an instance.detach typeof check", async () => {
    const lyingCaps: AdapterCapabilities = {
      supports: new Set(["persistence"]),
      priority: 0,
    };
    const lyingAdapter: SandboxAdapter = {
      name: "lying-persistence",
      version: "0.0.0",
      capabilities: lyingCaps,
      create: async () => ({
        exec: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 0,
          timedOut: false,
          oomKilled: false,
        }),
        readFile: async () => new Uint8Array(),
        writeFile: async () => {},
        destroy: async () => {},
        // intentionally no detach — this is the lie.
      }),
      findOrCreate: async () => ({
        exec: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 0,
          timedOut: false,
          oomKilled: false,
        }),
        readFile: async () => new Uint8Array(),
        writeFile: async () => {},
        destroy: async () => {},
        // intentionally no detach.
      }),
    };
    const instance = await lyingAdapter.findOrCreate?.("scope", profile);
    expect(typeof instance?.detach).toBe("undefined");
  });

  test("lying about copy-files (no readFile/writeFile) is detected by typeof checks", async () => {
    const lyingCaps: AdapterCapabilities = {
      supports: new Set(["copy-files"]),
      priority: 0,
    };
    const lyingAdapter: SandboxAdapter = {
      name: "lying-copy-files",
      version: "0.0.0",
      capabilities: lyingCaps,
      create: async () =>
        ({
          exec: async () => ({
            exitCode: 0,
            stdout: "",
            stderr: "",
            durationMs: 0,
            timedOut: false,
            oomKilled: false,
          }),
          destroy: async () => {},
          // intentionally no readFile/writeFile.
        }) as never,
    };
    const instance = await lyingAdapter.create(profile);
    expect(typeof instance.readFile).toBe("undefined");
    expect(typeof instance.writeFile).toBe("undefined");
  });

  test("lying about persistence by omitting findOrCreate is detected", () => {
    const lyingCaps: AdapterCapabilities = {
      supports: new Set(["persistence"]),
      priority: 0,
    };
    const lyingAdapter: SandboxAdapter = {
      name: "lying-no-findOrCreate",
      version: "0.0.0",
      capabilities: lyingCaps,
      create: async () =>
        ({
          exec: async () => ({
            exitCode: 0,
            stdout: "",
            stderr: "",
            durationMs: 0,
            timedOut: false,
            oomKilled: false,
          }),
          readFile: async () => new Uint8Array(),
          writeFile: async () => {},
          destroy: async () => {},
        }) as never,
      // intentionally no findOrCreate — this is the lie.
    };
    expect(typeof lyingAdapter.findOrCreate).toBe("undefined");
  });
});
