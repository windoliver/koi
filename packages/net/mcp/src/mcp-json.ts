/**
 * .mcp.json file loader — reads CC-compatible MCP server configuration.
 *
 * Pipeline: file read → JSON parse → external schema validation →
 * normalization (CC type → Koi kind, env expansion) → internal configs.
 */

import type { KoiError, Result } from "@koi/core";
import type { McpServerConfig, NormalizeResult } from "./config.js";
import { normalizeMcpServers, validateMcpJson } from "./config.js";

/**
 * Loads and parses a `.mcp.json` file from the given path.
 *
 * Returns normalized Koi server configs. Unsupported transport types
 * (ws, sdk, etc.) are silently filtered — available in the `unsupported`
 * list for logging.
 */
export async function loadMcpJsonFile(
  filePath: string,
): Promise<
  Result<
    { readonly servers: readonly McpServerConfig[]; readonly unsupported: readonly string[] },
    KoiError
  >
> {
  let raw: string;
  try {
    raw = await Bun.file(filePath).text();
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Failed to read .mcp.json at "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
        context: { filePath },
      },
    };
  }

  return loadMcpJsonString(raw);
}

/**
 * Parses a JSON string as `.mcp.json` config.
 * Useful for manifest embedding or testing.
 */
export function loadMcpJsonString(json: string): Result<NormalizeResult, KoiError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid JSON in .mcp.json: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
      },
    };
  }

  const validated = validateMcpJson(parsed);
  if (!validated.ok) return validated;

  return { ok: true, value: normalizeMcpServers(validated.value.mcpServers) };
}
