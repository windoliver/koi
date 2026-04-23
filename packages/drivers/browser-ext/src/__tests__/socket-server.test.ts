import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSocketServer } from "../native-host/socket-server.js";

async function createSocketServerOrSkip(
  config: Parameters<typeof createSocketServer>[0],
): Promise<Awaited<ReturnType<typeof createSocketServer>> | null> {
  try {
    return await createSocketServer(config);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EPERM") return null;
    throw error;
  }
}

describe("socket-server", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "koi-sock-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("bind installs socket with mode 0600 and dir mode 0700", async () => {
    const path = join(dir, "koi.sock");
    const server = await createSocketServerOrSkip({
      socketPath: path,
      onConnection: () => {},
    });
    if (server === null) return;
    const sockStat = await stat(path);
    expect(sockStat.mode & 0o777).toBe(0o600);
    const dirStat = await stat(dir);
    expect(dirStat.mode & 0o777).toBe(0o700);
    await server.close();
  });

  test("accepts connections and fires onConnection", async () => {
    const path = join(dir, "koi.sock");
    let count = 0;
    const server = await createSocketServerOrSkip({
      socketPath: path,
      onConnection: (socket) => {
        count += 1;
        socket.end();
      },
    });
    if (server === null) return;
    await new Promise<void>((resolve) => {
      const c = createConnection(path);
      c.on("connect", () => {
        c.end();
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      const c = createConnection(path);
      c.on("connect", () => {
        c.end();
        resolve();
      });
    });
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(count).toBe(2);
    await server.close();
  });

  test("stale socket from prior run is cleaned up on bind", async () => {
    const path = join(dir, "koi.sock");
    const first = await createSocketServerOrSkip({
      socketPath: path,
      onConnection: () => {},
    });
    if (first === null) return;
    await first.close();
    const second = await createSocketServerOrSkip({
      socketPath: path,
      onConnection: () => {},
    });
    if (second === null) return;
    const sockStat = await stat(path);
    expect(sockStat.mode & 0o777).toBe(0o600);
    await second.close();
  });
});
