/**
 * createArtifactToolProvider — ComponentProvider exposing the four basic
 * artifact tools (save / get / list / delete) backed by a real
 * `ArtifactStore` from `@koi/artifacts`.
 *
 * Plan 2 scope: a pragmatic single-session binding. Every tool call runs
 * as `bindSessionId`, which is picked by the L3 host at runtime wiring
 * time. Plan 6 (#1923) will add a proper per-agent scoping story (tool
 * ctx threading + session-from-turn) and probably move this provider
 * into its own L2 `@koi/artifact-tools` package.
 *
 * Tools returned:
 *   artifact_save   — save text content, return id + version + hash
 *   artifact_get    — fetch an artifact's text by id
 *   artifact_list   — list artifacts in the session (name/tag filters)
 *   artifact_delete — delete an artifact by id
 *
 * All `execute` functions return JSON-serialisable plain objects so the
 * values flow cleanly back through tool dispatch into the model.
 */

import type { ArtifactStore } from "@koi/artifacts";
import type { ComponentProvider, JsonObject, SessionId, Tool } from "@koi/core";
import { artifactId, COMPONENT_PRIORITY } from "@koi/core";
import { buildTool, createToolComponentProvider } from "@koi/tools-core";

export interface ArtifactToolProviderConfig {
  readonly store: ArtifactStore;
  /**
   * Session id to bind every tool call to. All saves/lists/deletes happen
   * as this session; every get carries this session as the reader ctx.
   * Plan 6 will replace this single-session mapping with a per-agent
   * session derived from the engine's turn context.
   */
  readonly sessionId: SessionId;
  /** ComponentProvider priority — defaults to ~BUNDLED. */
  readonly priority?: number;
}

function unwrapTool(r: ReturnType<typeof buildTool>): Tool {
  if (!r.ok) {
    throw new Error(`Failed to build artifact tool: ${r.error.message}`, { cause: r.error });
  }
  return r.value;
}

export function createArtifactToolProvider(config: ArtifactToolProviderConfig): ComponentProvider {
  const { store, sessionId } = config;

  const saveTool = unwrapTool(
    buildTool({
      name: "artifact_save",
      description:
        "Save UTF-8 text content to the artifact store. Returns the new artifact id, version, size, and contentHash.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Logical artifact name, e.g. 'report.md' or 'plan.txt'.",
          },
          content: { type: "string", description: "UTF-8 text content to save." },
          mimeType: {
            type: "string",
            description: "MIME type. Defaults to 'text/plain' when omitted.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional free-form tags for later filtering.",
          },
        },
        required: ["name", "content"],
      },
      origin: "primordial",
      execute: async (args: JsonObject): Promise<unknown> => {
        const tagsArg = args.tags;
        const tags =
          Array.isArray(tagsArg) && tagsArg.every((t) => typeof t === "string")
            ? (tagsArg as readonly string[])
            : undefined;
        const result = await store.saveArtifact({
          sessionId,
          name: String(args.name),
          data: new TextEncoder().encode(String(args.content)),
          mimeType:
            typeof args.mimeType === "string" && args.mimeType.length > 0
              ? args.mimeType
              : "text/plain",
          ...(tags !== undefined ? { tags } : {}),
        });
        if (!result.ok) return { ok: false, error: result.error };
        return {
          ok: true,
          id: result.value.id,
          name: result.value.name,
          version: result.value.version,
          size: result.value.size,
          contentHash: result.value.contentHash,
          createdAt: result.value.createdAt,
        };
      },
    }),
  );

  const getTool = unwrapTool(
    buildTool({
      name: "artifact_get",
      description: "Retrieve an artifact's UTF-8 text content by id.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Artifact id returned by artifact_save." },
        },
        required: ["id"],
      },
      origin: "primordial",
      execute: async (args: JsonObject): Promise<unknown> => {
        const result = await store.getArtifact(artifactId(String(args.id)), { sessionId });
        if (!result.ok) return { ok: false, error: result.error };
        return {
          ok: true,
          id: result.value.meta.id,
          name: result.value.meta.name,
          version: result.value.meta.version,
          size: result.value.meta.size,
          mimeType: result.value.meta.mimeType,
          content: new TextDecoder().decode(result.value.data),
        };
      },
    }),
  );

  const listTool = unwrapTool(
    buildTool({
      name: "artifact_list",
      description:
        "List artifacts visible to this session. Optional filters: name (exact match), tags (all must match), includeShared (default true — artifacts shared into this session are included).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          includeShared: { type: "boolean" },
        },
      },
      origin: "primordial",
      execute: async (args: JsonObject): Promise<unknown> => {
        const tagsArg = args.tags;
        const tagsFilter =
          Array.isArray(tagsArg) && tagsArg.every((t) => typeof t === "string")
            ? (tagsArg as readonly string[])
            : undefined;
        const items = await store.listArtifacts(
          {
            ...(typeof args.name === "string" ? { name: args.name } : {}),
            ...(tagsFilter !== undefined ? { tags: tagsFilter } : {}),
            ...(typeof args.includeShared === "boolean"
              ? { includeShared: args.includeShared }
              : {}),
          },
          { sessionId },
        );
        return {
          ok: true,
          count: items.length,
          items: items.map((a) => ({
            id: a.id,
            name: a.name,
            version: a.version,
            size: a.size,
            mimeType: a.mimeType,
            contentHash: a.contentHash,
            createdAt: a.createdAt,
            tags: a.tags,
          })),
        };
      },
    }),
  );

  const deleteTool = unwrapTool(
    buildTool({
      name: "artifact_delete",
      description: "Delete an artifact by id. Returns ok:true on success, or not_found.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      origin: "primordial",
      execute: async (args: JsonObject): Promise<unknown> => {
        const result = await store.deleteArtifact(artifactId(String(args.id)), { sessionId });
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true };
      },
    }),
  );

  return createToolComponentProvider({
    name: "artifact-tools",
    tools: [saveTool, getTool, listTool, deleteTool],
    priority: config.priority ?? COMPONENT_PRIORITY.BUNDLED,
  });
}
