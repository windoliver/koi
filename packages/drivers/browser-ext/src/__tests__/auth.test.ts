import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readAdminKey, readToken, validateHello } from "../native-host/auth.js";

describe("auth", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "koi-auth-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("readToken returns content when mode is 0600", async () => {
    const path = join(dir, "token");
    await writeFile(path, "s".repeat(64), { mode: 0o600 });
    await chmod(path, 0o600);
    expect(await readToken(dir)).toBe("s".repeat(64));
  });

  test("readToken throws when mode is too open", async () => {
    const path = join(dir, "token");
    await writeFile(path, "s".repeat(64));
    await chmod(path, 0o644);
    await expect(readToken(dir)).rejects.toThrow(/insecure mode/);
  });

  test("readToken throws when file missing", async () => {
    await expect(readToken(dir)).rejects.toThrow(/not readable/);
  });

  test("readAdminKey works analogously", async () => {
    const path = join(dir, "admin.key");
    await writeFile(path, "a".repeat(64), { mode: 0o600 });
    await chmod(path, 0o600);
    expect(await readAdminKey(dir)).toBe("a".repeat(64));
  });

  test("validateHello: matching token → driver role", () => {
    const r = validateHello(
      { token: "t".repeat(64) },
      { token: "t".repeat(64), adminKey: "a".repeat(64) },
    );
    expect(r).toEqual({ ok: true, role: "driver" });
  });

  test("validateHello: bad token → bad_token", () => {
    const r = validateHello(
      { token: "x".repeat(64) },
      { token: "t".repeat(64), adminKey: "a".repeat(64) },
    );
    expect(r).toEqual({ ok: false, reason: "bad_token" });
  });

  test("validateHello: good token + admin key → admin role", () => {
    const r = validateHello(
      { token: "t".repeat(64), admin: { adminKey: "a".repeat(64) } },
      { token: "t".repeat(64), adminKey: "a".repeat(64) },
    );
    expect(r).toEqual({ ok: true, role: "admin" });
  });

  test("validateHello: good token + bad admin → bad_admin_key", () => {
    const r = validateHello(
      { token: "t".repeat(64), admin: { adminKey: "z".repeat(64) } },
      { token: "t".repeat(64), adminKey: "a".repeat(64) },
    );
    expect(r).toEqual({ ok: false, reason: "bad_admin_key" });
  });
});
