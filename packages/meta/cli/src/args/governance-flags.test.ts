/**
 * Tests for the shared governance-flag parser used by both `koi start`
 * and `koi tui`. Covers the six flag surfaces from gov-10:
 *   --max-spend, --max-turns, --max-spawn-depth,
 *   --policy-file, --alert-threshold (repeatable), --no-governance.
 */

import { describe, expect, test } from "bun:test";
import {
  GOVERNANCE_FLAG_NAMES,
  type GovernanceFlagDefaults,
  type GovernanceFlagRaw,
  type GovernanceFlags,
  mergeGovernanceFlags,
  parseGovernanceFlags,
} from "./governance-flags.js";
import { ParseError } from "./shared.js";

function parse(raw: Partial<GovernanceFlagRaw>): GovernanceFlags {
  const defaults: GovernanceFlagRaw = {
    "max-spend": undefined,
    "max-turns": undefined,
    "max-spawn-depth": undefined,
    "policy-file": undefined,
    "alert-threshold": undefined,
    "no-governance": undefined,
  };
  return parseGovernanceFlags({ ...defaults, ...raw }, false);
}

describe("parseGovernanceFlags — defaults", () => {
  test("no flags → enabled with all overrides undefined", () => {
    const flags = parse({});
    expect(flags).toEqual({
      enabled: true,
      maxSpendUsd: undefined,
      maxTurns: undefined,
      maxSpawnDepth: undefined,
      policyFilePath: undefined,
      alertThresholds: undefined,
    });
  });

  test("exports the canonical raw-key list", () => {
    const got: readonly string[] = [...GOVERNANCE_FLAG_NAMES].sort();
    const want: readonly string[] = [
      "alert-threshold",
      "max-spawn-depth",
      "max-spend",
      "max-turns",
      "no-governance",
      "policy-file",
    ].sort();
    expect(got).toEqual(want);
  });
});

describe("parseGovernanceFlags — --max-spend", () => {
  test("accepts decimal USD", () => {
    expect(parse({ "max-spend": "2.50" }).maxSpendUsd).toBe(2.5);
  });

  test("accepts zero", () => {
    expect(parse({ "max-spend": "0" }).maxSpendUsd).toBe(0);
  });

  test("rejects negative", () => {
    expect(() => parse({ "max-spend": "-1" })).toThrow(ParseError);
  });

  test("rejects non-numeric", () => {
    expect(() => parse({ "max-spend": "abc" })).toThrow(ParseError);
  });
});

describe("parseGovernanceFlags — --max-turns", () => {
  test("accepts positive int", () => {
    expect(parse({ "max-turns": "50" }).maxTurns).toBe(50);
  });

  test("rejects zero", () => {
    expect(() => parse({ "max-turns": "0" })).toThrow(ParseError);
  });

  test("rejects float", () => {
    expect(() => parse({ "max-turns": "10.5" })).toThrow(ParseError);
  });

  test("rejects trailing junk (fat-finger guard)", () => {
    expect(() => parse({ "max-turns": "50abc" })).toThrow(ParseError);
  });
});

describe("parseGovernanceFlags — --max-spawn-depth", () => {
  test("accepts positive int", () => {
    expect(parse({ "max-spawn-depth": "3" }).maxSpawnDepth).toBe(3);
  });

  test("rejects zero", () => {
    expect(() => parse({ "max-spawn-depth": "0" })).toThrow(ParseError);
  });

  test("rejects negative", () => {
    expect(() => parse({ "max-spawn-depth": "-1" })).toThrow(ParseError);
  });
});

describe("parseGovernanceFlags — --policy-file", () => {
  test("passes path through unchanged", () => {
    expect(parse({ "policy-file": "./policies/default.yaml" }).policyFilePath).toBe(
      "./policies/default.yaml",
    );
  });

  test("rejects empty string", () => {
    expect(() => parse({ "policy-file": "" })).toThrow(ParseError);
  });
});

describe("parseGovernanceFlags — --alert-threshold", () => {
  test("single value stored as 1-elem array", () => {
    expect(parse({ "alert-threshold": ["0.9"] }).alertThresholds).toEqual([0.9]);
  });

  test("repeated values preserved in order", () => {
    expect(parse({ "alert-threshold": ["0.7", "0.85", "0.95"] }).alertThresholds).toEqual([
      0.7, 0.85, 0.95,
    ]);
  });

  test("rejects values > 1", () => {
    expect(() => parse({ "alert-threshold": ["1.5"] })).toThrow(ParseError);
  });

  test("rejects values <= 0", () => {
    expect(() => parse({ "alert-threshold": ["0"] })).toThrow(ParseError);
  });

  test("rejects non-numeric", () => {
    expect(() => parse({ "alert-threshold": ["foo"] })).toThrow(ParseError);
  });
});

describe("parseGovernanceFlags — --no-governance", () => {
  test("sets enabled:false with no other flags", () => {
    expect(parse({ "no-governance": true }).enabled).toBe(false);
  });

  test("conflicts with --max-spend", () => {
    expect(() => parse({ "no-governance": true, "max-spend": "1" })).toThrow(ParseError);
  });

  test("conflicts with --max-turns", () => {
    expect(() => parse({ "no-governance": true, "max-turns": "5" })).toThrow(ParseError);
  });

  test("conflicts with --max-spawn-depth", () => {
    expect(() => parse({ "no-governance": true, "max-spawn-depth": "1" })).toThrow(ParseError);
  });

  test("conflicts with --policy-file", () => {
    expect(() => parse({ "no-governance": true, "policy-file": "x.yaml" })).toThrow(ParseError);
  });

  test("conflicts with --alert-threshold", () => {
    expect(() => parse({ "no-governance": true, "alert-threshold": ["0.9"] })).toThrow(ParseError);
  });
});

describe("mergeGovernanceFlags — manifest defaults", () => {
  const EMPTY_FLAGS: GovernanceFlags = {
    enabled: true,
    maxSpendUsd: undefined,
    maxTurns: undefined,
    maxSpawnDepth: undefined,
    policyFilePath: undefined,
    alertThresholds: undefined,
  };

  test("no defaults → flags unchanged", () => {
    expect(mergeGovernanceFlags(EMPTY_FLAGS, undefined)).toBe(EMPTY_FLAGS);
  });

  test("manifest defaults fill in missing fields", () => {
    const defaults: GovernanceFlagDefaults = {
      maxSpendUsd: 2.5,
      maxTurns: 50,
      maxSpawnDepth: 3,
      policyFilePath: "/abs/policies.yaml",
      alertThresholds: [0.7, 0.9],
    };
    const merged = mergeGovernanceFlags(EMPTY_FLAGS, defaults);
    expect(merged.maxSpendUsd).toBe(2.5);
    expect(merged.maxTurns).toBe(50);
    expect(merged.maxSpawnDepth).toBe(3);
    expect(merged.policyFilePath).toBe("/abs/policies.yaml");
    expect(merged.alertThresholds).toEqual([0.7, 0.9]);
  });

  test("CLI flag wins over manifest default", () => {
    const flags: GovernanceFlags = {
      enabled: true,
      maxSpendUsd: 0.01,
      maxTurns: undefined,
      maxSpawnDepth: undefined,
      policyFilePath: undefined,
      alertThresholds: undefined,
    };
    const defaults: GovernanceFlagDefaults = {
      maxSpendUsd: 5.0,
      maxTurns: 50,
      maxSpawnDepth: undefined,
      policyFilePath: undefined,
      alertThresholds: undefined,
    };
    const merged = mergeGovernanceFlags(flags, defaults);
    expect(merged.maxSpendUsd).toBe(0.01); // CLI wins
    expect(merged.maxTurns).toBe(50); // manifest fills
  });

  test("--no-governance ignores manifest defaults entirely", () => {
    const disabled: GovernanceFlags = { ...EMPTY_FLAGS, enabled: false };
    const defaults: GovernanceFlagDefaults = {
      maxSpendUsd: 2.5,
      maxTurns: 50,
      maxSpawnDepth: undefined,
      policyFilePath: undefined,
      alertThresholds: undefined,
    };
    const merged = mergeGovernanceFlags(disabled, defaults);
    expect(merged).toBe(disabled);
  });
});

describe("parseGovernanceFlags — skipValidators (help/version escape hatch)", () => {
  test("bad value returns defaults when skip=true", () => {
    const raw: GovernanceFlagRaw = {
      "max-spend": "-1",
      "max-turns": "0",
      "max-spawn-depth": "-1",
      "policy-file": undefined,
      "alert-threshold": ["2"],
      "no-governance": undefined,
    };
    // Must not throw.
    expect(() => parseGovernanceFlags(raw, true)).not.toThrow();
  });
});
