/**
 * LSP type subset — only the types used by @koi/lsp.
 *
 * Hand-rolled to avoid external LSP protocol dependencies.
 * All properties are readonly per Koi immutability rules.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface Location {
  readonly uri: string;
  readonly range: Range;
}

// ---------------------------------------------------------------------------
// Text document
// ---------------------------------------------------------------------------

export interface TextDocumentIdentifier {
  readonly uri: string;
}

export interface TextDocumentPositionParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly position: Position;
}

export interface TextDocumentItem {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

export interface MarkupContent {
  readonly kind: "plaintext" | "markdown";
  readonly value: string;
}

export interface HoverResult {
  readonly contents: MarkupContent | string;
  readonly range?: Range;
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

/** LSP SymbolKind — subset of values we care about. */
export type SymbolKind =
  | 1 // File
  | 2 // Module
  | 3 // Namespace
  | 4 // Package
  | 5 // Class
  | 6 // Method
  | 7 // Property
  | 8 // Field
  | 9 // Constructor
  | 10 // Enum
  | 11 // Interface
  | 12 // Function
  | 13 // Variable
  | 14 // Constant
  | 15 // String
  | 16 // Number
  | 17 // Boolean
  | 18 // Array
  | 19 // Object
  | 20 // Key
  | 21 // Null
  | 22 // EnumMember
  | 23 // Struct
  | 24 // Event
  | 25 // Operator
  | 26; // TypeParameter

export interface SymbolInfo {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly location: Location;
  readonly containerName?: string;
}

/** DocumentSymbol (tree-shaped, used when server returns hierarchical symbols). */
export interface DocumentSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly range: Range;
  readonly selectionRange: Range;
  readonly children?: readonly DocumentSymbol[];
}

// ---------------------------------------------------------------------------
// Server capabilities (subset)
// ---------------------------------------------------------------------------

export interface ServerCapabilities {
  readonly hoverProvider?: boolean | object;
  readonly definitionProvider?: boolean | object;
  readonly referencesProvider?: boolean | object;
  readonly documentSymbolProvider?: boolean | object;
  readonly workspaceSymbolProvider?: boolean | object;
  readonly textDocumentSync?:
    | number
    | {
        readonly openClose?: boolean;
        readonly change?: number;
      };
}

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

export interface InitializeParams {
  readonly processId: number | null;
  readonly rootUri: string | null;
  readonly capabilities: object;
  readonly clientInfo?: {
    readonly name: string;
    readonly version?: string;
  };
  readonly initializationOptions?: unknown;
}

export interface InitializeResult {
  readonly capabilities: ServerCapabilities;
  readonly serverInfo?: {
    readonly name: string;
    readonly version?: string;
  };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** LSP DiagnosticSeverity: 1 = Error, 2 = Warning, 3 = Information, 4 = Hint */
export type DiagnosticSeverity = 1 | 2 | 3 | 4;

/** LSP DiagnosticTag: 1 = Unnecessary, 2 = Deprecated */
export type DiagnosticTag = 1 | 2;

export interface Diagnostic {
  readonly range: Range;
  readonly severity?: DiagnosticSeverity;
  readonly code?: string | number;
  readonly source?: string;
  readonly message: string;
  readonly tags?: readonly DiagnosticTag[];
}

export interface PublishDiagnosticsParams {
  readonly uri: string;
  readonly diagnostics: readonly Diagnostic[];
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

export interface ReferenceContext {
  readonly includeDeclaration: boolean;
}

export interface ReferenceParams extends TextDocumentPositionParams {
  readonly context: ReferenceContext;
}
