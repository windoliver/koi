/**
 * Loader + validator for the `--policy-file` flag added in gov-10.
 *
 * Accepts YAML (default) or JSON (`.json` extension). Top-level must be an
 * array of `PatternRule` objects matching the shape exported by
 * `@koi/governance-defaults`:
 *
 *   - match: { kind?, toolId?, model? }   # at least one selector recommended
 *     decision: allow | deny              # required
 *     rule?: string
 *     severity?: info | warning | critical
 *     message?: string
 *
 * Validation is strict and fail-fast so syntax errors surface at `koi start`
 * boot, not on the first tool call (per the gov-10 agent instructions).
 */

import type { PolicyRequestKind, ViolationSeverity } from "@koi/core/governance-backend";
import type { PatternRule } from "@koi/governance-defaults";

/**
 * Read + validate a governance policy file. Throws with a human-readable
 * message when the file is missing, unparseable, or contains a rule whose
 * shape does not match `PatternRule`. Never returns a partially-validated
 * list — all entries must be sound or the whole load fails.
 */
export async function loadPolicyFile(path: string): Promise<readonly PatternRule[]> {
  let content: string;
  try {
    content = await Bun.file(path).text();
  } catch (cause: unknown) {
    throw new Error(`--policy-file: cannot read '${path}'`, { cause });
  }

  const isJson = path.toLowerCase().endsWith(".json");
  let parsed: unknown;
  try {
    // Bun ships native YAML + JSON parsers. Using them avoids a dep on
    // `js-yaml` and keeps parsing identical to every other koi.yaml load.
    parsed = isJson ? JSON.parse(content) : Bun.YAML.parse(content);
  } catch (cause: unknown) {
    throw new Error(`--policy-file: failed to parse '${path}' as ${isJson ? "JSON" : "YAML"}`, {
      cause,
    });
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `--policy-file: top-level must be an array of rules, got ${describeType(parsed)} in '${path}'`,
    );
  }

  const out: PatternRule[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    out.push(validateRule(parsed[i], i, path));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validators (private)
// ---------------------------------------------------------------------------

const VALID_DECISIONS = new Set<string>(["allow", "deny"]);
const VALID_SEVERITIES = new Set<ViolationSeverity>(["info", "warning", "critical"]);
const VALID_FIXED_KINDS = new Set<string>([
  "tool_call",
  "model_call",
  "spawn",
  "delegation",
  "forge",
  "handoff",
]);

function validateRule(entry: unknown, idx: number, path: string): PatternRule {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(
      `--policy-file: rule[${idx}] in '${path}' must be an object, got ${describeType(entry)}`,
    );
  }
  const record = entry as Record<string, unknown>;

  if (!("match" in record)) {
    throw new Error(`--policy-file: rule[${idx}] in '${path}' is missing required field 'match'`);
  }
  const match = validateMatch(record.match, idx, path);

  const decision = record.decision;
  if (typeof decision !== "string" || !VALID_DECISIONS.has(decision)) {
    throw new Error(
      `--policy-file: rule[${idx}] in '${path}' must have decision: 'allow' | 'deny', got ${describeValue(decision)}`,
    );
  }

  const rule: PatternRule = {
    match,
    decision: decision as "allow" | "deny",
    ...(record.rule !== undefined ? { rule: requireString(record.rule, "rule", idx, path) } : {}),
    ...(record.severity !== undefined
      ? { severity: validateSeverity(record.severity, idx, path) }
      : {}),
    ...(record.message !== undefined
      ? { message: requireString(record.message, "message", idx, path) }
      : {}),
  };
  return rule;
}

function validateMatch(raw: unknown, idx: number, path: string): PatternRule["match"] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `--policy-file: rule[${idx}].match in '${path}' must be an object, got ${describeType(raw)}`,
    );
  }
  const record = raw as Record<string, unknown>;
  const out: { kind?: PolicyRequestKind; toolId?: string; model?: string } = {};

  if (record.kind !== undefined) {
    if (typeof record.kind !== "string") {
      throw new Error(
        `--policy-file: rule[${idx}].match.kind in '${path}' must be a string, got ${describeValue(record.kind)}`,
      );
    }
    if (!VALID_FIXED_KINDS.has(record.kind) && !record.kind.startsWith("custom:")) {
      throw new Error(
        `--policy-file: rule[${idx}].match.kind in '${path}' must be one of ${[...VALID_FIXED_KINDS].join(", ")} or 'custom:<string>', got '${record.kind}'`,
      );
    }
    out.kind = record.kind as PolicyRequestKind;
  }
  if (record.toolId !== undefined) {
    out.toolId = requireString(record.toolId, "match.toolId", idx, path);
  }
  if (record.model !== undefined) {
    out.model = requireString(record.model, "match.model", idx, path);
  }
  return out;
}

function validateSeverity(raw: unknown, idx: number, path: string): ViolationSeverity {
  if (typeof raw !== "string" || !VALID_SEVERITIES.has(raw as ViolationSeverity)) {
    throw new Error(
      `--policy-file: rule[${idx}].severity in '${path}' must be 'info' | 'warning' | 'critical', got ${describeValue(raw)}`,
    );
  }
  return raw as ViolationSeverity;
}

function requireString(raw: unknown, field: string, idx: number, path: string): string {
  if (typeof raw !== "string") {
    throw new Error(
      `--policy-file: rule[${idx}].${field} in '${path}' must be a string, got ${describeType(raw)}`,
    );
  }
  return raw;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `'${value}'`;
  return describeType(value);
}
