/**
 * Write helpers for `.mcp.json`.
 *
 * Atomic write (`tmp + rename`). Preserves unknown top-level fields so that
 * tools cooperating with Koi (custom settings, $schema annotations) survive
 * round-trips through `koi mcp install/uninstall`.
 */

import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { KoiError, Result } from "@koi/core";
import type { ExternalServerConfig, McpJsonConfig } from "./config.js";

export interface AddServerOptions {
  readonly overwrite?: boolean;
}

export async function saveMcpJsonFile(
  filePath: string,
  config: McpJsonConfig,
): Promise<Result<void, KoiError>> {
  return withFileLock(filePath, () => saveJsonAtomic(filePath, config));
}

export async function addServerToMcpJson(
  filePath: string,
  name: string,
  entry: ExternalServerConfig,
  options: AddServerOptions = {},
): Promise<Result<void, KoiError>> {
  return withFileLock(filePath, async () => {
    const file = await readMcpJsonRaw(filePath);
    if (!file.ok) return file;

    const current = file.value;
    const servers = (current.mcpServers ?? {}) as Record<string, ExternalServerConfig>;
    if (servers[name] !== undefined && options.overwrite !== true) {
      return {
        ok: false,
        error: {
          code: "CONFLICT",
          message: `MCP server "${name}" is already configured in ${filePath}`,
          retryable: false,
          context: { filePath, name },
        },
      };
    }

    const next = { ...current, mcpServers: { ...servers, [name]: entry } };
    return saveJsonAtomic(filePath, next as McpJsonConfig);
  });
}

export async function removeServerFromMcpJson(
  filePath: string,
  name: string,
): Promise<Result<void, KoiError>> {
  return withFileLock(filePath, async () => {
    const file = await readMcpJsonRaw(filePath);
    if (!file.ok) {
      // Surface absent-file as NOT_FOUND for the named server (uninstall is idempotent at the CLI layer).
      if (file.error.code === "NOT_FOUND") {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `MCP server "${name}" is not configured (file ${filePath} does not exist)`,
            retryable: false,
            context: { filePath, name },
          },
        };
      }
      return file;
    }

    const current = file.value;
    const servers = (current.mcpServers ?? {}) as Record<string, ExternalServerConfig>;
    if (servers[name] === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `MCP server "${name}" is not configured in ${filePath}`,
          retryable: false,
          context: { filePath, name },
        },
      };
    }

    const { [name]: _removed, ...rest } = servers;
    const next = { ...current, mcpServers: rest };
    return saveJsonAtomic(filePath, next as McpJsonConfig);
  });
}

async function readMcpJsonRaw(
  filePath: string,
): Promise<
  Result<Record<string, unknown> & { mcpServers?: Record<string, ExternalServerConfig> }, KoiError>
> {
  try {
    const text = await Bun.file(filePath).text();
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed === null || typeof parsed !== "object") {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `${filePath} did not contain a JSON object`,
            retryable: false,
            context: { filePath },
          },
        };
      }
      return { ok: true, value: parsed as Record<string, unknown> };
    } catch (parseError: unknown) {
      const detail = parseError instanceof Error ? parseError.message : String(parseError);
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Invalid JSON in ${filePath}: ${detail}`,
          retryable: false,
          cause: parseError instanceof Error ? parseError : undefined,
          context: { filePath },
        },
      };
    }
  } catch (error: unknown) {
    const errCode =
      error !== null && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
    if (errCode === "ENOENT" || errCode === "ENOTDIR") {
      // Treat as fresh file — return empty config.
      return { ok: true, value: { mcpServers: {} } };
    }
    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: `Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
        cause: error instanceof Error ? error : undefined,
        context: { filePath },
      },
    };
  }
}

async function saveJsonAtomic(filePath: string, value: unknown): Promise<Result<void, KoiError>> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = join(
      dirname(filePath),
      `.${basenameOf(filePath)}.tmp-${process.pid}-${Date.now()}`,
    );
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      await rename(tmp, filePath);
    } catch (error: unknown) {
      // Best-effort cleanup of stray tmp on rename failure.
      await unlink(tmp).catch(() => {});
      throw error;
    }
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: `Failed to write ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
        cause: error instanceof Error ? error : undefined,
        context: { filePath },
      },
    };
  }
}

function basenameOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

/**
 * Cross-process advisory lock around mutations to a single `.mcp.json` file.
 *
 * Uses an `O_EXCL` lockfile sibling (`<file>.lock`). Concurrent
 * `koi mcp install`/`uninstall` invocations against the same repo coordinate
 * via this lock so the read-modify-rename cycle is serialized — without it,
 * two writers can race and silently lose entries.
 *
 * The lock is best-effort: a stale lock older than `STALE_LOCK_MS` (held by a
 * crashed process) is forcibly reclaimed. The lock file holds the owner's PID
 * for diagnostics.
 */
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_MAX_RETRIES = 200; // ~10s total wait
const STALE_LOCK_MS = 30_000;

async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<Result<T, KoiError>>,
): Promise<Result<T, KoiError>> {
  const lockPath = `${filePath}.lock`;
  await mkdir(dirname(filePath), { recursive: true }).catch(() => {});

  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } finally {
        await handle.close();
      }
      try {
        return await fn();
      } finally {
        await unlink(lockPath).catch(() => {});
      }
    } catch (error: unknown) {
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "";
      if (code !== "EEXIST") {
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: `Failed to acquire lock at ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
            retryable: false,
            cause: error instanceof Error ? error : undefined,
            context: { lockPath },
          },
        };
      }
      // Lock held — check for staleness, then back off.
      if (await reapStaleLock(lockPath)) continue;
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  return {
    ok: false,
    error: {
      code: "TIMEOUT",
      message: `Timed out waiting for lock on ${filePath} (held by another koi mcp process?)`,
      retryable: true,
      context: { lockPath },
    },
  };
}

async function reapStaleLock(lockPath: string): Promise<boolean> {
  try {
    const stat = await Bun.file(lockPath).stat();
    if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
      await unlink(lockPath).catch(() => {});
      return true;
    }
  } catch {
    // Lock file vanished between EEXIST and stat — caller should retry.
    return true;
  }
  return false;
}
