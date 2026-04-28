import { describe, expect, test } from "bun:test";
import { createAttachFsm } from "../attach-fsm.js";
import { createNativeConnection } from "../connect-native.js";
import { createConsentManager } from "../consent.js";
import { createExtensionStorage } from "../storage.js";
import { createMockPort, installChromeStub } from "./chrome-stub.js";

async function waitFor(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("connect-native", () => {
  test("sends extension_hello and single-flights concurrent connects", async () => {
    const controller = installChromeStub();
    const port = createMockPort("com.koi.browser_ext");
    let connectCount = 0;
    controller.runtime.connectNativeImpl = () => {
      connectCount += 1;
      return port;
    };

    const storage = createExtensionStorage();
    const consent = createConsentManager(storage);
    const sentFrames: unknown[] = [];
    const fsm = createAttachFsm({
      storage,
      consent,
      sendFrame: (frame) => sentFrames.push(frame),
    });

    const connection = createNativeConnection({
      storage,
      fsm,
      epoch: 1,
      onFrame: () => undefined,
    });

    await Promise.all([connection.ensureConnected(), connection.ensureConnected()]);
    expect(connectCount).toBe(1);
    expect(port.postMessageCalls[0]).toMatchObject({
      kind: "extension_hello",
      extensionId: "test-extension-id",
      epoch: 1,
      seq: 1,
    });
    expect(sentFrames).toHaveLength(0);
  });

  test("installId mismatch wipes grants before ready", async () => {
    const controller = installChromeStub();
    const port = createMockPort("com.koi.browser_ext");
    controller.runtime.connectNativeImpl = () => port;

    const storage = createExtensionStorage();
    await storage.setAlwaysGrant("https://example.com", "2026-04-20T00:00:00.000Z");
    await storage.setPrivateOriginAllowlist(["http://localhost:3000"]);
    await storage.grantAllowOnce(42, "doc-1", "https://example.com");
    await storage.setInstallId("a".repeat(64));

    const connection = createNativeConnection({
      storage,
      fsm: createAttachFsm({
        storage,
        consent: createConsentManager(storage),
        sendFrame: () => undefined,
      }),
      epoch: 1,
      onFrame: () => undefined,
    });

    await connection.ensureConnected();
    port.onMessage.emit({
      kind: "host_hello",
      hostVersion: "0.1.0",
      installId: "b".repeat(64),
      selectedProtocol: 1,
    });
    await waitFor(() => connection.isPortReady());

    expect(await storage.getAlwaysGrants()).toEqual({});
    expect(await storage.getPrivateOriginAllowlist()).toEqual([]);
    expect(await storage.getAllowOnceGrants()).toEqual({});
    expect(connection.isPortReady()).toBe(true);
  });
});
