# @koi/skill-scanner

**Layer:** L0u  
**Location:** `packages/security/skill-scanner`  
**Purpose:** AST-based malicious code scanner for SKILL.md files.

Scans JavaScript/TypeScript code blocks embedded in skill markdown and the raw markdown text for dangerous patterns. Used by `@koi/skills-runtime` to enforce the fail-closed security contract (block loading on HIGH+ findings by default).

## Public API

```typescript
import { createScanner } from "@koi/skill-scanner";
import type { Scanner, ScanReport, ScanFinding, ScannerConfig } from "@koi/skill-scanner";

const scanner = createScanner();                    // default config
const report: ScanReport = scanner.scanSkill(md);  // scan a SKILL.md string
const report2: ScanReport = scanner.scan(code);    // scan a raw TS/JS string
```

### `createScanner(config?: ScannerConfig): Scanner`

Factory. Creates a scanner instance with resolved config. Cheap to call; rules are filtered once at construction time.

### `Scanner`

```typescript
interface Scanner {
  readonly scan: (sourceText: string, filename?: string) => ScanReport;
  readonly scanSkill: (markdown: string) => ScanReport;
}
```

- `scan` — parses and scans a single TS/JS source string. `filename` defaults to `"input.ts"` and is used to infer the language parser.
- `scanSkill` — extracts all fenced code blocks from a markdown string and scans each one. Also runs text-based rules (prompt injection) on the full markdown. Line numbers in findings are adjusted to be relative to the original markdown.

### `ScanReport`

```typescript
interface ScanReport {
  readonly findings: readonly ScanFinding[];
  readonly durationMs: number;
  readonly parseErrors: number;
  readonly rulesApplied: number;
}
```

### `ScanFinding`

```typescript
interface ScanFinding {
  readonly rule: string;
  readonly severity: Severity;        // "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
  readonly confidence: number;        // 0.0–1.0
  readonly category: ScanCategory;
  readonly message: string;
  readonly location?: ScanLocation;
}
```

### `ScannerConfig`

```typescript
interface ScannerConfig {
  readonly enabledCategories?: readonly ScanCategory[];
  readonly severityThreshold?: Severity;       // default: "LOW" (all pass through)
  readonly confidenceThreshold?: number;       // default: 0.0
  readonly trustedDomains?: readonly string[]; // added to default allowlist
  readonly onFilteredFinding?: (finding: ScanFinding) => void;
}
```

## Rule Categories

| Category | Description | Severity range |
|----------|-------------|----------------|
| `DANGEROUS_API` | `eval`, `Function`, `child_process`, `vm`, dynamic `require`/`import` | CRITICAL–HIGH |
| `OBFUSCATION` | High escape density, string concat to build API names | CRITICAL–MEDIUM |
| `EXFILTRATION` | Network calls + env access, DNS exfil, encoding + network correlation | CRITICAL–LOW |
| `PROTOTYPE_POLLUTION` | Unsafe merge, bracket assignment with dynamic keys, unguarded `for..in` | HIGH–MEDIUM |
| `FILESYSTEM_ABUSE` | `fs.rm`, `fs.writeFile`, `fs.rename`, dynamic `import("fs")` | CRITICAL–LOW |
| `SSRF` | Requests to cloud metadata, RFC 1918, loopback; IP encoding bypass detection | CRITICAL–HIGH |
| `SECRETS` | AWS keys, GitHub tokens, Slack tokens, private keys, Anthropic/OpenAI keys | CRITICAL–MEDIUM |
| `PROMPT_INJECTION` | System override phrases, role hijacking, data extraction, zero-width chars | HIGH–MEDIUM |
| `FILESYSTEM_ABUSE` (prose) | Destructive shell commands in plain markdown prose: `rm -rf /`, fork bomb, `mkfs /dev/*`, `dd of=/dev/sd*`, `chmod -R 777 /` | HIGH |
| `EXFILTRATION` (prose) | Credential environment-variable references in prose: `$OPENROUTER_API_KEY`, `$ANTHROPIC_API_KEY`, `$ACCESS_TOKEN`, `${SECRET_KEY}`, etc. | HIGH |
| `UNPARSEABLE` | Code that fails to parse (partial AST still scanned) | HIGH |

## Usage Example

```typescript
import { createScanner } from "@koi/skill-scanner";

const scanner = createScanner({
  severityThreshold: "MEDIUM",      // only return MEDIUM and above
  confidenceThreshold: 0.5,
  trustedDomains: ["api.mycompany.com"],
  onFilteredFinding: (f) => console.debug("filtered:", f.rule),
});

const markdown = await Bun.file(".claude/skills/my-skill/SKILL.md").text();
const report = scanner.scanSkill(markdown);

if (report.findings.length > 0) {
  for (const f of report.findings) {
    console.warn(`[${f.severity}] ${f.rule}: ${f.message}`);
  }
}
```

## Dependencies

- `@koi/validation` (L0u) — severity comparison helpers
- `oxc-parser` (external) — AST parsing via the Rust-based OXC compiler (~10–100x faster than Babel)
