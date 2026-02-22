/**
 * Built-in adversarial ForgeVerifier implementations.
 *
 * Three categories of adversarial probes:
 * 1. Injection — malicious input strings (__proto__, SQL injection, path traversal)
 * 2. Resource exhaustion — deeply nested or very large inputs
 * 3. Exfiltration — checks that outputs don't leak sensitive data
 */

import type {
  ForgeContext,
  ForgeInput,
  ForgeVerifier,
  SandboxExecutor,
  VerifierResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INJECTION_PROBE_TIMEOUT_MS = 3_000;
const RESOURCE_EXHAUSTION_TIMEOUT_MS = 5_000;
const EXFILTRATION_PROBE_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Injection probe verifier
// ---------------------------------------------------------------------------

const INJECTION_PAYLOADS: readonly Record<string, unknown>[] = [
  { __proto__: { polluted: true } },
  { constructor: { prototype: { polluted: true } } },
  { key: "'; DROP TABLE users; --" },
  { key: "<script>alert(1)</script>" },
  { key: "{{7*7}}" },
  { path: "../../../etc/passwd" },
  { path: "..\\..\\..\\windows\\system32" },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional injection test payload
  { key: "${process.env.SECRET}" },
  { key: "() => { while(true) {} }" },
];

function createInjectionVerifier(executor: SandboxExecutor): ForgeVerifier {
  return {
    name: "adversarial:injection",
    verify: async (input: ForgeInput, _context: ForgeContext): Promise<VerifierResult> => {
      if (input.kind !== "tool") {
        return { passed: true, message: "Skipped: not a tool" };
      }

      for (const payload of INJECTION_PAYLOADS) {
        const result = await executor.execute(
          input.implementation,
          payload,
          INJECTION_PROBE_TIMEOUT_MS,
        );

        // A crash from injection is acceptable (defense in depth).
        // What we're checking is that the tool doesn't return polluted data.
        if (result.ok) {
          const output = result.value.output;
          if (hasProtoPollution(output)) {
            return {
              passed: false,
              message: `Injection probe detected prototype pollution with payload: ${JSON.stringify(payload)}`,
            };
          }
        }
      }

      return { passed: true, message: "All injection probes passed" };
    },
  };
}

function hasProtoPollution(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;

  // Handle arrays — check each element
  if (Array.isArray(value)) {
    return value.some((item) => hasProtoPollution(item));
  }

  const obj = value as Record<string, unknown>;
  if ("polluted" in obj && obj.polluted === true) return true;

  for (const key of Object.keys(obj)) {
    if (hasProtoPollution(obj[key])) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Resource exhaustion verifier
// ---------------------------------------------------------------------------

function buildDeeplyNested(depth: number): Record<string, unknown> {
  // Iterative to avoid stack overflow at depth 100+
  let current: Record<string, unknown> = { value: "leaf" };
  for (let i = 0; i < depth; i++) {
    current = { nested: current };
  }
  return current;
}

function buildWideObject(width: number): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: width }, (_, i) => [`key_${i}`, `value_${i}`]));
}

const EXHAUSTION_PAYLOADS: readonly {
  readonly name: string;
  readonly input: unknown;
}[] = [
  { name: "deeply-nested-100", input: buildDeeplyNested(100) },
  { name: "wide-object-1000", input: buildWideObject(1_000) },
  { name: "large-string", input: { data: "x".repeat(100_000) } },
  { name: "large-array", input: { items: Array.from({ length: 10_000 }, (_, i) => i) } },
];

function createResourceExhaustionVerifier(executor: SandboxExecutor): ForgeVerifier {
  return {
    name: "adversarial:resource_exhaustion",
    verify: async (input: ForgeInput, _context: ForgeContext): Promise<VerifierResult> => {
      if (input.kind !== "tool") {
        return { passed: true, message: "Skipped: not a tool" };
      }

      for (const payload of EXHAUSTION_PAYLOADS) {
        const result = await executor.execute(
          input.implementation,
          payload.input,
          RESOURCE_EXHAUSTION_TIMEOUT_MS,
        );

        // OOM or TIMEOUT from resource exhaustion probes → verifier rejects
        if (!result.ok) {
          if (result.error.code === "OOM" || result.error.code === "TIMEOUT") {
            return {
              passed: false,
              message: `Resource exhaustion: tool ${result.error.code} on "${payload.name}" probe`,
            };
          }
          // CRASH or PERMISSION errors are acceptable — the sandbox caught the issue
        }
      }

      return { passed: true, message: "All resource exhaustion probes passed" };
    },
  };
}

// ---------------------------------------------------------------------------
// Exfiltration verifier
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /process\.env/i,
  /PRIVATE.KEY/i,
  /BEGIN RSA/i,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/,
  /password\s*[:=]\s*\S+/i,
  /secret\s*[:=]\s*\S+/i,
  /api[_-]?key\s*[:=]\s*\S+/i,
];

const EXFILTRATION_INPUTS: readonly Record<string, unknown>[] = [
  { secret: "SUPER_SECRET_VALUE_12345", data: "normal" },
  { apiKey: "sk-test-1234567890", query: "hello" },
  { password: "hunter2", username: "admin" },
];

function createExfiltrationVerifier(executor: SandboxExecutor): ForgeVerifier {
  return {
    name: "adversarial:exfiltration",
    verify: async (input: ForgeInput, _context: ForgeContext): Promise<VerifierResult> => {
      if (input.kind !== "tool") {
        return { passed: true, message: "Skipped: not a tool" };
      }

      for (const testInput of EXFILTRATION_INPUTS) {
        const result = await executor.execute(
          input.implementation,
          testInput,
          EXFILTRATION_PROBE_TIMEOUT_MS,
        );

        if (result.ok) {
          const outputStr = JSON.stringify(result.value.output);

          // Check if the output contains known sensitive values from input
          const secretValue = testInput.secret ?? testInput.apiKey ?? testInput.password;
          if (typeof secretValue === "string" && outputStr.includes(secretValue)) {
            return {
              passed: false,
              message: `Exfiltration detected: output contains sensitive input value "${secretValue.slice(0, 10)}..."`,
            };
          }

          // Check for common sensitive patterns in output
          for (const pattern of SENSITIVE_PATTERNS) {
            if (pattern.test(outputStr)) {
              return {
                passed: false,
                message: `Exfiltration risk: output matches sensitive pattern ${pattern.source}`,
              };
            }
          }
        }
      }

      return { passed: true, message: "All exfiltration probes passed" };
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createAdversarialVerifiers(executor: SandboxExecutor): readonly ForgeVerifier[] {
  return [
    createInjectionVerifier(executor),
    createResourceExhaustionVerifier(executor),
    createExfiltrationVerifier(executor),
  ];
}

export { createInjectionVerifier, createResourceExhaustionVerifier, createExfiltrationVerifier };
