/**
 * Temporary directory helpers for tests.
 *
 * Creates unique temp dirs for test isolation and ensures cleanup.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a unique temporary directory prefixed with "koi-test-".
 * Caller is responsible for cleanup (use `withTempDir` for auto-cleanup).
 */
export async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "koi-test-"));
}

/**
 * Creates a koi.yaml manifest file in the given directory.
 *
 * @param dir - Target directory
 * @param content - YAML content (defaults to a minimal valid manifest)
 * @param filename - Filename (defaults to "koi.yaml")
 * @returns Absolute path to the created file
 */
export async function createManifestFile(
  dir: string,
  content?: string,
  filename?: string,
): Promise<string> {
  const name = filename ?? "koi.yaml";
  const yaml =
    content ??
    `name: test-agent
version: "1.0.0"
model: "anthropic:claude-sonnet-4-5-20250929"
`;
  const filePath = join(dir, name);
  await Bun.write(filePath, yaml);
  return filePath;
}

/**
 * Runs a callback with a fresh temp directory, cleaning up afterwards.
 *
 * @param fn - Callback receiving the temp dir path
 */
export async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
