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
  test("wsEndpoint calls chromium.connectOverCDP with { wsEndpoint }", async () => {
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
      // connectOverCDP is called with an object containing wsEndpoint (and timeout).
      expect(firstArg).toEqual(
        expect.objectContaining({ wsEndpoint: "ws://127.0.0.1:45678/devtools/browser/abcd" }),
      );

      await driver.dispose?.();
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

      // @ts-expect-error — bun:test mock.calls typing reports empty tuple; runtime has entries
      const firstArg: unknown = connectSpy.mock.calls[0]?.[0];
      // Must be called with wsEndpoint, not cdpEndpoint string.
      expect(firstArg).toEqual(expect.objectContaining({ wsEndpoint: "ws://127.0.0.1:45678/x" }));
      // Ensure the cdpEndpoint string was NOT used as the first arg.
      expect(typeof firstArg).toBe("object");
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
