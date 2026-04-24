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

const VALID_DECISIONS = new Set<string>(["allow", "deny", "ask"]);
const VALID_SEVERITIES = new Set<ViolationSeverity>(["info", "warning", "critical"]);
const VALID_FIXED_KINDS = new Set<string>([
  "tool_call",
  "model_call",
  "spawn",
  "delegation",
  "forge",
  "handoff",
]);
const VALID_RULE_KEYS = new Set<string>([
  "match",
  "decision",
  "rule",
  "severity",
  "message",
  "prompt",
]);
const VALID_MATCH_KEYS = new Set<string>(["kind", "toolId", "model"]);

function validateRule(entry: unknown, idx: number, path: string): PatternRule {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(
      `--policy-file: rule[${idx}] in '${path}' must be an object, got ${describeType(entry)}`,
    );
  }
  const record = entry as Record<string, unknown>;

  // Reject unknown top-level keys. A typo like `desicion:` would otherwise
  // be silently ignored, leaving `record.decision` undefined and failing
  // the decision check with a confusing "got undefined" message. Strict
  // key validation fails the load with a targeted error instead.
  const unknownRuleKeys = Object.keys(record).filter((k) => !VALID_RULE_KEYS.has(k));
  if (unknownRuleKeys.length > 0) {
    throw new Error(
      `--policy-file: rule[${idx}] in '${path}' has unknown key(s): ${unknownRuleKeys.join(", ")}. Allowed: ${[...VALID_RULE_KEYS].join(", ")}`,
    );
  }

  if (!("match" in record)) {
    throw new Error(`--policy-file: rule[${idx}] in '${path}' is missing required field 'match'`);
  }
  const match = validateMatch(record.match, idx, path);

  const decision = record.decision;
  if (typeof decision !== "string" || !VALID_DECISIONS.has(decision)) {
    throw new Error(
      `--policy-file: rule[${idx}] in '${path}' must have decision: 'allow' | 'deny' | 'ask', got ${describeValue(decision)}`,
    );
  }

  const rule: PatternRule = {
    match,
    decision: decision as "allow" | "deny" | "ask",
    ...(record.rule !== undefined ? { rule: requireString(record.rule, "rule", idx, path) } : {}),
    ...(record.severity !== undefined
      ? { severity: validateSeverity(record.severity, idx, path) }
      : {}),
    ...(record.message !== undefined
      ? { message: requireString(record.message, "message", idx, path) }
      : {}),
    ...(record.prompt !== undefined
      ? { prompt: requireString(record.prompt, "prompt", idx, path) }
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

  // Reject unknown selector keys. A typo like `toolID:` or `tool_id:` would
  // otherwise be silently discarded, producing an empty match object that
  // — combined with pattern-backend semantics — widens the rule to every
  // request of the rule's decision kind. This is a dangerous fail-open
  // mode for deny rules and a policy-inversion risk for allow rules.
  const unknownMatchKeys = Object.keys(record).filter((k) => !VALID_MATCH_KEYS.has(k));
  if (unknownMatchKeys.length > 0) {
    throw new Error(
      `--policy-file: rule[${idx}].match in '${path}' has unknown key(s): ${unknownMatchKeys.join(", ")}. Allowed: ${[...VALID_MATCH_KEYS].join(", ")}`,
    );
  }

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
