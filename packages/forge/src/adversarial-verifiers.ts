/**
 * Built-in adversarial ForgeVerifier implementations.
 *
 * Five categories of adversarial probes:
 * 1. Injection — malicious input strings (__proto__, SQL injection, path traversal)
 * 2. Resource exhaustion — deeply nested or very large inputs
 * 3. Exfiltration — checks that outputs don't leak sensitive data
 * 4. Content scanning — prompt injection, credential harvesting, tool poisoning
 * 5. Structural hiding — base64/hex obfuscation, Unicode confusables, hidden payloads
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
// Content scanning verifier (skills, agents — text-based adversarial probes)
// ---------------------------------------------------------------------------

interface ContentPattern {
  readonly category: string;
  readonly description: string;
  readonly regex: RegExp;
}

const CONTENT_PATTERNS: readonly ContentPattern[] = [
  // Prompt injection — attempts to override agent instructions
  {
    category: "prompt_injection",
    description: "Attempts to override system instructions",
    regex:
      /ignore\s+(all\s+)?(previous|prior|above|earlier|system)\s+(instructions?|prompts?|rules?|guidelines?)/i,
  },
  {
    category: "prompt_injection",
    description: "Attempts to redefine agent identity",
    regex: /you\s+are\s+now\s+(a|an|my)\s+/i,
  },
  {
    category: "prompt_injection",
    description: "Attempts to bypass safety measures",
    regex:
      /(override|bypass|disable|ignore)\s+(all\s+)?(safety|security|content)\s+(filters?|measures?|restrictions?|guardrails?|checks?)/i,
  },
  {
    category: "prompt_injection",
    description: "Known jailbreak technique reference",
    regex: /\b(jailbreak|DAN\s+mode|do\s+anything\s+now)\b/i,
  },
  {
    category: "prompt_injection",
    description: "Attempts to disregard training or rules",
    regex:
      /(disregard|forget|abandon)\s+(your|all|the)\s+(training|rules?|instructions?|guidelines?)/i,
  },
  // Credential harvesting — instructions to output secrets
  {
    category: "credential_harvesting",
    description: "Instructions to output sensitive data",
    regex:
      /(output|print|display|show|reveal|dump|list)\s+(all\s+)?(env(ironment)?\s*var(iable)?s|secrets?|credentials?|api[_\s-]?keys?|tokens?|passwords?)/i,
  },
  {
    category: "credential_harvesting",
    description: "Instructions to read sensitive files",
    regex:
      /(read|cat|open|access)\s+(the\s+)?(\.env|\.ssh|\.aws|\/etc\/shadow|\/etc\/passwd|credentials)/i,
  },
  // Destructive commands — instructions to run harmful operations
  {
    category: "destructive_command",
    description: "Destructive shell commands",
    regex: /\brm\s+-r?f\s+\//i,
  },
  {
    category: "destructive_command",
    description: "Remote code execution via piped download",
    regex: /(curl|wget)\s+\S+\s*\|\s*(sh|bash|zsh|python)/i,
  },
  // Data exfiltration — instructions to send data externally
  {
    category: "exfiltration",
    description: "Instructions to send data to external endpoints",
    regex:
      /send\s+(all\s+)?(data|info|information|content|secrets?|credentials?|files?)\s+to\s+https?:\/\//i,
  },
  {
    category: "exfiltration",
    description: "Encoded data exfiltration technique",
    regex: /\b(exfiltrate|base64\s+encode\s+.*\s+send)\b/i,
  },
  // Tool poisoning — instructions to modify other tools or system config
  {
    category: "tool_poisoning",
    description: "Instructions to modify other tools or skills",
    regex:
      /(modify|edit|change|overwrite|replace|rewrite)\s+(the\s+)?(other|existing|installed)\s+(tools?|skills?|bricks?|plugins?)/i,
  },
  {
    category: "tool_poisoning",
    description: "Instructions to alter agent identity or system files",
    regex:
      /(modify|edit|overwrite|replace|rewrite|append\s+to)\s+(the\s+)?(CLAUDE\.md|SOUL\.md|system\s*prompt|\.claude\/|agent\s*config)/i,
  },
  {
    category: "tool_poisoning",
    description: "Instructions to disable or remove security middleware",
    regex:
      /(disable|remove|delete|bypass|strip)\s+(the\s+)?(security|verification|governance|middleware|guard|verifier)s?/i,
  },
  {
    category: "tool_poisoning",
    description: "Instructions to alter tool behavior at runtime",
    regex:
      /(monkey[_\s-]?patch|prototype\s+override|intercept\s+(and\s+)?(modify|change)|hook\s+into\s+(other|existing))/i,
  },
  {
    category: "tool_poisoning",
    description: "Instructions to escalate trust or permissions",
    regex:
      /(escalate|elevate|promote\s+to)\s+(trust|permissions?|privileges?|access)\s+(to\s+)?(admin|root|global|promoted)/i,
  },
];

/**
 * Extracts scannable text content from a ForgeInput.
 * Returns undefined if the input kind has no text to scan
 * (tools and composites are handled by other verifiers).
 */
function extractScannableContent(input: ForgeInput): string | undefined {
  if (input.kind === "skill") {
    return input.body;
  }
  if (input.kind === "agent" && input.manifestYaml !== undefined) {
    return input.manifestYaml;
  }
  return undefined;
}

function createContentScanningVerifier(): ForgeVerifier {
  return {
    name: "adversarial:content_scanning",
    verify: async (input: ForgeInput, _context: ForgeContext): Promise<VerifierResult> => {
      const content = extractScannableContent(input);
      if (content === undefined) {
        return { passed: true, message: "Skipped: no scannable content" };
      }

      for (const pattern of CONTENT_PATTERNS) {
        if (pattern.regex.test(content)) {
          return {
            passed: false,
            message: `Content scanning failed [${pattern.category}]: ${pattern.description}`,
          };
        }
      }

      return { passed: true, message: "Content scanning passed" };
    },
  };
}

// ---------------------------------------------------------------------------
// Structural hiding verifier (obfuscation, Unicode tricks, encoded payloads)
// ---------------------------------------------------------------------------

/** Zero-width and invisible Unicode characters used to hide content. */
// biome-ignore lint/suspicious/noMisleadingCharacterClass: intentional detection of individual invisible chars, not emoji sequences
const INVISIBLE_UNICODE_PATTERN = /[\u200B\u200C\u200D\u2060\uFEFF\u00AD\u200E\u200F\u202A-\u202E]/;

/** Long base64 strings (40+ chars) that may encode hidden payloads — global flag for matchAll. */
const BASE64_BLOCK_PATTERN_GLOBAL = /[A-Za-z0-9+/]{40,}={0,2}/g;

/** Hex escape sequences (e.g., \x41\x42) — 4+ consecutive = suspicious. */
const HEX_ESCAPE_PATTERN = /(\\x[0-9a-fA-F]{2}){4,}/;

/** HTML/markdown comments that could hide instructions. */
const HIDDEN_COMMENT_PATTERN = /<!--[\s\S]*?-->/;

/** Reusable UTF-8 decoder — avoids allocation per tryDecodeBase64() call. */
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Attempts to decode a base64 string. Returns the decoded UTF-8 text,
 * or undefined if the string is not valid base64 or decodes to binary.
 */
function tryDecodeBase64(encoded: string): string | undefined {
  try {
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const text = UTF8_DECODER.decode(bytes);
    // Only return if it looks like readable text (>80% printable ASCII)
    const printable = text.split("").filter((c) => {
      const code = c.charCodeAt(0);
      return code >= 0x20 && code < 0x7f;
    }).length;
    return printable / text.length > 0.8 ? text : undefined;
  } catch {
    return undefined;
  }
}

function createStructuralHidingVerifier(): ForgeVerifier {
  return {
    name: "adversarial:structural_hiding",
    verify: async (input: ForgeInput, _context: ForgeContext): Promise<VerifierResult> => {
      const content = extractScannableContent(input);
      if (content === undefined) {
        return { passed: true, message: "Skipped: no scannable content" };
      }

      // Check for invisible Unicode characters
      if (INVISIBLE_UNICODE_PATTERN.test(content)) {
        return {
          passed: false,
          message:
            "Structural hiding detected [unicode]: Content contains invisible Unicode characters (zero-width, RTL override, etc.)",
        };
      }

      // Check for hex escape sequences
      if (HEX_ESCAPE_PATTERN.test(content)) {
        return {
          passed: false,
          message:
            "Structural hiding detected [hex_escape]: Content contains hex escape sequences that may hide payloads",
        };
      }

      // Check HTML/markdown comments for hidden instructions
      const commentMatch = HIDDEN_COMMENT_PATTERN.exec(content);
      if (commentMatch !== null) {
        const commentBody = commentMatch[0];
        // Scan comment content against content patterns
        for (const pattern of CONTENT_PATTERNS) {
          if (pattern.regex.test(commentBody)) {
            return {
              passed: false,
              message: `Structural hiding detected [hidden_comment]: HTML comment contains ${pattern.category} pattern`,
            };
          }
        }
      }

      // Decode-then-rescan: find base64 blocks and scan decoded content
      BASE64_BLOCK_PATTERN_GLOBAL.lastIndex = 0;
      const base64Matches = content.match(BASE64_BLOCK_PATTERN_GLOBAL);
      if (base64Matches !== null) {
        for (const match of base64Matches) {
          const decoded = tryDecodeBase64(match);
          if (decoded !== undefined) {
            for (const pattern of CONTENT_PATTERNS) {
              if (pattern.regex.test(decoded)) {
                return {
                  passed: false,
                  message: `Structural hiding detected [base64]: Decoded base64 contains ${pattern.category} pattern — "${decoded.slice(0, 50)}..."`,
                };
              }
            }
          }
        }
      }

      return { passed: true, message: "Structural hiding scan passed" };
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
    createContentScanningVerifier(),
    createStructuralHidingVerifier(),
  ];
}

export {
  createInjectionVerifier,
  createResourceExhaustionVerifier,
  createExfiltrationVerifier,
  createContentScanningVerifier,
  createStructuralHidingVerifier,
};
