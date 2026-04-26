import type { JsonObject, RiskAnalysis, RiskFinding, RiskLevel, SecurityAnalyzer } from "@koi/core";
import { RISK_LEVEL_ORDER } from "@koi/core";
import type { PatternRule } from "./patterns.js";
import { BUILTIN_RULES } from "./patterns.js";

export type { PatternRule } from "./patterns.js";
export { BUILTIN_RULES } from "./patterns.js";

export interface RulesAnalyzerConfig {
  readonly extractText?: (toolId: string, input: JsonObject) => string;
  readonly extraRules?: readonly PatternRule[];
}

const MAX_WALK_NODES = 10_000;
const MAX_EXTRACTED_CHARS = 100_000;

function normalizeForMatching(text: string): string {
  let out = text.normalize("NFKC").replace(/\$\{?IFS\}?/gi, " ");
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(out);
      if (decoded === out) break;
      out = decoded;
    } catch {
      break;
    }
  }
  return out;
}

function extractTextDefault(_toolId: string, input: JsonObject): string {
  const values: string[] = [];
  let nodes = 0;
  let chars = 0;

  function pushString(s: string): void {
    const remaining = MAX_EXTRACTED_CHARS - chars;
    if (remaining <= 0) return;
    const chunk = s.slice(0, remaining);
    values.push(chunk);
    chars += chunk.length;
  }

  function walk(obj: unknown, depth: number): void {
    if (depth > 50 || nodes++ >= MAX_WALK_NODES || chars >= MAX_EXTRACTED_CHARS) return;
    if (typeof obj === "string") {
      pushString(obj);
    } else if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth + 1);
    } else if (obj !== null && typeof obj === "object") {
      for (const val of Object.values(obj as Record<string, unknown>)) walk(val, depth + 1);
    }
  }
  walk(input, 0);
  return values.join(" ");
}

export function maxRiskLevel(levels: readonly RiskLevel[]): RiskLevel {
  if (levels.length === 0) return "low";
  return levels.reduce<RiskLevel>(
    (max, level) => (RISK_LEVEL_ORDER.indexOf(level) > RISK_LEVEL_ORDER.indexOf(max) ? level : max),
    "low",
  );
}

export function createRulesAnalyzer(config: RulesAnalyzerConfig = {}): SecurityAnalyzer {
  const rules = [...BUILTIN_RULES, ...(config.extraRules ?? [])];
  const extract = config.extractText ?? extractTextDefault;

  return {
    analyze(toolId, input): RiskAnalysis {
      const text = extract(toolId, input);
      const normalized = normalizeForMatching(text);
      const findings: RiskFinding[] = [];

      for (const rule of rules) {
        if (rule.pattern.test(text) || rule.pattern.test(normalized)) {
          findings.push({
            pattern: rule.pattern.source,
            description: rule.description,
            riskLevel: rule.riskLevel,
          });
        }
      }

      const level = maxRiskLevel(findings.map((f) => f.riskLevel));
      return {
        riskLevel: level,
        findings,
        rationale:
          findings.length === 0
            ? "No injection or dangerous command patterns detected."
            : `${findings.length} pattern(s) matched: ${findings.map((f) => f.description).join("; ")}`,
      };
    },
  };
}

export function createCompositeAnalyzer(analyzers: readonly SecurityAnalyzer[]): SecurityAnalyzer {
  if (analyzers.length === 0) {
    return {
      analyze(): RiskAnalysis {
        return { riskLevel: "low", findings: [], rationale: "No analyzers configured." };
      },
    };
  }

  return {
    async analyze(toolId, input, context): Promise<RiskAnalysis> {
      const results = await Promise.all(
        analyzers.map((a) => Promise.resolve(a.analyze(toolId, input, context))),
      );
      const allFindings = results.flatMap((r) => [...r.findings]);
      const level = maxRiskLevel(results.map((r) => r.riskLevel));
      return {
        riskLevel: level,
        findings: allFindings,
        rationale: results
          .map((r) => r.rationale)
          .filter(Boolean)
          .join(". "),
      };
    },
  };
}
