/**
 * attach_capability tool — dynamically attach a catalog capability to the agent.
 *
 * Permission-tiered by BrickKind:
 *   - tool + skill: auto-attach (low blast radius)
 *   - middleware + channel: require explicit permission
 *   - agent: require explicit permission
 *
 * Session-scoped — does not modify the manifest on disk.
 */

import type {
  Agent,
  BrickKind,
  CatalogEntry,
  CatalogReader,
  JsonObject,
  KoiError,
  Result,
  Tool,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AttachConfig {
  /** BrickKinds that are permitted for dynamic attachment. */
  readonly allowedKinds: readonly BrickKind[];
  /**
   * Callback to perform the actual attach operation.
   * Implementation depends on the runtime context (e.g., ComponentProvider).
   */
  readonly onAttach: (entry: CatalogEntry) => Promise<Result<void, KoiError>>;
}

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

interface AttachResponse {
  readonly ok: boolean;
  readonly message: string;
  readonly code?: string;
}

// ---------------------------------------------------------------------------
// Permission check
// ---------------------------------------------------------------------------

/** Kinds that auto-attach without explicit permission. */
const AUTO_ATTACH_KINDS: ReadonlySet<BrickKind> = new Set(["tool", "skill"]);

function isPermitted(kind: BrickKind, allowedKinds: readonly BrickKind[]): boolean {
  if (AUTO_ATTACH_KINDS.has(kind)) return true;
  return allowedKinds.includes(kind);
}

// ---------------------------------------------------------------------------
// Installed check
// ---------------------------------------------------------------------------

function isAlreadyInstalled(agent: Agent, entryName: string): boolean {
  const colonIndex = entryName.indexOf(":");
  const baseName = colonIndex >= 0 ? entryName.slice(colonIndex + 1) : entryName;
  const components = agent.components();
  for (const key of components.keys()) {
    if (key.endsWith(`:${baseName}`) || key === baseName) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createAttachCapabilityTool(
  reader: CatalogReader,
  agent: Agent,
  config: AttachConfig,
): Tool {
  return {
    descriptor: {
      name: "attach_capability",
      description:
        "Dynamically attach a capability from the catalog to this agent. " +
        "Tools and skills auto-attach. Middleware and channels require explicit permission. " +
        "Use search_catalog first to find the capability name.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              'The source-prefixed capability name from the catalog (e.g., "bundled:@koi/middleware-audit")',
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    trustTier: "sandbox",
    execute: async (args: JsonObject): Promise<unknown> => {
      const name = args.name;
      if (typeof name !== "string" || name.trim() === "") {
        return {
          ok: false,
          message: "name is required and must be a non-empty string",
          code: "VALIDATION",
        } satisfies AttachResponse;
      }

      // 1. Check if already installed (idempotent)
      if (isAlreadyInstalled(agent, name)) {
        return {
          ok: true,
          message: `${name} is already attached to this agent`,
        } satisfies AttachResponse;
      }

      // 2. Look up in catalog
      const lookupResult = await reader.get(name);
      if (!lookupResult.ok) {
        return {
          ok: false,
          message: `Capability not found in catalog: ${name}`,
          code: "NOT_FOUND",
        } satisfies AttachResponse;
      }

      const entry = lookupResult.value;

      // 3. Permission check
      if (!isPermitted(entry.kind, config.allowedKinds)) {
        return {
          ok: false,
          message:
            `Permission denied: ${entry.kind} capabilities require explicit permission. ` +
            `Allowed kinds: ${config.allowedKinds.join(", ")}`,
          code: "PERMISSION_DENIED",
        } satisfies AttachResponse;
      }

      // 4. Attach
      try {
        const attachResult = await config.onAttach(entry);
        if (!attachResult.ok) {
          return {
            ok: false,
            message: attachResult.error.message,
            code: attachResult.error.code,
          } satisfies AttachResponse;
        }
      } catch (e: unknown) {
        const cause = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          message: `Failed to attach ${name}: ${cause}`,
          code: "INTERNAL",
        } satisfies AttachResponse;
      }

      return {
        ok: true,
        message: `Successfully attached ${name} (${entry.kind}) to this agent`,
      } satisfies AttachResponse;
    },
  };
}
