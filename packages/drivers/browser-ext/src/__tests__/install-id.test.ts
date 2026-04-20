import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateInstallId, readInstallId } from "../native-host/install-id.js";

describe("installId", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "koi-install-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("generate → read yields same value", async () => {
    const id = await generateInstallId(dir);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const read = await readInstallId(dir);
    expect(read).toBe(id);
  });

  test("generates 64-hex-char installId", async () => {
    const id = await generateInstallId(dir);
    expect(id.length).toBe(64);
  });

  test("read missing file throws", async () => {
    await expect(readInstallId(dir)).rejects.toThrow(/not readable/);
  });

  test("read malformed file throws", async () => {
    await writeFile(join(dir, "installId"), "xyz", { mode: 0o600 });
    await expect(readInstallId(dir)).rejects.toThrow(/malformed/);
  });

  test("two generate calls produce different IDs", async () => {
    const a = await generateInstallId(dir);
    const b = await generateInstallId(dir);
    expect(a).not.toBe(b);
  });
});
