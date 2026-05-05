import { describe, expect, test } from "bun:test";
import type { BrickLifecycle } from "@koi/core";
import { validateGraphTransition, validateStoreTransition } from "./lifecycle.js";

describe("validateGraphTransition", () => {
  test("allows draft → verifying", () => {
    expect(validateGraphTransition("draft", "verifying")).toEqual({ ok: true });
  });

  test("allows verifying → active", () => {
    expect(validateGraphTransition("verifying", "active")).toEqual({ ok: true });
  });

  test("allows active → deprecated", () => {
    expect(validateGraphTransition("active", "deprecated")).toEqual({ ok: true });
  });

  test("allows quarantined → draft (graph permits remediation edge)", () => {
    expect(validateGraphTransition("quarantined", "draft")).toEqual({ ok: true });
  });

  test("allows deprecated → quarantined (graph permits)", () => {
    expect(validateGraphTransition("deprecated", "quarantined")).toEqual({ ok: true });
  });

  test("rejects skip state draft → active", () => {
    const r = validateGraphTransition("draft", "active");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("draft");
  });

  test("rejects skip state draft → deprecated", () => {
    const r = validateGraphTransition("draft", "deprecated");
    expect(r.ok).toBe(false);
  });

  test("rejects transitions out of failed (terminal)", () => {
    const r = validateGraphTransition("failed", "active");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("failed");
  });

  test("rejects unknown from-state", () => {
    const r = validateGraphTransition("nonsense" as BrickLifecycle, "active");
    expect(r.ok).toBe(false);
  });

  test("rejects unknown to-state", () => {
    const r = validateGraphTransition("active", "nonsense" as BrickLifecycle);
    expect(r.ok).toBe(false);
  });

  test("rejects identity transition (no-op is not a valid edge)", () => {
    const r = validateGraphTransition("active", "active");
    expect(r.ok).toBe(false);
  });
});

describe("validateStoreTransition", () => {
  test("allows draft → verifying (matches graph)", () => {
    expect(validateStoreTransition("draft", "verifying")).toEqual({ ok: true });
  });

  test("allows active → deprecated (entering a terminal is permitted)", () => {
    expect(validateStoreTransition("active", "deprecated")).toEqual({ ok: true });
  });

  test("rejects quarantined → draft (store treats quarantined as terminal)", () => {
    const r = validateStoreTransition("quarantined", "draft");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("terminal");
  });

  test("rejects deprecated → quarantined (store treats deprecated as terminal)", () => {
    const r = validateStoreTransition("deprecated", "quarantined");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("terminal");
  });

  test("rejects failed → anything (store treats failed as terminal)", () => {
    const r = validateStoreTransition("failed", "active");
    expect(r.ok).toBe(false);
  });

  test("inherits graph rejection for invalid edges", () => {
    const r = validateStoreTransition("draft", "active");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("draft");
  });

  test("rejects identity transition between unknown lifecycles (does not green-light corrupt state)", () => {
    const r = validateStoreTransition("bogus" as BrickLifecycle, "bogus" as BrickLifecycle);
    expect(r.ok).toBe(false);
  });

  test("accepts identity transition (matches memory-store no-op semantics)", () => {
    // memory-store.update() only validates transitions when the lifecycle
    // actually changes; identity is a semantic no-op success. Mirror that
    // so retried / already-applied lifecycle updates do not preflight false.
    expect(validateStoreTransition("active", "active")).toEqual({ ok: true });
    // Even on a store-terminal lifecycle, identity is still a no-op success.
    expect(validateStoreTransition("deprecated", "deprecated")).toEqual({ ok: true });
  });
});
