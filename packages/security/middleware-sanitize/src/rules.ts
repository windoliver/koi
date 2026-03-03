/**
 * Built-in rule presets for content sanitization.
 *
 * Patterns are sourced from @koi/skill-scanner prompt-injection rules
 * but adapted as SanitizeRule[] with appropriate actions.
 */

import type { RulePreset, SanitizeRule } from "./types.js";

// ---------------------------------------------------------------------------
// Prompt injection rules — block by default (HIGH severity)
// ---------------------------------------------------------------------------

export const PROMPT_INJECTION_RULES: readonly SanitizeRule[] = [
  {
    name: "system-override",
    pattern: /ignore\s+(?:all\s+)?previous\s+instructions/i,
    action: { kind: "block", reason: "Prompt injection: system override attempt" },
    severity: "HIGH",
  },
  {
    name: "forget-instructions",
    pattern: /forget\s+(?:all\s+)?(?:your\s+)?instructions/i,
    action: { kind: "block", reason: "Prompt injection: instruction erasure" },
    severity: "HIGH",
  },
  {
    name: "disregard-above",
    pattern: /disregard\s+(?:all\s+)?(?:the\s+)?above/i,
    action: { kind: "block", reason: "Prompt injection: context disregard" },
    severity: "HIGH",
  },
  {
    name: "override-prompt",
    pattern: /override\s+(?:system\s+)?prompt/i,
    action: { kind: "block", reason: "Prompt injection: prompt override" },
    severity: "HIGH",
  },
  {
    name: "new-instructions",
    pattern: /new\s+instructions?\s*:/i,
    action: { kind: "block", reason: "Prompt injection: new instruction injection" },
    severity: "HIGH",
  },
  {
    name: "role-reassignment",
    pattern: /you\s+are\s+now\s+(?:a|an|the)\s/i,
    action: { kind: "block", reason: "Prompt injection: role reassignment" },
    severity: "HIGH",
  },
  {
    name: "stop-being",
    pattern: /stop\s+being\s+(?:a|an|the)\s/i,
    action: { kind: "block", reason: "Prompt injection: identity override" },
    severity: "HIGH",
  },
  {
    name: "reset-context",
    pattern: /reset\s+your\s+(?:instructions|context|memory)/i,
    action: { kind: "block", reason: "Prompt injection: context reset" },
    severity: "HIGH",
  },
  {
    name: "role-hijacking",
    pattern: /pretend\s+(?:to\s+be|you\s+are)/i,
    action: { kind: "block", reason: "Prompt injection: role hijacking" },
    severity: "MEDIUM",
  },
  {
    name: "data-extraction",
    pattern: /repeat\s+(?:your|the)\s+(?:instructions|system\s+prompt|rules)/i,
    action: { kind: "block", reason: "Prompt injection: data extraction" },
    severity: "MEDIUM",
  },
  {
    name: "reveal-prompt",
    pattern: /reveal\s+(?:your|the)\s+(?:system\s+prompt|instructions|hidden)/i,
    action: { kind: "block", reason: "Prompt injection: prompt reveal" },
    severity: "MEDIUM",
  },
  {
    name: "delimiter-injection",
    pattern: /(?:^|\n)[-]{5,}\s*\n/,
    action: { kind: "flag", replacement: "\n", tag: "delimiter-injection" },
    severity: "MEDIUM",
  },
] as const;

// ---------------------------------------------------------------------------
// Control character rules — strip (MEDIUM severity)
// ---------------------------------------------------------------------------

export const CONTROL_CHAR_RULES: readonly SanitizeRule[] = [
  {
    name: "null-byte",
    pattern: /\0/,
    action: { kind: "strip", replacement: "" },
    severity: "HIGH",
  },
  {
    name: "ascii-control-chars",
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control char match
    pattern: /[\x01-\x08\x0B\x0C\x0E-\x1F]/,
    action: { kind: "strip", replacement: "" },
    severity: "MEDIUM",
  },
  {
    name: "bom",
    pattern: /\uFEFF/,
    action: { kind: "strip", replacement: "" },
    severity: "LOW",
  },
] as const;

// ---------------------------------------------------------------------------
// HTML tag rules — strip dangerous tags (MEDIUM severity)
// ---------------------------------------------------------------------------

export const HTML_TAG_RULES: readonly SanitizeRule[] = [
  {
    name: "script-tag",
    pattern: /<script[\s>]/i,
    action: { kind: "strip", replacement: "" },
    severity: "HIGH",
  },
  {
    name: "iframe-tag",
    pattern: /<iframe[\s>]/i,
    action: { kind: "strip", replacement: "" },
    severity: "HIGH",
  },
  {
    name: "object-tag",
    pattern: /<object[\s>]/i,
    action: { kind: "strip", replacement: "" },
    severity: "MEDIUM",
  },
  {
    name: "embed-tag",
    pattern: /<embed[\s>]/i,
    action: { kind: "strip", replacement: "" },
    severity: "MEDIUM",
  },
  {
    name: "form-tag",
    pattern: /<form[\s>]/i,
    action: { kind: "strip", replacement: "" },
    severity: "MEDIUM",
  },
  {
    name: "event-handler",
    pattern: /\son\w+\s*=/i,
    action: { kind: "strip", replacement: " " },
    severity: "HIGH",
  },
] as const;

// ---------------------------------------------------------------------------
// Zero-width character rules — strip (LOW severity)
// ---------------------------------------------------------------------------

export const ZERO_WIDTH_RULES: readonly SanitizeRule[] = [
  {
    name: "zero-width-space",
    pattern: /\u200B/,
    action: { kind: "strip", replacement: "" },
    severity: "LOW",
  },
  {
    name: "zero-width-non-joiner",
    pattern: /\u200C/,
    action: { kind: "strip", replacement: "" },
    severity: "LOW",
  },
  {
    name: "zero-width-joiner",
    pattern: /\u200D/,
    action: { kind: "strip", replacement: "" },
    severity: "LOW",
  },
] as const;

// ---------------------------------------------------------------------------
// All presets combined
// ---------------------------------------------------------------------------

export const DEFAULT_RULES: readonly SanitizeRule[] = [
  ...PROMPT_INJECTION_RULES,
  ...CONTROL_CHAR_RULES,
  ...HTML_TAG_RULES,
  ...ZERO_WIDTH_RULES,
] as const;

// ---------------------------------------------------------------------------
// Preset resolver
// ---------------------------------------------------------------------------

const PRESET_MAP: Readonly<Record<RulePreset, readonly SanitizeRule[]>> = {
  "prompt-injection": PROMPT_INJECTION_RULES,
  "control-chars": CONTROL_CHAR_RULES,
  "html-tags": HTML_TAG_RULES,
  "zero-width": ZERO_WIDTH_RULES,
} as const;

/** Resolve named presets to their constituent rules. */
export function resolvePresets(presets: readonly RulePreset[]): readonly SanitizeRule[] {
  return presets.flatMap((p) => PRESET_MAP[p]);
}
