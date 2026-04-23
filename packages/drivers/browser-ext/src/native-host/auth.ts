import { constants, type Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_AUTH_DIR: string = join(homedir(), ".koi", "browser-ext");

async function readSecretFile(path: string): Promise<string> {
  let st: Stats;
  try {
    st = await stat(path);
  } catch (cause) {
    throw new Error(`Auth: secret file ${path} not readable`, { cause });
  }
  if ((st.mode & (constants.S_IRWXG | constants.S_IRWXO)) !== 0) {
    throw new Error(
      `Auth: secret file ${path} has insecure mode ${(st.mode & 0o777).toString(8)}, required 0600`,
    );
  }
  const content = (await readFile(path, "utf-8")).trim();
  if (content.length === 0) {
    throw new Error(`Auth: secret file ${path} is empty`);
  }
  return content;
}

export async function readToken(dir: string = DEFAULT_AUTH_DIR): Promise<string> {
  return readSecretFile(join(dir, "token"));
}

export async function readAdminKey(dir: string = DEFAULT_AUTH_DIR): Promise<string> {
  return readSecretFile(join(dir, "admin.key"));
}

export interface HelloValidationInput {
  readonly token: string;
  readonly admin?: { readonly adminKey: string } | undefined;
}

export type HelloValidationResult =
  | { readonly ok: true; readonly role: "driver" | "admin" }
  | {
      readonly ok: false;
      readonly reason: "bad_token" | "bad_admin_key";
    };

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function validateHello(
  hello: HelloValidationInput,
  expected: { readonly token: string; readonly adminKey: string | null },
): HelloValidationResult {
  if (!timingSafeEqual(hello.token, expected.token)) {
    return { ok: false, reason: "bad_token" };
  }
  if (hello.admin) {
    // Fail-closed: if the host has no admin key material (file missing /
    // unreadable), reject all admin-role hellos rather than degrading to
    // an empty-string comparison.
    if (expected.adminKey === null) {
      return { ok: false, reason: "bad_admin_key" };
    }
    if (!timingSafeEqual(hello.admin.adminKey, expected.adminKey)) {
      return { ok: false, reason: "bad_admin_key" };
    }
    return { ok: true, role: "admin" };
  }
  return { ok: true, role: "driver" };
}
