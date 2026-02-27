/**
 * Diagnostic provider — vendor-neutral contract for code diagnostics.
 *
 * L0 interface: no LSP numeric codes, no vendor-specific concepts.
 * L2 adapters (e.g., @koi/lsp) map vendor formats to this interface.
 */

// ---------------------------------------------------------------------------
// Diagnostic severity (string union — no numeric LSP codes in L0)
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

// ---------------------------------------------------------------------------
// Diagnostic range (zero-based line/character offsets)
// ---------------------------------------------------------------------------

export interface DiagnosticRange {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}

// ---------------------------------------------------------------------------
// Diagnostic item — a single issue reported by a provider
// ---------------------------------------------------------------------------

export interface DiagnosticItem {
  readonly uri: string;
  readonly range: DiagnosticRange;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly source?: string;
  readonly code?: string | number;
}

// ---------------------------------------------------------------------------
// Diagnostic provider — pluggable source of diagnostics
// ---------------------------------------------------------------------------

export interface DiagnosticProvider {
  readonly name: string;
  readonly diagnose: (
    uri: string,
    content: string,
  ) => readonly DiagnosticItem[] | Promise<readonly DiagnosticItem[]>;
  readonly dispose?: () => void;
}
