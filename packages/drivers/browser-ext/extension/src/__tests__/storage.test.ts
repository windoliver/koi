import { beforeEach, describe, expect, test } from "bun:test";
import { createExtensionStorage } from "../storage.js";
import { installChromeStub } from "./chrome-stub.js";

describe("extension storage", () => {
  beforeEach(() => {
    installChromeStub();
  });

  test("returns defaults for missing or invalid values", async () => {
    const controller = installChromeStub();
    controller.localState["koi.alwaysGrants"] = "bad-shape";

    const storage = createExtensionStorage();
    const local = await storage.getLocalState();
    const session = await storage.getSessionState();

    expect(local.alwaysGrants).toEqual({});
    expect(local.extensionName).toBe("default");
    expect(session.allowOnceGrants).toEqual({});
  });

  test("writes and reads allow_once and always grants", async () => {
    const storage = createExtensionStorage();

    await storage.grantAllowOnce(42, "doc-1", "https://example.com");
    await storage.setAlwaysGrant("https://example.com", "2026-04-20T00:00:00.000Z");

    expect(await storage.hasAllowOnceGrant(42, "doc-1")).toBe(true);
    expect(await storage.getAlwaysGrants()).toEqual({
      "https://example.com": { grant: "always", grantedAt: "2026-04-20T00:00:00.000Z" },
    });
  });

  test("increments boot counter and seeds identities", async () => {
    const storage = createExtensionStorage();

    expect(await storage.incrementHostBootCounter()).toBe(1);
    expect(await storage.incrementHostBootCounter()).toBe(2);
    expect(await storage.getInstanceId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(await storage.getBrowserSessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
