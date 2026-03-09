/**
 * run_skill_script — Executes a script bundled inside a forged skill artifact.
 *
 * Phase 3C: Skills can bundle scripts in their `files` field under `scripts/`.
 * This tool loads the skill, extracts the script, and executes it through the
 * injected SandboxExecutor with restrictive resource limits (no network,
 * capped memory, short timeout).
 */

import type { BrickId, ExecutionContext, ForgeStore, Result, SkillArtifact, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import type { ForgeError, SandboxExecutor } from "@koi/forge-types";
import { sandboxError, staticError } from "@koi/forge-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SCRIPT_TIMEOUT_MS = 10_000;
const MAX_SCRIPT_TIMEOUT_MS = 30_000;
const SCRIPTS_PREFIX = "scripts/";

/** Restrictive execution context — no network, tight resource limits. */
const SCRIPT_EXECUTION_CONTEXT: ExecutionContext = {
  networkAllowed: false,
  resourceLimits: {
    maxMemoryMb: 256,
    maxPids: 32,
  },
};

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface RunSkillScriptResult {
  readonly output: unknown;
  readonly durationMs: number;
  readonly scriptPath: string;
  readonly brickId: string;
}

// ---------------------------------------------------------------------------
// Dependencies — subset of ForgeDeps needed for this tool
// ---------------------------------------------------------------------------

export interface RunSkillScriptDeps {
  readonly store: ForgeStore;
  readonly executor: SandboxExecutor;
}

// ---------------------------------------------------------------------------
// Script path validation
// ---------------------------------------------------------------------------

function validateScriptPath(scriptPath: string): Result<string, ForgeError> {
  if (!scriptPath.startsWith(SCRIPTS_PREFIX)) {
    return {
      ok: false,
      error: staticError(
        "INVALID_SCHEMA",
        `Script path must start with "${SCRIPTS_PREFIX}", got: "${scriptPath}"`,
      ),
    };
  }
  if (scriptPath.includes("..")) {
    return {
      ok: false,
      error: staticError(
        "INVALID_SCHEMA",
        `Script path must not contain path traversal (".."), got: "${scriptPath}"`,
      ),
    };
  }
  return { ok: true, value: scriptPath };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function runSkillScriptHandler(
  input: unknown,
  deps: RunSkillScriptDeps,
): Promise<Result<RunSkillScriptResult, ForgeError>> {
  // 1. Validate input shape
  if (input === null || typeof input !== "object") {
    return { ok: false, error: staticError("MISSING_FIELD", "Input must be a non-null object") };
  }
  const raw = input as Record<string, unknown>;

  const brickIdStr = raw.brickId;
  if (typeof brickIdStr !== "string" || brickIdStr.length === 0) {
    return { ok: false, error: staticError("MISSING_FIELD", "Missing required field: brickId") };
  }

  const scriptPath = raw.scriptPath;
  if (typeof scriptPath !== "string" || scriptPath.length === 0) {
    return {
      ok: false,
      error: staticError("MISSING_FIELD", "Missing required field: scriptPath"),
    };
  }

  // 2. Validate script path
  const pathResult = validateScriptPath(scriptPath);
  if (!pathResult.ok) return pathResult;

  // 3. Clamp timeout
  const rawTimeout = typeof raw.timeoutMs === "number" ? raw.timeoutMs : DEFAULT_SCRIPT_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(1, rawTimeout), MAX_SCRIPT_TIMEOUT_MS);

  // 4. Load skill from store
  const loadResult = await deps.store.load(brickIdStr as BrickId);
  if (!loadResult.ok) {
    return {
      ok: false,
      error: {
        stage: "store",
        code: "LOAD_FAILED",
        message: `Failed to load brick: ${loadResult.error.message}`,
      },
    };
  }

  const brick = loadResult.value;

  // 5. Validate kind
  if (brick.kind !== "skill") {
    return {
      ok: false,
      error: staticError("INVALID_SCHEMA", `Brick ${brickIdStr} is a ${brick.kind}, not a skill`),
    };
  }

  const skill = brick as SkillArtifact;

  // 6. Extract script from files
  if (skill.files === undefined) {
    return {
      ok: false,
      error: staticError("MISSING_FIELD", "Skill has no files — no scripts available"),
    };
  }

  const scriptContent = skill.files[scriptPath];
  if (scriptContent === undefined) {
    const available = Object.keys(skill.files)
      .filter((k) => k.startsWith(SCRIPTS_PREFIX))
      .join(", ");
    return {
      ok: false,
      error: staticError(
        "MISSING_FIELD",
        `Script not found at path: "${scriptPath}". Available scripts: ${available || "(none)"}`,
      ),
    };
  }

  // 7. Execute via SandboxExecutor
  const execResult = await deps.executor.execute(
    scriptContent,
    raw.input ?? {},
    timeoutMs,
    SCRIPT_EXECUTION_CONTEXT,
  );

  // 8. Map result
  if (!execResult.ok) {
    return {
      ok: false,
      error: sandboxError(
        execResult.error.code,
        `Script execution failed: ${execResult.error.message}`,
        execResult.error.durationMs,
      ),
    };
  }

  return {
    ok: true,
    value: {
      output: execResult.value.output,
      durationMs: execResult.value.durationMs,
      scriptPath,
      brickId: brickIdStr,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createRunSkillScriptTool(deps: RunSkillScriptDeps): Tool {
  return {
    descriptor: {
      name: "run_skill_script",
      description:
        "Executes a script bundled inside a forged skill. Scripts are run in a sandboxed environment with no network access and restricted resources.",
      inputSchema: {
        type: "object",
        properties: {
          brickId: {
            type: "string",
            description: "Content-addressed ID of the skill brick",
          },
          scriptPath: {
            type: "string",
            description: 'Relative path within the skill\'s files (must start with "scripts/")',
          },
          input: {
            description: "Optional input arguments passed to the script",
          },
          timeoutMs: {
            type: "number",
            description: `Execution timeout in ms (default: ${String(DEFAULT_SCRIPT_TIMEOUT_MS)}, max: ${String(MAX_SCRIPT_TIMEOUT_MS)})`,
          },
        },
        required: ["brickId", "scriptPath"],
      },
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (input) => runSkillScriptHandler(input, deps),
  };
}
