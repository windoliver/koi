import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readAdminKey, readToken } from "../native-host/index.js";

export interface AuthFileStatus {
  readonly path: string;
  readonly present: boolean;
  readonly mode: string | null;
  readonly secure: boolean;
}

export interface AuthFilesResult {
  readonly token: string;
  readonly adminKey: string;
  readonly tokenPath: string;
  readonly adminKeyPath: string;
}

function secretValue(): string {
  return randomBytes(32).toString("hex");
}

async function writeSecret(path: string, value: string): Promise<void> {
  await writeFile(path, `${value}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function generateAuthFiles(dir: string): Promise<AuthFilesResult> {
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const tokenPath = join(dir, "token");
  const adminKeyPath = join(dir, "admin.key");
  await writeSecret(tokenPath, secretValue());
  await writeSecret(adminKeyPath, secretValue());

  return {
    token: await readToken(dir),
    adminKey: await readAdminKey(dir),
    tokenPath,
    adminKeyPath,
  };
}

export async function wipeAuthFiles(dir: string): Promise<void> {
  await Promise.all([
    rm(join(dir, "token"), { force: true }),
    rm(join(dir, "admin.key"), { force: true }),
    rm(join(dir, "installId"), { force: true }),
  ]);
}

export async function statSecretFile(path: string): Promise<AuthFileStatus> {
  try {
    const st = await stat(path);
    const mode = (st.mode & 0o777).toString(8).padStart(3, "0");
    return {
      path,
      present: true,
      mode,
      secure: mode === "600",
    };
  } catch {
    return {
      path,
      present: false,
      mode: null,
      secure: false,
    };
  }
}
