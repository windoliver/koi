/**
 * Recursive AST-style fence scan over the operator's module graph.
 *
 * Per spec § "Class-A workload restriction": every operator-authored module
 * (entry plus its transitive non-stdlib imports) is scanned for references to
 * provider-mutable globals. A hit causes adapter `create()` to reject with
 * `INVALID_CONFIG` / subcode `RUNTIME_FENCE_VIOLATION` BEFORE deploy.
 *
 * The scan is defense-in-depth: the runtime fence installed by Worker B's
 * preamble (see `runtime-fence.ts`) is the primary enforcement. The static
 * scan catches the obvious cases at deploy time so operators see a clear
 * diagnostic instead of a runtime trap on first invoke.
 *
 * Implementation is a comment-and-string-stripped word-boundary match against
 * the L0 `RUNTIME_FENCE_TOP_LEVEL_IDENTIFIERS` catalogue. It is NOT a full
 * AST parse — `eval("fet" + "ch")` and similar dynamic forms slip through
 * the static scan and are caught only by the runtime fence. The L2 doc
 * carries this honest residual.
 */

import { RUNTIME_FENCE_TARGETS, RUNTIME_FENCE_TOP_LEVEL_IDENTIFIERS } from "@koi/core";

export interface FenceViolation {
  readonly modulePath: string;
  readonly target: string;
  readonly line: number;
}

export interface FenceScanInput {
  readonly entryPath: string;
  readonly modules: Readonly<Record<string, string>>;
}

const stripCommentsAndStrings = (source: string): string => {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i] as string;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += " ";
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\") i++;
        if (source[i] === "\n") out += "\n";
        i++;
      }
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
};

const findIdentifierLines = (cleanedSource: string, identifier: string): readonly number[] => {
  const lines = cleanedSource.split("\n");
  const re = new RegExp(`\\b${identifier.replace(/\./g, "\\.")}\\b`);
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i] as string)) hits.push(i + 1);
  }
  return hits;
};

/**
 * Walk every module in `input.modules` and return any references to
 * `RUNTIME_FENCE_TARGETS`. Returns an empty array when the graph is clean.
 *
 * Caller is responsible for assembling the module graph (via the bundler /
 * loader) and supplying it via `modules`. The scanner does not perform
 * resolution — it inspects whatever sources the caller supplies.
 */
export const scanModuleGraphForFenceViolations = (
  input: FenceScanInput,
): readonly FenceViolation[] => {
  const violations: FenceViolation[] = [];
  const seen = new Set<string>();
  const targets = [
    ...RUNTIME_FENCE_TOP_LEVEL_IDENTIFIERS,
    ...RUNTIME_FENCE_TARGETS.filter((t) => t.includes(".")),
  ];

  const visit = (modulePath: string): void => {
    if (seen.has(modulePath)) return;
    seen.add(modulePath);
    const source = input.modules[modulePath];
    if (typeof source !== "string") return;
    const cleaned = stripCommentsAndStrings(source);
    for (const target of targets) {
      const lines = findIdentifierLines(cleaned, target);
      for (const line of lines) {
        violations.push({ modulePath, target, line });
      }
    }
  };

  visit(input.entryPath);
  // Visit every other module the caller supplied — caller-bundled graph is authoritative.
  for (const path of Object.keys(input.modules)) {
    visit(path);
  }
  return violations;
};
