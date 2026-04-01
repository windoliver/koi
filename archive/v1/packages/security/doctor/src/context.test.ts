import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import { createDoctorContext } from "./context.js";

const MANIFEST: AgentManifest = {
  name: "test",
  version: "1.0.0",
  model: { name: "claude" },
  tools: [{ name: "read_file" }, { name: "write_file" }],
  middleware: [{ name: "sanitize" }, { name: "audit" }],
  permissions: { allow: ["read_file"], deny: ["exec"], ask: ["write_file"] },
  delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
};

describe("createDoctorContext", () => {
  test("exposes manifest directly", () => {
    const ctx = createDoctorContext(MANIFEST);
    expect(ctx.manifest).toBe(MANIFEST);
  });

  test("exposes permissions from manifest", () => {
    const ctx = createDoctorContext(MANIFEST);
    expect(ctx.permissions).toBe(MANIFEST.permissions);
  });

  test("exposes delegation from manifest", () => {
    const ctx = createDoctorContext(MANIFEST);
    expect(ctx.delegation).toBe(MANIFEST.delegation);
  });

  test("permissions is undefined when manifest has none", () => {
    const ctx = createDoctorContext({
      name: "bare",
      version: "0.1.0",
      model: { name: "claude" },
    });
    expect(ctx.permissions).toBeUndefined();
  });
});

describe("middlewareNames", () => {
  test("returns set of middleware names", () => {
    const ctx = createDoctorContext(MANIFEST);
    const names = ctx.middlewareNames();
    expect(names.has("sanitize")).toBe(true);
    expect(names.has("audit")).toBe(true);
    expect(names.has("sandbox")).toBe(false);
  });

  test("returns empty set when no middleware", () => {
    const ctx = createDoctorContext({
      name: "bare",
      version: "0.1.0",
      model: { name: "claude" },
    });
    expect(ctx.middlewareNames().size).toBe(0);
  });

  test("is memoized (same reference on repeated calls)", () => {
    const ctx = createDoctorContext(MANIFEST);
    const a = ctx.middlewareNames();
    const b = ctx.middlewareNames();
    expect(a).toBe(b);
  });
});

describe("toolNames", () => {
  test("returns set of tool names", () => {
    const ctx = createDoctorContext(MANIFEST);
    const names = ctx.toolNames();
    expect(names.has("read_file")).toBe(true);
    expect(names.has("write_file")).toBe(true);
    expect(names.size).toBe(2);
  });

  test("is memoized", () => {
    const ctx = createDoctorContext(MANIFEST);
    expect(ctx.toolNames()).toBe(ctx.toolNames());
  });
});

describe("dependencies", () => {
  test("returns provided dependencies", () => {
    const deps = [{ name: "foo", version: "1.0.0", isDev: false }] as const;
    const ctx = createDoctorContext(MANIFEST, { dependencies: deps });
    expect(ctx.dependencies()).toEqual(deps);
  });

  test("extracts from packageJson when no deps provided", () => {
    const ctx = createDoctorContext(MANIFEST, {
      packageJson: {
        dependencies: { lodash: "4.17.21" },
        devDependencies: { vitest: "1.0.0" },
      },
    });
    const deps = ctx.dependencies();
    expect(deps).toHaveLength(2);
    expect(deps[0]).toEqual({ name: "lodash", version: "4.17.21", isDev: false });
    expect(deps[1]).toEqual({ name: "vitest", version: "1.0.0", isDev: true });
  });

  test("returns empty array when nothing provided", () => {
    const ctx = createDoctorContext(MANIFEST);
    expect(ctx.dependencies()).toEqual([]);
  });

  test("is memoized", () => {
    const ctx = createDoctorContext(MANIFEST);
    expect(ctx.dependencies()).toBe(ctx.dependencies());
  });
});

describe("envKeys", () => {
  test("returns provided env keys", () => {
    const envKeys = new Set(["API_KEY", "SECRET"]);
    const ctx = createDoctorContext(MANIFEST, { envKeys });
    expect(ctx.envKeys()).toBe(envKeys);
  });

  test("falls back to process.env keys", () => {
    const ctx = createDoctorContext(MANIFEST);
    const keys = ctx.envKeys();
    // process.env always has at least PATH
    expect(keys.size).toBeGreaterThan(0);
  });

  test("is memoized", () => {
    const ctx = createDoctorContext(MANIFEST);
    expect(ctx.envKeys()).toBe(ctx.envKeys());
  });
});

describe("packageJson", () => {
  test("included when provided", () => {
    const pkg = { name: "test", version: "1.0.0" };
    const ctx = createDoctorContext(MANIFEST, { packageJson: pkg });
    expect(ctx.packageJson).toEqual(pkg);
  });

  test("undefined when not provided", () => {
    const ctx = createDoctorContext(MANIFEST);
    expect(ctx.packageJson).toBeUndefined();
  });
});
