import { describe, expect, test } from "bun:test";
import type {
  AdapterCapabilities,
  AdapterCapability,
  CapabilityRequirements,
  SandboxAdapter,
  SandboxInstance,
} from "@koi/core";
import { matchAdapters } from "./match.js";

function fakeAdapter(name: string, caps: AdapterCapability[], priority = 0): SandboxAdapter {
  const supports: ReadonlySet<AdapterCapability> = new Set(caps);
  const capabilities: AdapterCapabilities = { supports, priority };
  return {
    name,
    create: () => Promise.reject(new Error("not used in match tests")) as Promise<SandboxInstance>,
    capabilities,
  };
}

function reqs(
  required: AdapterCapability[],
  forbidden?: AdapterCapability[],
): CapabilityRequirements {
  const r: CapabilityRequirements = {
    required: new Set(required),
    ...(forbidden ? { forbidden: new Set(forbidden) } : {}),
  };
  return r;
}

describe("matchAdapters", () => {
  test("returns adapter when capabilities exactly match required set", () => {
    const a = fakeAdapter("local", ["exec", "copy-files"]);
    const result = matchAdapters([a], reqs(["exec"]));
    expect(result.matched.map((m) => m.name)).toEqual(["local"]);
    expect(result.rejected).toEqual([]);
  });

  test("rejects adapter missing a required capability with `missing` list", () => {
    const a = fakeAdapter("local", ["exec"]);
    const result = matchAdapters([a], reqs(["exec", "spawn"]));
    expect(result.matched).toEqual([]);
    expect(result.rejected).toEqual([
      { adapter: "local", reason: "missing-capabilities", missing: ["spawn"] },
    ]);
  });

  test("rejects adapter that has a forbidden capability", () => {
    const a = fakeAdapter("docker", ["exec", "network"]);
    const result = matchAdapters([a], reqs(["exec"], ["network"]));
    expect(result.matched).toEqual([]);
    expect(result.rejected).toEqual([{ adapter: "docker", reason: "forbidden-capabilities" }]);
  });

  test("excludes adapters with no capabilities declaration", () => {
    const a: SandboxAdapter = {
      name: "legacy",
      create: () => Promise.reject(new Error("unused")) as Promise<SandboxInstance>,
    };
    const result = matchAdapters([a], reqs(["exec"]));
    expect(result.matched).toEqual([]);
    expect(result.rejected).toEqual([
      { adapter: "legacy", reason: "missing-capabilities", missing: ["exec"] },
    ]);
  });

  test("matches multiple adapters and preserves input order", () => {
    const a = fakeAdapter("local", ["exec"], 0);
    const b = fakeAdapter("docker", ["exec"], 10);
    const result = matchAdapters([a, b], reqs(["exec"]));
    expect(result.matched.map((m) => m.name)).toEqual(["local", "docker"]);
  });
});
