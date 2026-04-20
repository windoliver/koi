import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplexPair } from "node:stream";

import { createExtensionBrowserDriver } from "../driver.js";
import { writeDiscoveryFile } from "../native-host/discovery.js";
import { createFrameReader } from "../native-host/frame-reader.js";
import { createFrameWriter } from "../native-host/frame-writer.js";

describe("createExtensionBrowserDriver", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "koi-browser-ext-driver-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("tabList discovers the host, performs hello, and returns tabs", async () => {
    const socketPath = join(dir, "driver.sock");
    const token = "1234567890abcdef";
    await writeFile(socketPath, "");
    const [clientSide, serverSide] = duplexPair();
    const writer = createFrameWriter(serverSide);
    void (async () => {
      try {
        for await (const payload of createFrameReader(serverSide)) {
          const frame = JSON.parse(payload) as { readonly kind: string };
          if (frame.kind === "hello") {
            await writer.write(
              JSON.stringify({
                kind: "hello_ack",
                ok: true,
                role: "driver",
                hostVersion: "0.1.0",
                extensionVersion: "0.1.0",
                wsEndpoint: "ws://ignored",
                selectedProtocol: 1,
              }),
            );
          }
          if (frame.kind === "list_tabs") {
            await writer.write(
              JSON.stringify({
                kind: "tabs",
                tabs: [{ id: 42, url: "about:blank", title: "Test tab" }],
              }),
            );
          }
        }
      } catch {}
    })();

    await writeDiscoveryFile(dir, {
      instanceId: "11111111-1111-1111-1111-111111111111",
      pid: process.pid,
      socket: socketPath,
      ready: true,
      name: "personal",
      browserHint: "Google Chrome",
      extensionVersion: "0.1.0",
      epoch: 1,
      seq: 1,
    });
    await writeFile(join(dir, "token"), token);

    const driver = createExtensionBrowserDriver({
      instancesDir: dir,
      authToken: token,
      connectSocketFactory: (socket) => {
        if (socket !== socketPath) {
          throw new Error(`unexpected socket ${socket}`);
        }
        return clientSide;
      },
    });

    const result = await driver.tabList();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toEqual([{ tabId: "42", url: "about:blank", title: "Test tab" }]);

    await driver.dispose?.();
    serverSide.destroy();
  });

  test("non-tabList operations return a clear error when no playwrightDriver is supplied", () => {
    const driver = createExtensionBrowserDriver({
      instancesDir: dir,
      authToken: "1234567890abcdef",
    });
    const result = driver.snapshot() as Awaited<ReturnType<typeof driver.snapshot>>;
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.message).toMatch(/playwrightDriver/);
  });
});
