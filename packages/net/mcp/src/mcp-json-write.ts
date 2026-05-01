/**
 * Write helpers for `.mcp.json`.
 *
 * Atomic write (`tmp + rename`). Preserves unknown top-level fields so that
 * tools cooperating with Koi (custom settings, $schema annotations) survive
 * round-trips through `koi mcp install/uninstall`.
 */

import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { KoiError, Result } from "@koi/core";
import type { ExternalServerConfig, McpJsonConfig } from "./config.js";

export interface AddServerOptions {
  readonly overwrite?: boolean;
}

export async function saveMcpJsonFile(
  filePath: string,
  config: McpJsonConfig,
): Promise<Result<void, KoiError>> {
  return saveJsonAtomic(filePath, config);
}

export async function addServerToMcpJson(
  filePath: string,
  name: string,
  entry: ExternalServerConfig,
  options: AddServerOptions = {},
): Promise<Result<void, KoiError>> {
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
}

export async function removeServerFromMcpJson(
  filePath: string,
  name: string,
): Promise<Result<void, KoiError>> {
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
