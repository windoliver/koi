/**
 * Resolver contract — discovery of tools/skills/agents.
 */

import type { KoiError, Result } from "./errors.js";

// ---------------------------------------------------------------------------
// Source types — Level 3 progressive disclosure (full source code)
// ---------------------------------------------------------------------------

export type SourceLanguage = "typescript" | "javascript" | "markdown" | "yaml" | "json";

export interface SourceBundle {
  readonly content: string;
  readonly language: SourceLanguage;
  readonly files?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Resolver contract
// ---------------------------------------------------------------------------

export interface Resolver<TMeta, TFull> {
  readonly discover: () => Promise<readonly TMeta[]>;
  readonly load: (id: string) => Promise<Result<TFull, KoiError>>;
  readonly onChange?: (listener: () => void) => () => void;
  readonly source?: (id: string) => Promise<Result<SourceBundle, KoiError>>;
}
