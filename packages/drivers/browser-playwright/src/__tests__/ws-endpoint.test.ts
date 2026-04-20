import { describe, expect, mock, test } from "bun:test";

import type { Browser } from "playwright";
import { chromium } from "playwright";

import { createPlaywrightBrowserDriver } from "../playwright-browser-driver.js";

const makeFakeBrowser = (): Browser =>
  ({
    contexts: () => [],
    newContext: async () => ({
      pages: () => [],
      newPage: async () => ({
        url: () => "about:blank",
        title: async () => "",
        on: () => {},
        close: async () => {},
      }),
      close: async () => {},
      addInitScript: async () => {},
      route: async () => {},
    }),
    close: async () => {},
  }) as unknown as Browser;

describe("createPlaywrightBrowserDriver with wsEndpoint", () => {
  test("wsEndpoint is passed as the first (positional) arg to connectOverCDP, not as a deprecated property", async () => {
    const fakeBrowser = makeFakeBrowser();
    const connectSpy = mock(async () => fakeBrowser);
    const original = chromium.connectOverCDP;
    (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
      connectSpy as unknown as typeof chromium.connectOverCDP;

    try {
      const driver = createPlaywrightBrowserDriver({
        wsEndpoint: "ws://127.0.0.1:45678/devtools/browser/abcd",
        blockPrivateAddresses: false,
      });
      // tabNew() forces lazy browser + context init.
      await driver.tabNew();

      expect(connectSpy).toHaveBeenCalledTimes(1);
      // @ts-expect-error — bun:test mock.calls typing reports empty tuple; runtime has entries
      const firstArg: unknown = connectSpy.mock.calls[0]?.[0];
      // @ts-expect-error — same mock-calls typing issue
      const secondArg: unknown = connectSpy.mock.calls[0]?.[1];
      // Modern Playwright API: endpointURL is the POSITIONAL first arg (string), options is second.
      expect(firstArg).toBe("ws://127.0.0.1:45678/devtools/browser/abcd");
      expect(secondArg).toEqual(expect.objectContaining({ timeout: expect.any(Number) }));

      await driver.dispose?.();
    } finally {
      (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
        original;
    }
  });

  test("wsHeaders forwarded to connectOverCDP — enables Authorization: Bearer for browser-ext bridge", async () => {
    const fakeBrowser = makeFakeBrowser();
    const connectSpy = mock(async () => fakeBrowser);
    const original = chromium.connectOverCDP;
    (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
      connectSpy as unknown as typeof chromium.connectOverCDP;

    try {
      const driver = createPlaywrightBrowserDriver({
        wsEndpoint: "ws://127.0.0.1:45678/x",
        wsHeaders: { Authorization: "Bearer test-token-abc" },
        blockPrivateAddresses: false,
      });
      await driver.tabNew();
      await driver.dispose?.();

      // @ts-expect-error — mock-calls typing
      const secondArg = connectSpy.mock.calls[0]?.[1] as { headers?: Record<string, string> };
      expect(secondArg?.headers).toEqual({ Authorization: "Bearer test-token-abc" });
    } finally {
      (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
        original;
    }
  });

  test("wsEndpoint takes precedence over cdpEndpoint when both are set", async () => {
    const fakeBrowser = makeFakeBrowser();
    const connectSpy = mock(async () => fakeBrowser);
    const original = chromium.connectOverCDP;
    (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
      connectSpy as unknown as typeof chromium.connectOverCDP;

    try {
      const driver = createPlaywrightBrowserDriver({
        wsEndpoint: "ws://127.0.0.1:45678/x",
        cdpEndpoint: "http://localhost:9222",
        blockPrivateAddresses: false,
      });
      await driver.tabNew();
      await driver.dispose?.();

      // @ts-expect-error — mock-calls typing
      const firstArg: unknown = connectSpy.mock.calls[0]?.[0];
      // Must be called with the wsEndpoint URL (not the cdpEndpoint one).
      expect(firstArg).toBe("ws://127.0.0.1:45678/x");
    } finally {
      (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
        original;
    }
  });

  test("borrowed context: does NOT install route() on caller-owned context", async () => {
    const routeSpy = mock(async () => {});
    const addInitScriptSpy = mock(async () => {});
    const existingContext = {
      pages: () => [],
      newPage: async () => ({
        url: () => "about:blank",
        title: async () => "",
        on: () => {},
        close: async () => {},
      }),
      close: async () => {},
      addInitScript: addInitScriptSpy,
      route: routeSpy,
    };
    const fakeBrowser = {
      contexts: () => [existingContext],
      newContext: async () => {
        throw new Error("should not create a new context when one exists");
      },
      close: async () => {},
    } as unknown as Browser;

    const connectSpy = mock(async () => fakeBrowser);
    const original = chromium.connectOverCDP;
    (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
      connectSpy as unknown as typeof chromium.connectOverCDP;

    try {
      const driver = createPlaywrightBrowserDriver({
        wsEndpoint: "ws://127.0.0.1:45678/x",
        blockPrivateAddresses: true, // would normally install route() — must be skipped on borrowed context
        stealth: true, // would normally addInitScript() — must be skipped on borrowed context
      });
      await driver.tabNew();
      expect(routeSpy).toHaveBeenCalledTimes(0);
      expect(addInitScriptSpy).toHaveBeenCalledTimes(0);
      await driver.dispose?.();
    } finally {
      (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
        original;
    }
  });

  test("driver-level private-address guard fires on borrowed context even without route() mutation", async () => {
    // Setup: wsEndpoint path with an existing context (borrowed), blockPrivateAddresses: true (default).
    const gotoSpy = mock(async () => undefined);
    const existingContext = {
      pages: () => [],
      newPage: async () => ({
        url: () => "about:blank",
        title: async () => "",
        on: () => {},
        goto: gotoSpy,
        close: async () => {},
      }),
      close: async () => {},
      addInitScript: async () => {},
      route: async () => {},
    };
    const fakeBrowser = {
      contexts: () => [existingContext],
      newContext: async () => {
        throw new Error("should not create new context");
      },
      close: async () => {},
    } as unknown as Browser;

    const original = chromium.connectOverCDP;
    (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
      (async () => fakeBrowser) as unknown as typeof chromium.connectOverCDP;

    try {
      const driver = createPlaywrightBrowserDriver({
        wsEndpoint: "ws://127.0.0.1:45678/x",
        // blockPrivateAddresses defaults to true.
      });

      // 1. Literal private IP — blocked.
      const result1 = await driver.navigate("http://127.0.0.1/admin");
      expect(result1.ok).toBe(false);
      if (!result1.ok) {
        expect(result1.error.code).toBe("PERMISSION");
      }

      // 2. localhost hostname — blocked.
      const result2 = await driver.navigate("http://localhost:8080/");
      expect(result2.ok).toBe(false);

      // 3. RFC1918 literal — blocked.
      const result3 = await driver.navigate("http://192.168.1.1/");
      expect(result3.ok).toBe(false);

      // Critical: page.goto was never called for any blocked URL.
      expect(gotoSpy).toHaveBeenCalledTimes(0);

      await driver.dispose?.();
    } finally {
      (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
        original;
    }
  });

  test("post-navigation redirect check catches public URL that redirected to private address", async () => {
    // Setup: page.goto() succeeds but page.url() returns a private-address URL
    // (simulates a server-side 30x redirect to localhost).
    const gotoSpy = mock(async () => undefined);
    let currentUrl = "https://example.com/";
    const existingContext = {
      pages: () => [],
      newPage: async () => ({
        url: () => currentUrl,
        title: async () => "",
        on: () => {},
        goto: async (target: string) => {
          // Simulate redirect: first goto to a public URL ends up at localhost.
          if (target === "https://example.com/") {
            currentUrl = "http://127.0.0.1/admin"; // hostile redirect target
          } else {
            currentUrl = target;
          }
          await gotoSpy();
        },
        close: async () => {},
      }),
      close: async () => {},
      addInitScript: async () => {},
      route: async () => {},
    };
    const fakeBrowser = {
      contexts: () => [existingContext],
      newContext: async () => {
        throw new Error("should not create new context");
      },
      close: async () => {},
    } as unknown as Browser;

    const original = chromium.connectOverCDP;
    (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
      (async () => fakeBrowser) as unknown as typeof chromium.connectOverCDP;

    try {
      const driver = createPlaywrightBrowserDriver({
        wsEndpoint: "ws://127.0.0.1:45678/x",
      });
      // Preflight passes (URL is public). Post-nav check rejects (url() is now 127.0.0.1).
      const result = await driver.navigate("https://example.com/");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PERMISSION");
      }
      // The page should have been parked at about:blank after the reject.
      // gotoSpy is called at least twice: once for the initial navigate, once for about:blank cleanup.
      expect(gotoSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      await driver.dispose?.();
    } finally {
      (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
        original;
    }
  });

  test("IPv6-mapped IPv4 literals like ::ffff:127.0.0.1 are blocked", async () => {
    const gotoSpy = mock(async () => undefined);
    const existingContext = {
      pages: () => [],
      newPage: async () => ({
        url: () => "about:blank",
        title: async () => "",
        on: () => {},
        goto: gotoSpy,
        close: async () => {},
      }),
      close: async () => {},
      addInitScript: async () => {},
      route: async () => {},
    };
    const fakeBrowser = {
      contexts: () => [existingContext],
      newContext: async () => {
        throw new Error("should not create new context");
      },
      close: async () => {},
    } as unknown as Browser;

    const original = chromium.connectOverCDP;
    (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
      (async () => fakeBrowser) as unknown as typeof chromium.connectOverCDP;

    try {
      const driver = createPlaywrightBrowserDriver({
        wsEndpoint: "ws://127.0.0.1:45678/x",
      });
      // IPv4-mapped IPv6 (::ffff:127.0.0.1) — standard bypass attempt.
      const r1 = await driver.navigate("http://[::ffff:127.0.0.1]/");
      expect(r1.ok).toBe(false);
      // IPv4-mapped IPv6 to RFC1918.
      const r2 = await driver.navigate("http://[::ffff:192.168.1.1]/");
      expect(r2.ok).toBe(false);
      // IPv6 link-local.
      const r3 = await driver.navigate("http://[fe80::1]/");
      expect(r3.ok).toBe(false);
      // IPv6 loopback.
      const r4 = await driver.navigate("http://[::1]/");
      expect(r4.ok).toBe(false);
      // None of these reached page.goto.
      expect(gotoSpy).toHaveBeenCalledTimes(0);
      await driver.dispose?.();
    } finally {
      (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
        original;
    }
  });

  test("driver-level guard is a no-op when blockPrivateAddresses: false is explicitly set", async () => {
    const gotoSpy = mock(async () => undefined);
    const existingContext = {
      pages: () => [],
      newPage: async () => ({
        url: () => "http://127.0.0.1/admin",
        title: async () => "",
        on: () => {},
        goto: gotoSpy,
        close: async () => {},
      }),
      close: async () => {},
      addInitScript: async () => {},
      route: async () => {},
    };
    const fakeBrowser = {
      contexts: () => [existingContext],
      newContext: async () => {
        throw new Error("should not create new context");
      },
      close: async () => {},
    } as unknown as Browser;

    const original = chromium.connectOverCDP;
    (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
      (async () => fakeBrowser) as unknown as typeof chromium.connectOverCDP;

    try {
      const driver = createPlaywrightBrowserDriver({
        wsEndpoint: "ws://127.0.0.1:45678/x",
        blockPrivateAddresses: false, // explicit opt-out
      });
      const result = await driver.navigate("http://127.0.0.1/admin");
      expect(result.ok).toBe(true);
      expect(gotoSpy).toHaveBeenCalledTimes(1);
      await driver.dispose?.();
    } finally {
      (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
        original;
    }
  });

  test("borrowed context: dispose() does NOT close caller-owned context", async () => {
    const contextCloseSpy = mock(async () => {});
    const browserCloseSpy = mock(async () => {});
    const existingContext = {
      pages: () => [],
      newPage: async () => ({
        url: () => "about:blank",
        title: async () => "",
        on: () => {},
        close: async () => {},
      }),
      close: contextCloseSpy,
      addInitScript: async () => {},
      route: async () => {},
    };
    const fakeBrowser = {
      contexts: () => [existingContext],
      newContext: async () => {
        throw new Error("should not create new context");
      },
      close: browserCloseSpy,
    } as unknown as Browser;

    const original = chromium.connectOverCDP;
    (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
      (async () => fakeBrowser) as unknown as typeof chromium.connectOverCDP;

    try {
      const driver = createPlaywrightBrowserDriver({
        wsEndpoint: "ws://127.0.0.1:45678/x",
        blockPrivateAddresses: false,
      });
      await driver.tabNew();
      await driver.dispose?.();
      // Neither the borrowed context nor the external browser should be closed.
      expect(contextCloseSpy).toHaveBeenCalledTimes(0);
      expect(browserCloseSpy).toHaveBeenCalledTimes(0);
    } finally {
      (chromium as unknown as { connectOverCDP: typeof chromium.connectOverCDP }).connectOverCDP =
        original;
    }
  });
});
