/**
 * Shared factory for browser ref-action tools (click, hover, type, press, scroll).
 *
 * All ref-action tools share the same arg-parsing skeleton:
 *   - required ref (or key for press / no ref for press)
 *   - optional snapshotId
 *   - optional timeout within [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS]
 *   - optional extra args per tool
 *
 * Using this factory eliminates the duplicated constants and boilerplate
 * that appeared identically in v1's click, hover, type, press, scroll.
 */

import type { BrowserDriver, JsonObject, KoiError, Tool, ToolPolicy } from "@koi/core";
import type { ParseResult } from "./parse-args.js";
import { parseOptionalSnapshotId, parseOptionalTimeout, parseRef } from "./parse-args.js";

export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 10_000;

export interface RefActionConfig {
  /** Full tool name with prefix, e.g. "browser_click". */
  readonly name: string;
  readonly description: string;
  /** Extra JSON Schema properties beyond ref/snapshotId/timeout. */
  readonly extraInputSchema?: Record<string, unknown>;
  /** Required input schema keys beyond the common ones. */
  readonly extraRequired?: readonly string[];
  /** Parse extra args beyond the common ref/snapshotId/timeout. Returns null if no extras. */
  readonly extraArgParsers?: (args: JsonObject) => ParseResult<Record<string, unknown>> | null;
  readonly driver: BrowserDriver;
  readonly policy: ToolPolicy;
  /** Execute the action given the parsed common args plus any extra args. */
  readonly execute: (
    driver: BrowserDriver,
    ref: string,
    snapshotId: string | undefined,
    timeout: number | undefined,
    extraArgs: Record<string, unknown>,
  ) => Promise<{ ok: true } | { ok: false; error: KoiError }>;
}

export function createRefActionTool(config: RefActionConfig): Tool {
  const {
    name,
    description,
    extraInputSchema,
    extraRequired,
    extraArgParsers,
    driver,
    policy,
    execute,
  } = config;

  const baseProperties: Record<string, unknown> = {
    ref: {
      type: "string",
      description: 'Ref key from browser_snapshot output (e.g., "e1", "e42")',
    },
    snapshotId: {
      type: "string",
      description: "snapshotId from the last browser_snapshot call (recommended)",
    },
    timeout: {
      type: "number",
      description: `Action timeout in ms (default: 3000, max: ${MAX_TIMEOUT_MS})`,
    },
  };

  const inputSchema: JsonObject = {
    type: "object",
    properties: { ...baseProperties, ...(extraInputSchema ?? {}) },
    required: ["ref", ...(extraRequired ?? [])],
  };

  return {
    descriptor: { name, description, inputSchema },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const refResult = parseRef(args, "ref");
      if (!refResult.ok) return refResult.err;

      const snapshotIdResult = parseOptionalSnapshotId(args, "snapshotId");
      if (!snapshotIdResult.ok) return snapshotIdResult.err;

      const timeoutResult = parseOptionalTimeout(args, "timeout", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
      if (!timeoutResult.ok) return timeoutResult.err;

      let extraArgs: Record<string, unknown> = {};
      if (extraArgParsers !== null && extraArgParsers !== undefined) {
        const extraResult = extraArgParsers(args);
        if (extraResult !== null) {
          if (!extraResult.ok) return extraResult.err;
          extraArgs = extraResult.value;
        }
      }

      const result = await execute(
        driver,
        refResult.value,
        snapshotIdResult.value,
        timeoutResult.value,
        extraArgs,
      );
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return { success: true };
    },
  };
}
