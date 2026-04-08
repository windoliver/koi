/**
 * createSkillTool() — Factory that builds a SkillTool meta-tool.
 *
 * The model invokes `Skill(name, args?)` to load and execute skills on demand.
 * Skills are advertised in the tool description (budget-aware).
 * Dispatch modes: inline (default) returns body as tool_result; fork delegates
 * to SpawnFn when the skill declares an `agent` field in its metadata.
 */

import type { JsonObject, KoiError, Result, Tool, ToolExecuteOptions } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { z } from "zod";
import { formatSkillDescription } from "./format-description.js";
import { extractSpawnConfig, mapSkillToSpawnRequest } from "./map-spawn.js";
import { substituteVariables } from "./substitute.js";
import type { SkillToolConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOOL_NAME = "Skill";

const INPUT_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    skill: {
      type: "string",
      description: "The name of the skill to invoke",
    },
    args: {
      type: "string",
      description: "Optional arguments to pass to the skill",
    },
  },
  required: ["skill"],
};

const inputValidator = z.object({
  skill: z.string().min(1, "skill name must not be empty"),
  args: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Signal composition
// ---------------------------------------------------------------------------

/**
 * Composes factory-level and per-call abort signals.
 * Returns the combined signal, or the single available one.
 */
function composeSignals(
  factorySignal: AbortSignal,
  callSignal: AbortSignal | undefined,
): AbortSignal {
  if (callSignal === undefined) return factorySignal;
  return AbortSignal.any([factorySignal, callSignal]);
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function cancelledError(): { readonly ok: false; readonly error: KoiError } {
  return {
    ok: false,
    error: {
      code: "INTERNAL",
      message: "Skill execution cancelled — abort signal already fired",
      retryable: false,
      context: { reason: "aborted" },
    },
  };
}

function internalError(
  message: string,
  cause: unknown,
): { readonly ok: false; readonly error: KoiError } {
  return {
    ok: false,
    error: {
      code: "INTERNAL",
      message,
      retryable: false,
      context: { cause: cause instanceof Error ? cause.message : String(cause) },
    },
  };
}

// ---------------------------------------------------------------------------
// Tool description builder
// ---------------------------------------------------------------------------

function buildDescription(skillListing: string): string {
  const usage = [
    "Execute a skill by name. Skills provide specialized capabilities and domain knowledge.",
    "",
    'Examples: Skill({ skill: "commit" }), Skill({ skill: "review-pr", args: "123" })',
    "",
  ].join("\n");

  if (skillListing.length === 0) {
    return `${usage}No skills are currently available.`;
  }

  return `${usage}${skillListing}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a SkillTool — a meta-tool that the model invokes to load and
 * execute skills on demand.
 *
 * Calls `resolver.discover()` at creation time to build the tool description
 * with a budget-aware skill listing. The tool itself calls `resolver.load()`
 * lazily at invocation time.
 *
 * @returns Result containing the Tool on success, or a KoiError if discovery fails.
 */
export async function createSkillTool(config: SkillToolConfig): Promise<Result<Tool, KoiError>> {
  // Discover skills for the tool description
  const discoverResult = await config.resolver.discover();
  if (!discoverResult.ok) return discoverResult;

  // Filter to only skills executable under the current config.
  // Fork skills require spawnFn and valid spawn config to be executable.
  const allSkills = [...discoverResult.value.values()];
  const skills = allSkills.filter((skill) => {
    const spawnResult = extractSpawnConfig(skill);
    if (!spawnResult.ok && spawnResult.error.code === "NOT_FOUND") {
      return true; // Inline-only skill — always executable
    }
    if (!spawnResult.ok) {
      return false; // Spawn config validation failed — not executable
    }
    // Fork skill — only executable if spawnFn is configured
    return config.spawnFn !== undefined;
  });
  const skillListing = formatSkillDescription(skills);
  const description = buildDescription(skillListing);

  const tool: Tool = {
    descriptor: {
      name: TOOL_NAME,
      description,
      inputSchema: INPUT_SCHEMA,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,

    async execute(args: JsonObject, options?: ToolExecuteOptions): Promise<unknown> {
      // 1. Compose signals and check for pre-abort
      const signal = composeSignals(config.signal, options?.signal);
      if (signal.aborted) return cancelledError();

      // 2. Validate input
      const parsed = inputValidator.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Invalid Skill input: ${parsed.error.message}`,
            retryable: false,
            context: {},
          },
        };
      }
      const { skill: skillName, args: skillArgs } = parsed.data;

      // 3. Load skill on demand
      let loadResult: Result<
        {
          readonly name: string;
          readonly description: string;
          readonly source: string;
          readonly dirPath: string;
          readonly body: string;
          readonly tags?: readonly string[];
          readonly allowedTools?: readonly string[];
          readonly metadata?: Readonly<Record<string, string>>;
        },
        KoiError
      >;
      try {
        loadResult = await config.resolver.load(skillName);
      } catch (e: unknown) {
        return internalError(`Unexpected error loading skill "${skillName}"`, e);
      }

      if (!loadResult.ok) return loadResult;
      const skill = loadResult.value;

      // 4. Check abort after async load
      if (signal.aborted) return cancelledError();

      // 5. Determine execution mode — fail closed on validation errors
      const spawnResult = extractSpawnConfig(skill);

      if (spawnResult.ok) {
        // Skill wants fork mode — fail closed if spawnFn is not available
        if (config.spawnFn === undefined) {
          return {
            ok: false,
            error: {
              code: "VALIDATION",
              message: `Skill "${skillName}" requires fork execution but no spawnFn is configured. Wire a SpawnFn or change the skill to inline mode`,
              retryable: false,
              context: { skillName },
            },
          };
        } else {
          const request = mapSkillToSpawnRequest(skill, skillArgs, spawnResult.value, {
            signal,
            ...(config.sessionId !== undefined ? { sessionId: config.sessionId } : {}),
          });

          try {
            return await config.spawnFn(request);
          } catch (e: unknown) {
            return internalError(`Unexpected error spawning skill "${skillName}"`, e);
          }
        }
      } else if (spawnResult.error.code !== "NOT_FOUND") {
        // Spawn config extraction failed with a real error (e.g. VALIDATION).
        // Fail closed — do NOT fall back to inline execution, as this could
        // bypass intended isolation boundaries.
        return spawnResult;
      }

      // Inline mode: skill is inline-only (NOT_FOUND from extractSpawnConfig)
      // or fork mode is unavailable (no spawnFn)
      const body = substituteVariables(skill.body, {
        ...(skillArgs !== undefined ? { args: skillArgs } : {}),
        skillDir: skill.dirPath,
        ...(config.sessionId !== undefined ? { sessionId: config.sessionId } : {}),
      });

      return { ok: true, value: body };
    },
  };

  return { ok: true, value: tool };
}
