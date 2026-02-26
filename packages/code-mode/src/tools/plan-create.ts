/**
 * code_plan_create tool — Validates steps and creates a reviewable plan.
 */

import type { FileEdit, FileSystemBackend, JsonObject, Tool, TrustTier } from "@koi/core";
import { generateUlid } from "@koi/hash";
import { parseArray } from "../parse-args.js";
import type { PlanStore } from "../plan-store.js";
import { generatePreview } from "../preview.js";
import type { CodePlanStep, ValidationIssue } from "../types.js";
import {
  computeHashes,
  DEFAULT_VALIDATION_CONFIG,
  type ValidationConfig,
  validateSteps,
} from "../validation.js";

export function createPlanCreateTool(
  backend: FileSystemBackend,
  store: PlanStore,
  prefix: string,
  trustTier: TrustTier,
  config: ValidationConfig = DEFAULT_VALIDATION_CONFIG,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_create`,
      description:
        "Create a code plan with file edits, creations, and deletions. Validates all steps and returns a preview. The plan must be applied with code_plan_apply.",
      inputSchema: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            description:
              "Array of steps: { kind: 'create' | 'edit' | 'delete', path, content?, edits?, description? }",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", description: "'create', 'edit', or 'delete'" },
                path: { type: "string", description: "File path" },
                content: { type: "string", description: "Full file content (for create)" },
                edits: {
                  type: "array",
                  description: "Array of { oldText, newText } (for edit)",
                  items: {
                    type: "object",
                    properties: {
                      oldText: { type: "string" },
                      newText: { type: "string" },
                    },
                    required: ["oldText", "newText"],
                  },
                },
                description: { type: "string", description: "Optional step description" },
              },
              required: ["kind", "path"],
            },
          },
        },
        required: ["steps"],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const stepsResult = parseArray(args, "steps");
      if (!stepsResult.ok) return stepsResult.err;

      // Parse raw steps into typed CodePlanStep
      const parseResult = parseSteps(stepsResult.value);
      if (!parseResult.ok) return { error: parseResult.error, code: "VALIDATION" };

      const steps = parseResult.value;

      // Check that backend supports delete if any delete steps are present
      const hasDeleteSteps = steps.some((s) => s.kind === "delete");
      if (hasDeleteSteps && backend.delete === undefined) {
        return {
          error: "Backend does not support file deletion",
          code: "VALIDATION",
        };
      }

      // Collect all file paths for reading
      const paths = collectPaths(steps);

      // Read files from backend
      const fileContents = await readFiles(backend, paths);

      // Validate
      const issues = validateSteps(steps, fileContents, config);
      const errors = issues.filter((i) => !isWarningIssue(i));
      const warnings = issues.filter(isWarningIssue).map((i) => i.message);

      if (errors.length > 0) {
        return {
          error: "Validation failed",
          code: "VALIDATION",
          issues: errors,
        };
      }

      // Compute hashes for staleness detection
      const hashes = computeHashes(steps, fileContents);

      // Create and store the plan
      const plan = {
        id: generateUlid(),
        steps,
        state: "pending" as const,
        createdAt: Date.now(),
        hashes,
        warnings,
        fileContents,
      };
      store.set(plan);

      return generatePreview(plan);
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function isWarningIssue(issue: ValidationIssue): boolean {
  return issue.kind === "FILE_SIZE_WARNING";
}

function collectPaths(steps: readonly CodePlanStep[]): readonly string[] {
  const paths = new Set<string>();
  for (const step of steps) {
    paths.add(step.path);
  }
  return [...paths];
}

async function readFiles(
  backend: FileSystemBackend,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const path of paths) {
    const result = await backend.read(path);
    if (result.ok) {
      contents.set(path, result.value.content);
    }
    // Missing files are not added — validation will catch FILE_NOT_FOUND
  }
  return contents;
}

type StepParseResult =
  | { readonly ok: true; readonly value: readonly CodePlanStep[] }
  | { readonly ok: false; readonly error: string };

function parseSteps(raw: readonly unknown[]): StepParseResult {
  if (raw.length === 0) {
    return { ok: false, error: "steps must not be empty" };
  }

  const steps: CodePlanStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as Record<string, unknown>;
    const kind = entry.kind;
    const path = entry.path;

    if (typeof path !== "string" || path.length === 0) {
      return { ok: false, error: `Step ${i}: path must be a non-empty string` };
    }

    if (kind === "create") {
      const content = entry.content;
      if (typeof content !== "string") {
        return { ok: false, error: `Step ${i}: create step requires content string` };
      }
      const step: CodePlanStep =
        typeof entry.description === "string"
          ? { kind: "create", path, content, description: entry.description }
          : { kind: "create", path, content };
      steps.push(step);
    } else if (kind === "edit") {
      const editsRaw = entry.edits;
      if (!Array.isArray(editsRaw) || editsRaw.length === 0) {
        return { ok: false, error: `Step ${i}: edit step requires non-empty edits array` };
      }
      const edits: FileEdit[] = [];
      for (const e of editsRaw) {
        const edit = e as Record<string, unknown>;
        if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
          return { ok: false, error: `Step ${i}: each edit requires oldText and newText strings` };
        }
        edits.push({ oldText: edit.oldText, newText: edit.newText });
      }
      const step: CodePlanStep =
        typeof entry.description === "string"
          ? { kind: "edit", path, edits, description: entry.description }
          : { kind: "edit", path, edits };
      steps.push(step);
    } else if (kind === "delete") {
      const step: CodePlanStep =
        typeof entry.description === "string"
          ? { kind: "delete", path, description: entry.description }
          : { kind: "delete", path };
      steps.push(step);
    } else {
      return {
        ok: false,
        error: `Step ${i}: kind must be 'create', 'edit', or 'delete', got '${String(kind)}'`,
      };
    }
  }
  return { ok: true, value: steps };
}
