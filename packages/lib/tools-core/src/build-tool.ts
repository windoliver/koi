/**
 * buildTool() — Factory that validates a ToolDefinition and produces an L0 Tool.
 *
 * Maps coarse capability flags (sandbox, network, filesystem) into the
 * ToolPolicy structure, defaulting to sandboxed execution.
 */

import type { KoiError, Result, Tool, ToolCapabilities, ToolPolicy } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";
import { deepFreeze } from "./deep-freeze.js";
import type { ToolDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/** Absolute path: non-empty, starts with /, no .. segments. */
const absolutePath = z
  .string()
  .min(1, "Path must not be empty")
  .refine((p) => p.startsWith("/"), "Path must be absolute (start with /)")
  .refine((p) => !/(^|\/)\.\.(\/|$)/.test(p), "Path must not contain '..' traversal segments");

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

/**
 * Recursive JSON value — rejects functions, Symbols, Dates, class instances,
 * and other non-serializable values that would break model API serialization.
 */
const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), jsonObject]),
);
const jsonObject: z.ZodType<Record<string, unknown>> = z.record(z.string(), jsonValue);

/**
 * inputSchema must be a JSON Schema object containing only JSON-safe values.
 * Accepts empty `{}` for compatibility. If `type` is present it must be a string.
 */
const jsonSchemaObject = jsonObject.refine((s) => !("type" in s) || typeof s.type === "string", {
  message: 'inputSchema.type must be a string when present (e.g. { type: "object" })',
});

const toolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  inputSchema: jsonSchemaObject,
  tags: z.array(z.string()).optional(),
  origin: z.enum(["primordial", "operator", "forged"]),
  sandbox: z.boolean().optional(),
  network: z.boolean().optional(),
  filesystem: z
    .object({
      read: z.array(absolutePath).optional(),
      write: z.array(absolutePath).optional(),
    })
    .optional(),
  execute: z.function(),
});

// ---------------------------------------------------------------------------
// Policy mapping
// ---------------------------------------------------------------------------

/** Strip trailing slash (except root "/"). */
function normalizePath(p: string): string {
  return p !== "/" && p.endsWith("/") ? p.slice(0, -1) : p;
}

function normalizePaths(paths: readonly string[]): readonly string[] {
  return paths.map(normalizePath);
}

/** Iterative cycle detection. DAGs (shared refs) are allowed; true cycles are not. */
function hasCycle(root: unknown): boolean {
  if (root === null || typeof root !== "object") return false;
  // Each frame: [object, child-values iterator, whether we pushed to ancestors]
  const ancestors = new Set<unknown>();
  const worklist: { obj: unknown; iter: Iterator<unknown> }[] = [];
  ancestors.add(root);
  worklist.push({ obj: root, iter: childIterator(root) });

  while (worklist.length > 0) {
    const frame = worklist.pop();
    if (frame === undefined) break;
    const next = frame.iter.next();
    if (next.done) {
      ancestors.delete(frame.obj);
      continue;
    }
    // Re-push current frame since it has more children
    worklist.push(frame);
    const child = next.value;
    if (child === null || typeof child !== "object") continue;
    if (ancestors.has(child)) return true;
    ancestors.add(child);
    worklist.push({ obj: child, iter: childIterator(child) });
  }
  return false;
}

function childIterator(obj: unknown): Iterator<unknown> {
  const values = Array.isArray(obj) ? obj : Object.values(obj as Record<string, unknown>);
  return values[Symbol.iterator]();
}

/** Deduplicate paths preserving order. */
function uniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}

/** Deep-clone a ToolCapabilities object so nested objects are not shared. */
function cloneCapabilities(caps: ToolCapabilities): ToolCapabilities {
  return {
    ...(caps.network !== undefined ? { network: { ...caps.network } } : {}),
    ...(caps.filesystem !== undefined
      ? {
          filesystem: {
            ...(caps.filesystem.read !== undefined ? { read: [...caps.filesystem.read] } : {}),
            ...(caps.filesystem.write !== undefined ? { write: [...caps.filesystem.write] } : {}),
          },
        }
      : {}),
    ...(caps.resources !== undefined ? { resources: { ...caps.resources } } : {}),
  };
}

function mapPolicy(def: ToolDefinition): ToolPolicy {
  const sandboxed = def.sandbox !== false;
  const base: ToolPolicy = sandboxed ? DEFAULT_SANDBOXED_POLICY : DEFAULT_UNSANDBOXED_POLICY;

  const hasNetworkOverride = def.network !== undefined;
  const hasFilesystemOverride = def.filesystem !== undefined;

  if (!hasNetworkOverride && !hasFilesystemOverride) {
    return { sandbox: base.sandbox, capabilities: cloneCapabilities(base.capabilities) };
  }

  const cloned = cloneCapabilities(base.capabilities);
  const capabilities: ToolCapabilities = {
    ...cloned,
    ...(hasNetworkOverride ? { network: { allow: def.network === true } } : {}),
    ...(hasFilesystemOverride
      ? {
          filesystem: {
            read: uniquePaths([
              ...(cloned.filesystem?.read ?? []),
              ...(def.filesystem?.read !== undefined ? normalizePaths(def.filesystem.read) : []),
            ]),
            write: uniquePaths([
              ...(cloned.filesystem?.write ?? []),
              ...(def.filesystem?.write !== undefined ? normalizePaths(def.filesystem.write) : []),
            ]),
          },
        }
      : {}),
  };

  return { sandbox: base.sandbox, capabilities };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build an L0 Tool from a rich ToolDefinition.
 *
 * Validates the definition and maps coarse capability flags into ToolPolicy.
 * Returns `Result<Tool, KoiError>` — never throws.
 */
export function buildTool(definition: ToolDefinition): Result<Tool, KoiError> {
  // Deep-snapshot all data fields to prevent TOCTOU via getter/proxy-backed
  // objects. Cycle detection and structuredClone are both inside the try/catch
  // so throwing getters on the original definition produce a Result error.
  let def: ToolDefinition;
  try {
    if (hasCycle(definition.inputSchema)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message:
            "Tool definition validation failed: inputSchema is not cloneable (cyclic or non-serializable)",
          retryable: false,
        },
      };
    }
    const { execute: _exec, ...data } = definition as unknown as Record<string, unknown>;
    const cloned = structuredClone(data);
    def = { ...cloned, execute: definition.execute } as unknown as ToolDefinition;
  } catch (e: unknown) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Tool definition validation failed: definition contains non-cloneable values",
        retryable: false,
        context: { cause: e instanceof Error ? e.message : String(e) },
      },
    };
  }

  // Capability overrides on unsandboxed tools are misleading — they look
  // restricted but won't actually be enforced without a sandbox.
  if (def.sandbox === false && (def.network !== undefined || def.filesystem !== undefined)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message:
          "Tool definition validation failed: network/filesystem overrides are not allowed when sandbox is disabled (capabilities are not enforced without a sandbox)",
        retryable: false,
      },
    };
  }

  let validation: Result<unknown, KoiError>;
  try {
    validation = validateWith(toolDefinitionSchema, def, "Tool definition validation failed");
  } catch (e: unknown) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Tool definition validation failed: schema too deeply nested or malformed",
        retryable: false,
        context: { cause: e instanceof Error ? e.message : String(e) },
      },
    };
  }
  if (!validation.ok) {
    return validation;
  }

  const policy = mapPolicy(def);

  const tool: Tool = {
    descriptor: {
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema, // already deep-cloned in snapshot
      ...(def.tags !== undefined ? { tags: def.tags } : {}),
      origin: def.origin,
    },
    origin: def.origin,
    policy,
    execute: def.execute,
  };

  deepFreeze(tool);
  return { ok: true, value: tool };
}
