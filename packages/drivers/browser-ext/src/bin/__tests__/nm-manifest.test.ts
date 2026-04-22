import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getBrowserInstallTargets } from "../browsers.js";
import {
  readNativeMessagingManifests,
  removeNativeMessagingManifests,
  writeNativeMessagingManifests,
} from "../nm-manifest.js";

describe("nm-manifest", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "koi-browser-ext-manifest-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes manifests for each browser target", async () => {
    const targets = getBrowserInstallTargets("linux", dir);
    const result = await writeNativeMessagingManifests({
      targets,
      wrapperPath: "/tmp/native-host",
      allowedOrigins: ["chrome-extension://dev-id/"],
    });

    expect(result).toHaveLength(5);
    const firstResult = result[0];
    expect(firstResult).toBeDefined();
    if (firstResult === undefined) {
      return;
    }
    const manifest = JSON.parse(await readFile(firstResult.path, "utf8")) as {
      readonly path: string;
      readonly allowed_origins: readonly string[];
    };
    expect(manifest.path).toBe("/tmp/native-host");
    expect(manifest.allowed_origins).toEqual(["chrome-extension://dev-id/"]);
  });

  test("read and remove round-trip", async () => {
    const targets = getBrowserInstallTargets("linux", dir);
    await writeNativeMessagingManifests({
      targets,
      wrapperPath: "/tmp/native-host",
      allowedOrigins: ["chrome-extension://dev-id/"],
    });

    const read = await readNativeMessagingManifests(targets);
    expect(read.every((entry) => entry.present)).toBe(true);

    await removeNativeMessagingManifests(targets);
    const removed = await readNativeMessagingManifests(targets);
    expect(removed.every((entry) => entry.present === false)).toBe(true);
  });
});
