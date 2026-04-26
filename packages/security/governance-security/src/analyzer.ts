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

function extractTextDefault(_toolId: string, input: JsonObject): string {
  const values: string[] = [];
  function walk(obj: unknown, depth: number): void {
    if (depth > 50) return;
    if (typeof obj === "string") {
      values.push(obj);
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
      const findings: RiskFinding[] = [];

      for (const rule of rules) {
        if (rule.pattern.test(text)) {
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
