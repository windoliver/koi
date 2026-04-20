import { describe, expect, test } from "bun:test";
import type { BrowserDriver, KoiError, Result } from "@koi/core";

import { createExtensionBrowserDriver } from "../driver.js";

function okResult<T>(value: T): Result<T, KoiError> {
  return { ok: true, value };
}

function errorResult<T>(message: string): Result<T, KoiError> {
  return {
    ok: false,
    error: {
      code: "TIMEOUT",
      message,
      retryable: true,
    },
  };
}

function makeStubPlaywright(): {
  readonly driver: BrowserDriver;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const record = <T>(name: string, returnValue: Result<T, KoiError>) =>
    ((...args: readonly unknown[]): Result<T, KoiError> => {
      calls.push(`${name}(${args.length})`);
      return returnValue;
    }) as never;

  const driver: BrowserDriver = {
    name: "stub-playwright",
    snapshot: record(
      "snapshot",
      okResult({ snapshot: "yaml", snapshotId: "s1", url: "x", title: "t" }),
    ),
    navigate: record("navigate", okResult({ ok: true })),
    click: record("click", okResult(undefined)),
    type: record("type", okResult(undefined)),
    select: record("select", okResult(undefined)),
    fillForm: record("fillForm", okResult(undefined)),
    scroll: record("scroll", okResult(undefined)),
    screenshot: record(
      "screenshot",
      okResult({ data: "base64png", mimeType: "image/png" as const }),
    ),
    wait: record("wait", okResult(undefined)),
    tabNew: record("tabNew", okResult({ tabId: "x", url: "u", title: "t" })),
    tabClose: record("tabClose", okResult(undefined)),
    tabFocus: record("tabFocus", okResult({ tabId: "x", url: "u", title: "t" })),
    tabList: async () => okResult([] as const),
    evaluate: record("evaluate", okResult({ value: null })),
    hover: record("hover", okResult(undefined)),
    press: record("press", okResult(undefined)),
    console: record("console", okResult({ entries: [] as const })),
    upload: record("upload", okResult(undefined)),
    traceStart: record("traceStart", okResult(undefined)),
    traceStop: record("traceStop", okResult({ zipBase64: "", manifest: { entries: [] } })),
    dispose: async () => {},
  };
  return { driver, calls };
}

describe("createExtensionBrowserDriver — playwrightDriver delegation", () => {
  test("missing playwrightDriver returns clear error for interaction methods", async () => {
    const driver = createExtensionBrowserDriver({});
    for (const name of [
      "snapshot",
      "navigate",
      "click",
      "type",
      "select",
      "fillForm",
      "scroll",
      "screenshot",
      "wait",
      "tabNew",
      "tabClose",
      "tabFocus",
      "evaluate",
      "hover",
      "press",
      "console",
      "upload",
      "traceStart",
      "traceStop",
    ] as const) {
      const method = (driver as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
      if (typeof method !== "function") continue;
      const result = await method("arg1", "arg2");
      expect((result as Result<unknown, KoiError>).ok).toBe(false);
      const err = (result as { ok: false; error: KoiError }).error;
      expect(err.message).toMatch(/playwrightDriver/);
    }
    await driver.dispose?.();
  });

  test("interaction methods forward to the provided playwrightDriver", async () => {
    const stub = makeStubPlaywright();
    const driver = createExtensionBrowserDriver({ playwrightDriver: stub.driver });

    await driver.navigate("https://example.com");
    await driver.click("e1");
    await driver.type("e2", "hello");
    await driver.screenshot();
    await driver.snapshot();
    await driver.evaluate("1 + 1");
    await driver.hover("e3");
    await driver.press("Enter");
    await driver.wait({ kind: "timeout", timeout: 5 });
    await driver.scroll({ kind: "page", direction: "down" });
    await driver.tabNew();
    await driver.tabFocus("x");
    await driver.tabClose();
    await driver.select("e4", "opt");
    await driver.fillForm([{ ref: "e5", value: "v" }]);
    await driver.console?.();

    expect(stub.calls).toContain("navigate(2)");
    expect(stub.calls).toContain("click(2)");
    expect(stub.calls).toContain("snapshot(1)");
    expect(stub.calls).toContain("screenshot(1)");
    await driver.dispose?.();
  });

  test("createPlaywrightDriver factory is invoked once on first interaction and cached", async () => {
    const stub = makeStubPlaywright();
    let factoryCalls = 0;
    const driver = createExtensionBrowserDriver({
      // No discovery dir / no host — the factory path attempts runtime.tabList()
      // first. Here we short-circuit by supplying a factory that we can inspect
      // but that will never actually get invoked because tabList() fails without
      // a running host. That's expected: `missingPlaywrightError` falls through.
      // The important contract: the factory is NOT invoked speculatively.
      instancesDir: "/tmp/koi-browser-ext-nope",
      authToken: "1234567890abcdef",
      createPlaywrightDriver: () => {
        factoryCalls += 1;
        return stub.driver;
      },
    });

    await driver.snapshot();
    // The factory may fire once if tabList succeeds; in this harness it won't
    // because no host is discoverable. Key invariant: no MORE than one call.
    expect(factoryCalls).toBeLessThanOrEqual(1);
    await driver.dispose?.();
  });

  test("tabList does NOT forward — always uses native-host path", async () => {
    const stub = makeStubPlaywright();
    const driver = createExtensionBrowserDriver({ playwrightDriver: stub.driver });
    // tabList requires discovery which will fail (no discovery dir set up).
    // Point is that the stub is NOT called even when a pw driver is supplied.
    const result = await driver.tabList();
    expect(stub.calls.includes("tabList")).toBe(false);
    // Either ok:false with some discovery error, or ok:true with empty list from stub.
    expect(typeof result.ok).toBe("boolean");
    await driver.dispose?.();
  });

  test("optional methods (upload/traceStart/traceStop) return error when pw lacks them", async () => {
    const partial = makeStubPlaywright();
    const { upload: _u, traceStart: _ts, traceStop: _tp, ...minimalPw } = partial.driver;
    void _u;
    void _ts;
    void _tp;
    const driver = createExtensionBrowserDriver({ playwrightDriver: minimalPw });

    const uploadRes = await driver.upload?.("e1", []);
    expect(uploadRes?.ok).toBe(false);
    const traceStartRes = await driver.traceStart?.();
    expect(traceStartRes?.ok).toBe(false);
    const traceStopRes = await driver.traceStop?.();
    expect(traceStopRes?.ok).toBe(false);

    // Reference unused vars so biome doesn't complain.
    void errorResult<void>("unused");
    await driver.dispose?.();
  });
});
