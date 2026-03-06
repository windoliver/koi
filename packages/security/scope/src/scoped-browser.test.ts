import { describe, expect, test } from "bun:test";
import type { BrowserDriver, KoiError, Result } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createScopedBrowser } from "./scoped-browser.js";

// ---------------------------------------------------------------------------
// Mock driver
// ---------------------------------------------------------------------------

function createMockDriver(name = "mock"): BrowserDriver & {
  readonly navigatedUrls: readonly string[];
  readonly evaluatedScripts: readonly string[];
} {
  const navigatedUrls: string[] = [];
  const evaluatedScripts: string[] = [];

  return {
    name,
    snapshot: () => ({
      ok: true,
      value: { snapshot: "", snapshotId: "s1", refs: {}, truncated: false, url: "", title: "" },
    }),
    navigate: (url) => {
      navigatedUrls.push(url);
      return { ok: true, value: { url, title: "Page" } };
    },
    click: () => ({ ok: true, value: undefined }),
    type: () => ({ ok: true, value: undefined }),
    select: () => ({ ok: true, value: undefined }),
    fillForm: () => ({ ok: true, value: undefined }),
    scroll: () => ({ ok: true, value: undefined }),
    screenshot: () => ({
      ok: true,
      value: { data: "", mimeType: "image/png" as const, width: 100, height: 100 },
    }),
    wait: () => ({ ok: true, value: undefined }),
    tabNew: () => ({ ok: true, value: { tabId: "t1", url: "", title: "" } }),
    tabClose: () => ({ ok: true, value: undefined }),
    tabFocus: () => ({ ok: true, value: { tabId: "t1", url: "", title: "" } }),
    evaluate: (script) => {
      evaluatedScripts.push(script);
      return { ok: true, value: { value: undefined } };
    },
    hover: () => ({ ok: true, value: undefined }),
    press: () => ({ ok: true, value: undefined }),
    tabList: () => ({ ok: true, value: [] }),
    console: () => ({ ok: true, value: { entries: [], total: 0 } }),
    navigatedUrls,
    evaluatedScripts,
  };
}

function isErr(
  r: Result<unknown, KoiError>,
): r is { readonly ok: false; readonly error: KoiError } {
  return !r.ok;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createScopedBrowser", () => {
  test("navigate passes through for allowed domains", () => {
    const driver = createMockDriver();
    const scoped = createScopedBrowser(driver, {
      navigation: { allowedDomains: ["example.com"] },
    });
    const r = scoped.navigate("https://example.com/page");
    expect(r).toHaveProperty("ok", true);
    expect(driver.navigatedUrls).toEqual(["https://example.com/page"]);
  });

  test("navigate blocks disallowed domains", () => {
    const driver = createMockDriver();
    const scoped = createScopedBrowser(driver, {
      navigation: { allowedDomains: ["example.com"] },
    });
    const r = scoped.navigate("https://evil.com/steal") as Result<unknown, KoiError>;
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("PERMISSION");
    expect(driver.navigatedUrls).toHaveLength(0);
  });

  test("navigate blocks private IPs by default", () => {
    const driver = createMockDriver();
    const scoped = createScopedBrowser(driver, { navigation: {} });
    const r = scoped.navigate("https://192.168.1.1/admin") as Result<unknown, KoiError>;
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("PERMISSION");
  });

  test("tabNew with URL checks domain allowlist", () => {
    const driver = createMockDriver();
    const scoped = createScopedBrowser(driver, {
      navigation: { allowedDomains: ["example.com"] },
    });
    const r = scoped.tabNew({ url: "https://evil.com/" }) as Result<unknown, KoiError>;
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("PERMISSION");
  });

  test("tabNew without URL passes through", () => {
    const driver = createMockDriver();
    const scoped = createScopedBrowser(driver, {
      navigation: { allowedDomains: ["example.com"] },
    });
    const r = scoped.tabNew();
    expect(r).toHaveProperty("ok", true);
  });

  test("evaluate blocks when policy is sandboxed", () => {
    const driver = createMockDriver();
    const scoped = createScopedBrowser(driver, {
      navigation: {},
      policy: DEFAULT_SANDBOXED_POLICY,
    });
    const r = scoped.evaluate("alert(1)") as Result<unknown, KoiError>;
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.code).toBe("PERMISSION");
      expect(r.error.message).toContain("unsandboxed");
    }
    expect(driver.evaluatedScripts).toHaveLength(0);
  });

  test("evaluate blocks when policy is undefined (defaults to non-promoted)", () => {
    const driver = createMockDriver();
    const scoped = createScopedBrowser(driver, { navigation: {} });
    const r = scoped.evaluate("alert(1)") as Result<unknown, KoiError>;
    expect(isErr(r)).toBe(true);
  });

  test("evaluate passes when policy is unsandboxed", () => {
    const driver = createMockDriver();
    const scoped = createScopedBrowser(driver, {
      navigation: {},
      policy: DEFAULT_UNSANDBOXED_POLICY,
    });
    const r = scoped.evaluate("return 42");
    expect(r).toHaveProperty("ok", true);
    expect(driver.evaluatedScripts).toEqual(["return 42"]);
  });

  test("snapshot passes through unchanged", () => {
    const driver = createMockDriver();
    const scoped = createScopedBrowser(driver, { navigation: {} });
    const r = scoped.snapshot();
    expect(r).toHaveProperty("ok", true);
  });

  test("click passes through unchanged", () => {
    const driver = createMockDriver();
    const scoped = createScopedBrowser(driver, { navigation: {} });
    const r = scoped.click("e1");
    expect(r).toHaveProperty("ok", true);
  });

  test("type passes through unchanged", () => {
    const driver = createMockDriver();
    const scoped = createScopedBrowser(driver, { navigation: {} });
    const r = scoped.type("e1", "hello");
    expect(r).toHaveProperty("ok", true);
  });

  test("error messages include domain and allowlist context", () => {
    const driver = createMockDriver();
    const scoped = createScopedBrowser(driver, {
      navigation: { allowedDomains: ["example.com"] },
    });
    const r = scoped.navigate("https://blocked.com/") as Result<unknown, KoiError>;
    if (isErr(r)) {
      expect(r.error.message).toContain("blocked.com");
    }
  });

  test("sets name with scoped prefix", () => {
    const driver = createMockDriver("playwright");
    const scoped = createScopedBrowser(driver, { navigation: {} });
    expect(scoped.name).toBe("scoped(playwright)");
  });

  test("preserves optional methods from driver", () => {
    const driver: BrowserDriver = {
      ...createMockDriver(),
      upload: () => ({ ok: true, value: undefined }),
      traceStart: () => ({ ok: true, value: undefined }),
      traceStop: () => ({ ok: true, value: { path: "/tmp/trace.zip" } }),
    };
    const scoped = createScopedBrowser(driver, { navigation: {} });
    expect(scoped.upload).toBeDefined();
    expect(scoped.traceStart).toBeDefined();
    expect(scoped.traceStop).toBeDefined();
  });

  test("omits optional methods when driver lacks them", () => {
    const driver = createMockDriver();
    const scoped = createScopedBrowser(driver, { navigation: {} });
    expect(scoped.upload).toBeUndefined();
    expect(scoped.traceStart).toBeUndefined();
    expect(scoped.traceStop).toBeUndefined();
  });
});
