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
});
